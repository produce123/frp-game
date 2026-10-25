/*
 * AI 小镇内置模型的可选真机测试（会真的拉起 llama-server，用 505MB GGUF 推理）。
 *
 * 默认跳过；显式打开：
 *   $env:AI_TOWN_REAL_MODEL='1'
 *   npm run test:ai-town-model
 *
 * 需要：本机模型、Vulkan 显卡、Chrome（tools/cdp.mjs）。测试会新建一个平台账号，
 * 开真镇、请三位村民、开始世界，等模型说出第一句，并检查服务端模型日志。
 * 它不替代 `npm run test:ai-town` 的 mock 接线测试；只是证明“模型在服务器跑、
 * 决策通过 WS 推给客户端”这条链路没有断。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const enabled = process.env.AI_TOWN_REAL_MODEL === '1'
const testRoot = enabled ? mkdtempSync(join(tmpdir(), 'frp-ai-model-test-')) : null
let app
let base
let page
let user
let passed = false

if (enabled) {
  const { startServer } = await import('../server/server.mjs')
  const { Page } = await import('../tools/cdp.mjs')
  app = await startServer({
    port: 0,
    dbPath: join(testRoot, 'test.db'),
    mahjongBackend: false,
  })
  base = app.url
  const response = await fetch(base + 'api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '模型验收', password: 'secret123' }),
  })
  if (response.status !== 200) assert.fail(await response.text())
  user = {
    cookie: response.headers.getSetCookie()[0].split(';')[0],
    me: (await response.json()).me,
  }
  page = await Page.launch({ headless: true, width: 1280, height: 800, startUrl: base })
  await page.conn.send('Network.enable')
  await page.conn.send('Network.setCookie', {
    name: 'sid',
    value: user.cookie.slice(4),
    url: base,
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  })
}

after(async () => {
  try {
    await page?.close()
  } catch {
    /* 页面可能已经关 */
  }
  await app?.close()
  if (testRoot) rmSync(testRoot, { recursive: true, force: true })
  if (enabled && user && passed) {
    const root = join('data', 'ai-town', 'users', user.me.id)
    // 只删本次新建的随机账号目录；模型共享文件在 data/ai-town/models，不动。
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* 目录可能已被清 */
    }
  }
})

test(
  '真实内置模型在服务器推理，并把村民决定推到客户端',
  { skip: enabled ? false : '设 AI_TOWN_REAL_MODEL=1 才跑真模型', timeout: 240_000 },
  async () => {
    const speech = []
    page.conn.on('Network.webSocketFrameReceived', (payload) => {
      try {
        const message = JSON.parse(payload.response.payloadData)
        if (message.type !== 'roster') return
        for (const locale of message.locales || []) {
          for (const member of locale.members || []) {
            if (member.kind !== 'resident' || !member.speech) continue
            speech.push(`${member.name}:${member.speech.text || member.speech.line || ''}`)
          }
        }
      } catch {
        /* 非 JSON 帧忽略 */
      }
    })

    await page.goto(base + 'ai-town/?map=default-town')
    await page.waitFor('return !document.querySelector("#enter-game")?.disabled', 30_000, '进入按钮')
    await page.evalRaw('document.querySelector("#enter-game").click()')
    await page.waitFor('return location.pathname.endsWith("game.html")', 30_000, '游戏页')
    await page.waitFor(
      'return [...document.querySelectorAll(".empty-town button")].some(b => b.textContent.includes("请他们"))',
      30_000,
      '空镇推荐按钮',
    )
    await page.evalRaw(
      `(()=>{const b=[...document.querySelectorAll('.empty-town button')].find(x=>x.textContent.includes('请他们')); if(!b)throw new Error('没有推荐按钮'); b.click()})()`,
    )
    await page.waitFor(
      'return !document.documentElement.hasAttribute("data-empty-town") && document.body.innerText.includes("村民 ·")',
      90_000,
      '三位村民入住',
    )
    await page.evalRaw(
      `(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='开始'); if(!b)throw new Error('没有开始按钮'); b.click()})()`,
    )
    await page.waitFor(
      'return [...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="暂停")',
      10_000,
      '世界开始',
    )

    const deadline = Date.now() + 150_000
    while (!speech.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    const townDir = join(
      process.env.AI_TOWN_DATA_DIR || 'data/ai-town',
      'users',
      user.me.id,
      'towns',
      'default-town',
    )
    let modelLog = ''
    try {
      modelLog = readFileSync(join(townDir, 'logs', 'builtin-model.log'), 'utf8')
    } catch {
      /* 留给断言报路径 */
    }
    assert.ok(
      speech.length > 0,
      `模型必须在 150 秒内让村民说出第一句；日志 ${join(townDir, 'logs')}\n${modelLog.slice(-1500)}`,
    );
    assert.deepEqual(page.errors, [], '浏览器不能有异常');

    assert.match(modelLog, /model loaded/);
    assert.match(modelLog, /listening on http:\/\/127\.0\.0\.1:/);
    const agentLogs = readdirSync(join(townDir, 'logs')).filter((name) =>
      name.startsWith('resident-agent-'),
    )
    assert.ok(agentLogs.length > 0, '村民决策要有 resident-agent 日志');
    const agentText = agentLogs
      .map((name) => readFileSync(join(townDir, 'logs', name), 'utf8'))
      .join('\n')
    assert.match(agentText, /"provider":"builtin"/);
    passed = true
  },
)