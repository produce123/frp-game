/*
 * AI 小镇的平台接线（Node 集成，真 manager / 真 host / 真 WebSocket）。
 *
 *   node --test tests/ai-town.test.mjs
 *
 * 只钉平台这一层最容易静默坏掉的地方：
 *   · 页面必须登录；`/games/ai-town/**` 源码不能漏；
 *   · 房间号是平台 6 位码，客人加入后 open 必须回到房主那份世界；
 *   · 浏览器拿到的 endpoint 是本平台地址，不能带 127.0.0.1:随机端口 / ?session=；
 *   · 布局按平台账号保存，乱写的坐标/尺寸会被夹住；
 *   · 重开存档不能出现访客幽灵，不同账号的存档不能串。
 *
 * 模型用 `--mock-llm`：这里测的是接线，不是推理；内置模型另外用
 * `AI_TOWN_REAL_MODEL=1 npm run test:ai-town-model` 跑真 llama-server。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

process.env.AI_TOWN_MOCK_LLM = '1';
// 测试的世界/模型/日志全放临时目录；不碰用户真实的 data/ai-town。
const testRoot = mkdtempSync(join(tmpdir(), 'frp-ai-town-test-'));
process.env.AI_TOWN_DATA_DIR = join(testRoot, 'data');

const { startServer } = await import('../server/server.mjs');
const { wsConnect } = await import('./ws-client.mjs');

let base;
let app;

async function register(name) {
  const response = await fetch(base + 'api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, password: 'secret123' }),
  });
  if (response.status !== 200) assert.fail(`注册失败：${await response.text()}`);
  const body = await response.json();
  const cookie = (response.headers.getSetCookie?.() || [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('sid='));
  assert.ok(cookie, '注册必须发 sid cookie');
  return { cookie, me: body.me };
}

before(async () => {
  app = await startServer({
    port: 0,
    dbPath: join(testRoot, 'test.db'),
    mahjongBackend: false,
  });
  base = app.url;
});

after(async () => {
  await app?.close();
  rmSync(testRoot, { recursive: true, force: true });
});

test('页面要登录；源码目录和桥脚本分开托管', async () => {
  const anon = await fetch(base + 'ai-town/', { redirect: 'manual' });
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get('location') || '', /return=%2Fai-town%2F/);

  const user = await register('看门');
  const page = await fetch(base + 'ai-town/', { headers: { cookie: user.cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /__FRP_ME__/);
  assert.match(html, /frp-bridge\.js/);
  assert.match(html, /\/ai-town\/assets\//);
  assert.equal(page.headers.get('cache-control'), 'no-store');

  const leak = await fetch(base + 'games/ai-town/upstream/Cargo.toml', { headers: { cookie: user.cookie } });
  assert.equal(leak.status, 404);
});

test('房主开镇 → 客人加入 → 两人连同一个 host；关镇保存', async () => {
  const host = await register('房主');
  const guest = await register('客人');

  const opened = await fetch(base + 'ai-town/api/towns/default-town/open', {
    method: 'POST',
    headers: { cookie: host.cookie, 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(120_000),
  });
  if (opened.status !== 200) assert.fail(await opened.text());
  const entry = await opened.json();
  const endpoint = new URL(entry.endpoint);
  assert.equal(endpoint.hostname, new URL(base).hostname, 'endpoint 必须是平台地址');
  assert.equal(endpoint.pathname, '/ai-town/ws');
  assert.match(endpoint.searchParams.get('room') || '', /^[A-Z2-9]{6}$/);
  assert.ok(endpoint.searchParams.get('sid'));
  assert.ok(!JSON.stringify(entry).includes('session='), '不能把上游 session 交给浏览器');

  const status = await fetch(base + 'ai-town/api/platform/status', { headers: { cookie: host.cookie } }).then((r) => r.json());
  assert.equal(status.room.owner, true);
  assert.equal(status.room.count, 1);

  const joined = await fetch(base + 'ai-town/api/platform/join', {
    method: 'POST',
    headers: { cookie: guest.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ room: status.room.id }),
  }).then((r) => r.json());
  assert.equal(joined.ok, true);
  assert.equal(joined.town, 'default-town');

  const guestOpen = await fetch(base + 'ai-town/api/towns/default-town/open', {
    method: 'POST',
    headers: { cookie: guest.cookie, 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(60_000),
  }).then((r) => r.json());
  assert.equal(new URL(guestOpen.endpoint).searchParams.get('room'), status.room.id, '客人 open 必须回到房主的房间');
  assert.equal(guestOpen.lease, undefined, '客人不能拿到房主的关镇凭据');
  assert.equal(guestOpen.mapHash, entry.mapHash, '两个人看到的必须是同一张地图');

  const hostWs = await wsConnect({ port: app.port, path: new URL(entry.endpoint).pathname + new URL(entry.endpoint).search, cookie: host.cookie });
  const worldIdentity = (m) => m.type === 'world_identity';
  const hostIdentity = await hostWs.waitFor(worldIdentity, 20_000);
  assert.equal(hostIdentity.town_id, 'default-town');
  const guestEndpoint = new URL(guestOpen.endpoint);
  const guestWs = await wsConnect({ port: app.port, path: guestEndpoint.pathname + guestEndpoint.search, cookie: guest.cookie });
  const guestIdentity = await guestWs.waitFor(worldIdentity, 20_000);
  assert.equal(guestIdentity.town_id, 'default-town');
  assert.equal(app.aiTown.rooms.roomForUser(host.me.id).members.size, 2);

  // 新镇必须自带世界观，房主的化身才能真的“降临”（否则所有命令都被拦）。
  hostWs.send({ type: 'get_population' });
  const population = await hostWs.waitFor((m) => m.type === 'population', 10_000);
  hostWs.send({
    type: 'avatar',
    world_id: population.population.world_id,
    request_id: 'enter-1',
    epoch: '',
    sequence: 0,
    command: { kind: 'enter', name: host.me.name, appearance: { marker: 'A', color: '#c8a06a' } },
  });
  const entered = await hostWs.waitFor((m) => m.type === 'avatar_result', 10_000);
  assert.equal(entered.ok, true, entered.message);
  assert.equal(entered.state.controlled, true);
  assert.equal(entered.state.actor.id, 'player_avatar');

  // 客人也是自己化身的上帝：同一张地图上另起一个 guest actor，房主看得见它的平台头像/名字。
  guestWs.send({ type: 'get_population' });
  const guestPopulation = await guestWs.waitFor((m) => m.type === 'population', 10_000);
  guestWs.send({
    type: 'avatar',
    world_id: guestPopulation.population.world_id,
    request_id: 'guest-enter-1',
    epoch: '',
    sequence: 0,
    command: { kind: 'enter', name: guest.me.name, appearance: { marker: 'B', color: '#55aaff' } },
  });
  const guestEntered = await guestWs.waitFor((m) => m.type === 'avatar_result', 10_000);
  assert.equal(guestEntered.ok, true, guestEntered.message);
  assert.equal(guestEntered.state.controlled, true);
  assert.match(guestEntered.state.actor.id, /^guest:/);
  assert.notEqual(guestEntered.state.actor.id, 'player_avatar');

  const roster = await hostWs.waitFor(
    (m) => m.type === 'roster' && m.locales.some((l) => l.members.some((x) => x.id.startsWith('guest:'))),
    10_000,
  );
  const avatars = roster.locales.flatMap((l) => l.members).filter((m) => m.kind === 'avatar');
  assert.ok(avatars.some((m) => m.id === 'player_avatar'));
  const guestMember = avatars.find((m) => m.id.startsWith('guest:'));
  assert.ok(guestMember);
  assert.equal(guestMember.name, guest.me.name, '头顶必须是平台账号名');
  assert.match(guestMember.avatar_url || '', /^\/avatar\//, '头顶必须带平台头像');
  assert.notDeepEqual(guestMember.at, avatars.find((m) => m.id === 'player_avatar')?.at, '两个人不能重叠在同一格');

  // 世界设置只能房主改；客人发 set_speed 被明确挡下。
  guestWs.send({ type: 'set_speed', request_id: 'guest-speed', speed: 1 });
  const guestDenied = await guestWs.waitFor(
    (m) => m.type === 'error' && /访客只能控制自己的化身/.test(m.message || ''),
    5_000,
  );
  assert.match(guestDenied.message, /世界设置由房主管理/);

  hostWs.close();
  guestWs.close();
  await new Promise((r) => setTimeout(r, 200));

  const closed = await fetch(base + 'ai-town/api/towns/default-town/close', {
    method: 'POST',
    headers: { cookie: host.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ lease: entry.lease }),
  }).then((r) => r.json());
  assert.equal(closed.ok, true);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(app.aiTown.rooms.roomForUser(host.me.id), null);

  // 重开存档：客人是临时的，不能变成“幽灵居民”，也不能把名字写进房主日志。
  const reopened = await fetch(base + 'ai-town/api/towns/default-town/open', {
    method: 'POST',
    headers: { cookie: host.cookie, 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(120_000),
  }).then((r) => r.json());
  const reopenEndpoint = new URL(reopened.endpoint);
  const reopenWs = await wsConnect({
    port: app.port,
    path: reopenEndpoint.pathname + reopenEndpoint.search,
    cookie: host.cookie,
  });
  const reopenRoster = await reopenWs.waitFor(
    (m) => m.type === 'roster',
    15_000,
  );
  const reopenAvatars = reopenRoster.locales.flatMap((l) => l.members).filter((m) => m.kind === 'avatar');
  assert.ok(!reopenAvatars.some((m) => m.id.startsWith('guest:')), '客人化身不能留在存档里');
  reopenWs.close();
  await new Promise((r) => setTimeout(r, 200));

  const worldFile = join(
    process.env.AI_TOWN_DATA_DIR,
    'users',
    host.me.id,
    'towns/default-town/world.json',
  );
  assert.ok(existsSync(worldFile));
  const savedWorld = readFileSync(worldFile, 'utf8');
  assert.ok(!savedWorld.includes('guest:'), '存档不能有客人 actor');
  assert.ok(!savedWorld.includes(guest.me.name), '存档不能有客人名字/日志');

  await fetch(base + 'ai-town/api/towns/default-town/close', {
    method: 'POST',
    headers: { cookie: host.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ lease: reopened.lease }),
  });
});

test('不同账号的存档目录互不串', async () => {
  const first = await register('存档甲');
  const second = await register('存档乙');

  async function openEnterAndClose(user) {
    const opened = await fetch(base + 'ai-town/api/towns/default-town/open', {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(120_000),
    });
    if (opened.status !== 200) assert.fail(await opened.text());
    const entry = await opened.json();
    const endpoint = new URL(entry.endpoint);
    const ws = await wsConnect({
      port: app.port,
      path: endpoint.pathname + endpoint.search,
      cookie: user.cookie,
    });
    ws.send({ type: 'get_population' });
    const population = await ws.waitFor((m) => m.type === 'population', 10_000);
    ws.send({
      type: 'avatar',
      world_id: population.population.world_id,
      request_id: 'enter-' + user.me.id,
      epoch: '',
      sequence: 0,
      command: {
        kind: 'enter',
        name: user.me.name,
        appearance: { marker: user.me.name.slice(0, 1), color: '#c8a06a' },
      },
    });
    const entered = await ws.waitFor((m) => m.type === 'avatar_result', 10_000);
    assert.equal(entered.ok, true, entered.message);
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    const closed = await fetch(base + 'ai-town/api/towns/default-town/close', {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ lease: entry.lease }),
    }).then((r) => r.json());
    assert.equal(closed.ok, true);
  }

  await openEnterAndClose(first);
  await openEnterAndClose(second);

  const readWorld = (user) =>
    readFileSync(
      join(process.env.AI_TOWN_DATA_DIR, 'users', user.me.id, 'towns/default-town/world.json'),
      'utf8',
    );
  const firstWorld = readWorld(first);
  const secondWorld = readWorld(second);
  assert.ok(firstWorld.includes(first.me.name));
  assert.ok(secondWorld.includes(second.me.name));
  assert.ok(!firstWorld.includes(second.me.name), '甲的存档不能出现乙的名字');
  assert.ok(!secondWorld.includes(first.me.name), '乙的存档不能出现甲的名字');
});

test('手机布局按账号保存，越界值被服务端夹住', async () => {
  const user = await register('布局');
  const initial = await fetch(base + 'ai-town/api/platform/layout', { headers: { cookie: user.cookie } }).then((r) => r.json());
  assert.equal(initial.layout, null);

  const bad = {
    v: 1,
    controls: {
      stick: { x: -5, y: 9, size: 999 },
      act: { x: 0.5, y: 0.5, size: 1 },
      bag: { x: 0.8, y: 0.9, size: 60 },
      cycle: { x: 0.8, y: 0.7, size: 60 },
    },
  };
  const saved = await fetch(base + 'ai-town/api/platform/layout', {
    method: 'POST',
    headers: { cookie: user.cookie, 'content-type': 'application/json' },
    body: JSON.stringify(bad),
  }).then((r) => r.json());
  assert.equal(saved.ok, true);

  const after = await fetch(base + 'ai-town/api/platform/layout', { headers: { cookie: user.cookie } }).then((r) => r.json());
  assert.equal(after.layout.controls.stick.x, 0);
  assert.equal(after.layout.controls.stick.y, 1);
  assert.equal(after.layout.controls.stick.size, 160);
  assert.equal(after.layout.controls.act.size, 44);

  const broken = await fetch(base + 'ai-town/api/platform/layout', {
    method: 'POST',
    headers: { cookie: user.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 2, controls: {} }),
  });
  assert.equal(broken.status, 400);
});