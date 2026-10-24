"use client";

/*
 * 狼人杀的「门口」和「等候区」。
 *
 *   · 没进房：建一个房（4–18 个真人座位）或者用 6 位数字房号进房；
 *   · 进了房但没开局：看座位、邀请好友、房主点开始。
 *
 * 这里**没有昵称输入框**：头像和名字都是平台账号的（登录由平台外壳负责）。
 * 好友邀请走平台的 WS（`invite.send`），房号是我们自己的 6 位数字。
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  BookOpen,
  Copy,
  DoorOpen,
  Play,
  Plus,
  Ticket,
  UserPlus,
  Users,
  ClockCounterClockwise,
} from "@phosphor-icons/react";

import type { NetGame } from "@/hooks/useNetGame";
import { api, type Lobby as LobbyData } from "@/lib/net/platform";
import {
  SETUP_ROLES,
  checkCounts,
  defaultCounts,
  totalCount,
  wolfCount,
  type RoleCounts,
  type SetupRole,
} from "@/lib/role-setup";

const SEAT_CHOICES = Array.from({ length: 15 }, (_, i) => i + 4);

function Avatar({ src, name, size = 40 }: { src?: string; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (src && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        width={size}
        height={size}
        className="rounded-full object-cover border border-[var(--glass-border)]"
        style={{ width: size, height: size }}
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <div
      className="rounded-full flex items-center justify-center bg-[var(--glass-bg-strong)] border border-[var(--glass-border)] text-[var(--color-accent)] font-bold"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {[...name][0] || "?"}
    </div>
  );
}

interface FriendItem {
  id: string;
  name: string;
  avatar?: string;
  online: boolean;
  playing?: unknown;
}

function InviteDialog({
  open,
  onClose,
  net,
}: {
  open: boolean;
  onClose: () => void;
  net: NetGame;
}) {
  const [friends, setFriends] = useState<FriendItem[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setLoading(true);
    api<{ list: FriendItem[] }>("/friends")
      .then((data) => setFriends(data.list || []))
      .catch((err: Error) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  const send = () => {
    if (!selected.length) {
      toast.error("先选一个好友");
      return;
    }
    const ok = net.invite(selected);
    if (ok) {
      toast.success(`已邀请 ${selected.length} 位好友`);
      onClose();
    } else {
      toast.error("连接断开了，刷新页面再试");
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="wc-panel wc-panel--strong w-full max-w-md rounded-2xl p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-bold text-[var(--text-primary)]">邀请好友</h3>
          <button type="button" className="text-[var(--text-secondary)]" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="max-h-[50vh] space-y-2 overflow-y-auto">
          {loading && <p className="text-sm text-[var(--text-secondary)]">正在加载好友…</p>}
          {!loading && friends.length === 0 && (
            <p className="text-sm text-[var(--text-secondary)]">还没有好友。回到平台首页加几个好友再来。</p>
          )}
          {friends.map((friend) => {
            const checked = selected.includes(friend.id);
            return (
              <button
                key={friend.id}
                type="button"
                disabled={!friend.online}
                onClick={() =>
                  setSelected((prev) =>
                    prev.includes(friend.id) ? prev.filter((id) => id !== friend.id) : [...prev, friend.id],
                  )
                }
                className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${
                  checked
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-bg)]"
                    : "border-[var(--glass-border)] bg-[var(--glass-bg-weak)]"
                } ${friend.online ? "" : "opacity-40"}`}
              >
                <Avatar src={friend.avatar} name={friend.name} size={34} />
                <span className="flex-1 text-sm font-medium text-[var(--text-primary)]">{friend.name}</span>
                <span className="text-xs text-[var(--text-secondary)]">{friend.online ? "在线" : "离线"}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={send}
          className="mt-4 w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-bold text-white disabled:opacity-50"
          disabled={selected.length === 0}
        >
          <UserPlus size={18} className="mr-2 inline" />
          发送邀请
        </button>
      </div>
    </div>
  );
}

interface RecordItem {
  id: number;
  winner: string;
  roomCode: string;
  startedAt: number;
  endedAt: number;
  mySeat: number;
  myCharacter: string;
  alive: boolean;
  playersCount: number;
}

interface RecordDetail {
  record: {
    winner: string;
    roomCode: string;
    players: Array<{ seat: number; name: string; roleName?: string; role?: string; alive: boolean }>;
  };
}

function RecordsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [list, setList] = useState<RecordItem[]>([]);
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDetail(null);
    setLoading(true);
    api<{ list: RecordItem[] }>("/records")
      .then((data) => setList(data.list || []))
      .catch((err: Error) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="wc-panel wc-panel--strong w-full max-w-lg rounded-2xl p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-bold text-[var(--text-primary)]">
            {detail ? `复盘 · ${detail.record.roomCode}` : "我的战绩"}
          </h3>
          <button
            type="button"
            className="text-[var(--text-secondary)]"
            onClick={() => (detail ? setDetail(null) : onClose())}
          >
            {detail ? "返回" : "关闭"}
          </button>
        </div>

        {detail ? (
          <div className="space-y-2">
            <p className="text-sm text-[var(--text-secondary)]">
              {detail.record.winner === "wolf" ? "狼人阵营胜利" : "好人阵营胜利"}
            </p>
            {detail.record.players
              .slice()
              .sort((a, b) => a.seat - b.seat)
              .map((p) => (
                <div
                  key={p.seat}
                  className="flex items-center gap-3 rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg-weak)] px-3 py-2 text-sm"
                >
                  <span className="w-10 text-[var(--text-secondary)]">{p.seat + 1}号</span>
                  <span className="flex-1 font-medium text-[var(--text-primary)]">{p.name}</span>
                  <span className={p.alive ? "text-[var(--text-secondary)]" : "text-[var(--color-danger)]"}>
                    {p.roleName || p.role}
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">{p.alive ? "存活" : "出局"}</span>
                </div>
              ))}
          </div>
        ) : (
          <div className="max-h-[55vh] space-y-2 overflow-y-auto">
            {loading && <p className="text-sm text-[var(--text-secondary)]">正在加载…</p>}
            {!loading && list.length === 0 && (
              <p className="text-sm text-[var(--text-secondary)]">还没有打过。开一局就有了。</p>
            )}
            {list.map((item) => (
              <button
                key={item.id}
                type="button"
                className="flex w-full items-center gap-3 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg-weak)] p-3 text-left"
                onClick={() => {
                  api<RecordDetail>(`/records/${item.id}`)
                    .then((data) => setDetail(data))
                    .catch((err: Error) => toast.error(err.message));
                }}
              >
                <span
                  className={`text-sm font-bold ${
                    item.winner === "wolf" ? "text-[var(--color-danger)]" : "text-[var(--color-accent)]"
                  }`}
                >
                  {item.winner === "wolf" ? "狼胜" : "好人胜"}
                </span>
                <span className="flex-1 text-xs text-[var(--text-secondary)]">
                  {new Date(item.startedAt).toLocaleString()} · {item.playersCount} 人 · {item.myCharacter}
                </span>
                <span className="text-xs text-[var(--text-muted)]">{item.alive ? "存活" : "出局"}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function WaitingRoom({ net, lobby }: { net: NetGame; lobby: LobbyData }) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const isHost = lobby.hostId === net.me?.id;
  const full = lobby.players.length >= lobby.seats;
  const composition = SETUP_ROLES.filter((role) => (lobby.roles?.[role.key] || 0) > 0)
    .map((role) => `${lobby.roles?.[role.key]} ${role.label}`)
    .join(" · ");

  if (!net.me) return null;

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-3xl flex-col justify-center gap-5 p-4">
      <div className="wc-panel wc-panel--strong rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs text-[var(--text-secondary)]">房号（念给好友听）</p>
            <div className="flex items-center gap-3">
              <span data-testid="room-code" className="font-mono text-3xl font-bold tracking-[0.3em] text-[var(--color-accent)]">
                {lobby.code}
              </span>
              <button
                type="button"
                className="rounded-lg border border-[var(--glass-border)] p-2 text-[var(--text-secondary)]"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(lobby.code);
                    toast.success("房号已复制");
                  } catch {
                    toast.error("复制失败，手动记一下吧");
                  }
                }}
                title="复制房号"
              >
                <Copy size={18} />
              </button>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-xl border border-[var(--glass-border)] px-4 py-2 text-sm font-medium text-[var(--text-primary)]"
              onClick={() => setInviteOpen(true)}
              data-testid="invite-open"
            >
              <UserPlus size={16} className="mr-1 inline" />
              邀请好友
            </button>
            <button
              type="button"
              className="rounded-xl border border-[var(--glass-border)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)]"
              onClick={() => void net.leaveRoom()}
            >
              <DoorOpen size={16} className="mr-1 inline" />
              退房
            </button>
          </div>
        </div>
      </div>

      <div className="wc-panel rounded-2xl p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold text-[var(--text-primary)]">
            <Users size={18} className="mr-2 inline" />
            座位 {lobby.players.length}/{lobby.seats}
          </h2>
          {lobby.password && <span className="text-xs text-[var(--text-secondary)]">有密码</span>}
        </div>
        {composition && (
          <p data-testid="role-composition" className="mb-3 text-xs text-[var(--text-secondary)]">
            本局角色：{composition}
          </p>
        )}
        <p data-testid="sheriff-setting" className="mb-3 text-xs text-[var(--text-secondary)]">
          警长：{lobby.sheriff === false ? "本局无警长" : "本局有警长（第一天竞选，1.5 票）"}
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {Array.from({ length: lobby.seats }).map((_, index) => {
            const player = lobby.players.find((p) => p.seat === index);
            return (
              <div
                key={index}
                className={`flex items-center gap-2 rounded-xl border p-3 ${
                  player
                    ? "border-[var(--glass-border)] bg-[var(--glass-bg-weak)]"
                    : "border-dashed border-[var(--glass-border)] opacity-60"
                }`}
              >
                {player ? (
                  <>
                    <Avatar src={player.avatar} name={player.name} size={36} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                        {player.name}
                        {player.isHost && <span className="ml-1 text-xs text-[var(--color-accent)]">房主</span>}
                        {player.id === net.me?.id && (
                          <span className="ml-1 text-xs text-[var(--text-secondary)]">(你)</span>
                        )}
                      </p>
                      <p className="text-xs text-[var(--text-secondary)]">{index + 1}号座位</p>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-[var(--text-secondary)]">{index + 1}号 · 等待加入</p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <button
        type="button"
        disabled={!isHost || !full || net.busy}
        data-testid="start-game"
        onClick={() => void net.startGame()}
        className="w-full rounded-2xl bg-[var(--color-accent)] px-4 py-4 text-lg font-bold text-white shadow-lg disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Play size={20} className="mr-2 inline" weight="fill" />
        {isHost ? (full ? "发牌，开始" : `还差 ${lobby.seats - lobby.players.length} 人`) : "等房主开始"}
      </button>

      <p className="text-center text-xs text-[var(--text-secondary)]">
        4–18 个真人，没有电脑。开局后刷新/断线都能坐回原位，但**不能中途加入**。
      </p>

      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} net={net} />
    </div>
  );
}

function Entry({ net }: { net: NetGame }) {
  const [seats, setSeats] = useState(8);
  const [counts, setCounts] = useState<RoleCounts>(() => defaultCounts(8));
  const [createPassword, setCreatePassword] = useState("");
  const [sheriff, setSheriff] = useState(true);
  const [code, setCode] = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);

  const total = totalCount(counts);
  const wolves = wolfCount(counts);
  const setupError = checkCounts(seats, counts);

  const pickSeats = (n: number) => {
    setSeats(n);
    setCounts(defaultCounts(n));
  };

  const changeRole = (key: SetupRole, delta: number) => {
    setCounts((prev) => {
      const next = { ...prev, [key]: Math.max(0, Math.min(seats, prev[key] + delta)) };
      return next;
    });
  };

  const invite = net.incomingInvite;

  /*
   * 平台好友列表的「进入」会打开 `/werewolf/join?number=123456`。
   * 这里只认这一个参数：进过一次就把它从地址栏抹掉，免得刷新时重复入座。
   */
  const autoJoined = useRef(false);
  useEffect(() => {
    if (autoJoined.current || !net.connected) return;
    const params = new URLSearchParams(window.location.search);
    const number = (params.get("number") || params.get("code") || "").replace(/\D/g, "").slice(0, 6);
    if (number.length !== 6) return;
    autoJoined.current = true;
    setCode(number);
    window.history.replaceState(null, "", `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/`);
    void net.joinRoom(number);
  }, [net, net.connected]);

  const createRoom = () => {
    if (setupError) return;
    setCreateOpen(false);
    void net.createRoom(seats, createPassword, counts, sheriff);
  };

  const joinRoom = () => {
    if (code.length !== 6) return;
    setJoinOpen(false);
    void net.joinRoom(code, joinPassword);
  };

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-4xl flex-col justify-center gap-4 p-4">
      <div className="wc-panel wc-panel--strong rounded-2xl p-5">
        <div className="flex items-center gap-3">
          <Avatar src={net.me?.avatar} name={net.me?.name || "我"} size={48} />
          <div className="flex-1">
            <p data-testid="me-name" className="text-lg font-bold text-[var(--text-primary)]">{net.me?.name || "加载中…"}</p>
            <p className="text-xs text-[var(--text-secondary)]">
              账号来自平台，头像昵称都是同一个
              {!net.connected && <span className="ml-2 text-[var(--color-danger)]">连接断开，正在重连…</span>}
            </p>
          </div>
          <button
            type="button"
            className="rounded-xl border border-[var(--glass-border)] px-3 py-2 text-sm text-[var(--text-secondary)]"
            onClick={() => setRecordsOpen(true)}
          >
            <ClockCounterClockwise size={16} className="mr-1 inline" />
            战绩
          </button>
        </div>
      </div>

      {invite && (
        <div data-testid="invite-card" className="wc-panel rounded-2xl border-[var(--color-accent)] p-4">
          <p className="text-sm text-[var(--text-primary)]">
            <b>{invite.from.name}</b> 邀请你进狼人杀房间 <span className="font-mono">{invite.code}</span>
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              data-testid="invite-accept"
              className="rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-bold text-white"
              onClick={() => {
                net.dismissInvite();
                void net.joinRoom(invite.code);
              }}
            >
              接受，进房
            </button>
            <button
              type="button"
              className="rounded-xl border border-[var(--glass-border)] px-4 py-2 text-sm text-[var(--text-secondary)]"
              onClick={() => net.dismissInvite()}
            >
              先不了
            </button>
          </div>
        </div>
      )}

      <div data-testid="entry" className="grid gap-4 md:grid-cols-2">
        <button
          type="button"
          data-testid="open-create"
          onClick={() => setCreateOpen(true)}
          className="wc-panel group rounded-2xl p-6 text-left transition hover:border-[var(--color-accent)]"
        >
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-accent-bg)] text-[var(--color-accent)]">
            <Plus size={26} />
          </div>
          <h2 className="text-xl font-bold text-[var(--text-primary)]">创建房间</h2>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            选人数、配角色、决定要不要警长，再把 6 位房号发给好友。
          </p>
          <span className="mt-4 inline-flex items-center gap-1 text-sm font-bold text-[var(--color-accent)]">
            开始设置 <span aria-hidden>→</span>
          </span>
        </button>

        <button
          type="button"
          data-testid="open-join"
          onClick={() => setJoinOpen(true)}
          className="wc-panel group rounded-2xl p-6 text-left transition hover:border-[var(--color-accent)]"
        >
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--glass-bg-strong)] text-[var(--color-accent)]">
            <Ticket size={26} />
          </div>
          <h2 className="text-xl font-bold text-[var(--text-primary)]">加入游戏</h2>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            输入好友给你的 6 位房号；有密码就一起填，好友邀请可以直接进。
          </p>
          <span className="mt-4 inline-flex items-center gap-1 text-sm font-bold text-[var(--color-accent)]">
            输入房号 <span aria-hidden>→</span>
          </span>
        </button>
      </div>

      <button
        type="button"
        data-testid="open-rules"
        onClick={() => setRulesOpen(true)}
        className="wc-panel flex w-full items-center gap-3 rounded-2xl px-5 py-4 text-left transition hover:border-[var(--color-accent)]"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--glass-bg-strong)] text-[var(--color-accent)]">
          <BookOpen size={22} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-[var(--text-primary)]">规则介绍</span>
          <span className="block text-xs text-[var(--text-secondary)]">
            第一次玩？先看流程、胜负条件和 14 个角色的技能。
          </span>
        </span>
        <span className="shrink-0 text-sm font-bold text-[var(--color-accent)]">查看 →</span>
      </button>

      {createOpen && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-3"
          onClick={() => setCreateOpen(false)}
        >
          <div
            data-testid="create-modal"
            className="wc-panel wc-panel--strong max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-2xl p-5"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-[var(--text-primary)]">创建房间</h3>
                <p className="text-xs text-[var(--text-secondary)]">坐满才能发牌；角色总数必须正好等于座位数。</p>
              </div>
              <button type="button" className="p-2 text-[var(--text-secondary)]" onClick={() => setCreateOpen(false)}>
                关闭
              </button>
            </div>

            <p className="mb-2 text-xs text-[var(--text-secondary)]">几个真人玩？（4–18 人）</p>
            <div className="mb-4 flex flex-wrap gap-2">
              {SEAT_CHOICES.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => pickSeats(n)}
                  data-testid={`seat-${n}`}
                  className={`h-10 w-10 rounded-xl border text-sm font-bold ${
                    seats === n
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-bg)] text-[var(--color-accent)]"
                      : "border-[var(--glass-border)] text-[var(--text-secondary)]"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>

            <div data-testid="role-editor" className="mb-3 rounded-xl border border-[var(--glass-border)] p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-bold text-[var(--text-primary)]">本局角色（每种几个）</p>
                <span
                  data-testid="role-total"
                  className={`rounded-lg px-2 py-1 text-xs font-bold ${
                    setupError ? "bg-[var(--color-danger)]/15 text-[var(--color-danger)]" : "bg-[var(--color-success)]/15 text-[var(--color-success)]"
                  }`}
                >
                  已配 {total}/{seats} 人
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {SETUP_ROLES.map((role) => (
                  <div key={role.key} className="flex items-center gap-2 rounded-lg bg-[var(--glass-bg-weak)] px-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-[var(--text-primary)]">
                        {role.label}
                        {role.wolf && <span className="ml-1 text-[10px] text-[var(--color-danger)]">狼</span>}
                      </p>
                      <p className="truncate text-[10px] text-[var(--text-muted)]">{role.hint}</p>
                    </div>
                    <button
                      type="button"
                      aria-label={`减少${role.label}`}
                      data-testid={`role-dec-${role.key}`}
                      onClick={() => changeRole(role.key, -1)}
                      className="h-7 w-7 rounded-lg border border-[var(--glass-border)] text-base leading-none text-[var(--text-secondary)]"
                    >
                      −
                    </button>
                    <span data-testid={`role-count-${role.key}`} className="w-5 text-center text-sm font-bold text-[var(--text-primary)]">
                      {counts[role.key]}
                    </span>
                    <button
                      type="button"
                      aria-label={`增加${role.label}`}
                      data-testid={`role-inc-${role.key}`}
                      onClick={() => changeRole(role.key, 1)}
                      className="h-7 w-7 rounded-lg border border-[var(--glass-border)] text-base leading-none text-[var(--text-secondary)]"
                    >
                      +
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className={setupError ? "text-[var(--color-danger)]" : "text-[var(--text-secondary)]"}>
                  {setupError || `狼人阵营 ${wolves} 个，好人阵营 ${total - wolves} 个`}
                </span>
                <button
                  type="button"
                  data-testid="role-reset"
                  onClick={() => setCounts(defaultCounts(seats))}
                  className="rounded-lg border border-[var(--glass-border)] px-2 py-1 text-[var(--text-secondary)]"
                >
                  套用标准配置
                </button>
              </div>
            </div>

            <label className="mb-3 flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg-weak)] px-3 py-3">
              <span>
                <span className="block text-sm font-medium text-[var(--text-primary)]">本局有警长</span>
                <span className="block text-xs text-[var(--text-secondary)]">
                  关闭后第一天不竞选警长，也没有 1.5 票和警徽移交。
                </span>
              </span>
              <input
                type="checkbox"
                data-testid="sheriff-toggle"
                checked={sheriff}
                onChange={(event) => setSheriff(event.target.checked)}
                className="h-5 w-5 accent-[var(--color-accent)]"
              />
            </label>

            <input
              value={createPassword}
              onChange={(event) => setCreatePassword(event.target.value)}
              placeholder="房间密码（可留空；好友进房本来就不用密码）"
              className="mb-3 w-full rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg-weak)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none"
            />
            <button
              type="button"
              disabled={net.busy || Boolean(setupError)}
              data-testid="create-room"
              onClick={createRoom}
              className="w-full rounded-xl bg-[var(--color-accent)] px-4 py-3 font-bold text-white disabled:opacity-50"
            >
              {net.busy ? "正在开房…" : setupError ? setupError : `开一个 ${seats} 人房`}
            </button>
          </div>
        </div>
      )}

      {joinOpen && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-3"
          onClick={() => setJoinOpen(false)}
        >
          <div
            data-testid="join-modal"
            className="wc-panel wc-panel--strong w-full max-w-md rounded-2xl p-5"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-[var(--text-primary)]">加入游戏</h3>
                <p className="text-xs text-[var(--text-secondary)]">输入好友给你的 6 位房号。</p>
              </div>
              <button type="button" className="p-2 text-[var(--text-secondary)]" onClick={() => setJoinOpen(false)}>
                关闭
              </button>
            </div>
            <input
              data-testid="join-code"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              placeholder="例如 483920"
              className="mb-3 w-full rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg-weak)] px-3 py-3 text-center font-mono text-xl tracking-[0.4em] text-[var(--text-primary)] outline-none"
            />
            <input
              value={joinPassword}
              onChange={(event) => setJoinPassword(event.target.value)}
              placeholder="房间密码（好友邀请可留空）"
              className="mb-3 w-full rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg-weak)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none"
            />
            <button
              type="button"
              disabled={net.busy || code.length !== 6}
              data-testid="join-room"
              onClick={joinRoom}
              className="w-full rounded-xl border border-[var(--color-accent)] px-4 py-3 font-bold text-[var(--color-accent)] disabled:opacity-50"
            >
              {net.busy ? "正在进房…" : "进房"}
            </button>
          </div>
        </div>
      )}

      {rulesOpen && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-3"
          onClick={() => setRulesOpen(false)}
        >
          <div
            data-testid="rules-modal"
            className="wc-panel wc-panel--strong max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-2xl p-5"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-[var(--text-primary)]">狼人杀 · 规则介绍</h3>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  4–18 个真人，坐满发牌；房主可以在创建房间时自己配角色和警长。
                </p>
              </div>
              <button type="button" className="shrink-0 p-2 text-[var(--text-secondary)]" onClick={() => setRulesOpen(false)}>
                关闭
              </button>
            </div>

            <section className="mb-4 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg-weak)] p-4 text-sm leading-6 text-[var(--text-secondary)]">
              <h4 className="mb-2 font-bold text-[var(--text-primary)]">怎么玩</h4>
              <ol className="list-decimal space-y-1 pl-5">
                <li>天黑后按顺序行动：守卫 → 狼人 → 狼美人 → 女巫 → 预言家。</li>
                <li>天亮公布死讯；第一天先竞选警长（房主关掉警长就没有这一步）。</li>
                <li>白天依次发言，然后投票放逐；平票会进入 PK 发言再投一次。</li>
                <li>狼人杀光好人（存活狼人 ≥ 存活好人），或好人杀光所有狼，游戏结束。</li>
              </ol>
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h4 className="font-bold text-[var(--text-primary)]">14 个角色</h4>
                <span className="text-xs text-[var(--text-secondary)]">
                  红色是狼，蓝色是好人
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {SETUP_ROLES.map((role) => (
                  <div
                    key={role.key}
                    className={`rounded-xl border p-3 ${
                      role.wolf
                        ? "border-[var(--color-danger)]/25 bg-[var(--color-danger)]/5"
                        : "border-[var(--color-accent)]/20 bg-[var(--color-accent-bg)]/40"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-[var(--text-primary)]">{role.label}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          role.wolf
                            ? "bg-[var(--color-danger)]/15 text-[var(--color-danger)]"
                            : "bg-[var(--color-accent-bg)] text-[var(--color-accent)]"
                        }`}
                      >
                        {role.wolf ? "狼人阵营" : "好人阵营"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">{role.hint}</p>
                  </div>
                ))}
              </div>
            </section>

            <p className="mt-4 text-xs text-[var(--text-muted)]">
              具体判定以游戏里的系统提示为准；不确定的细节可以问房主。
            </p>
          </div>
        </div>
      )}

      <RecordsDialog open={recordsOpen} onClose={() => setRecordsOpen(false)} />
    </div>
  );
}

export function Lobby({ net }: { net: NetGame }) {
  const lobby = net.lobby;

  // 刚创建/刚进房：等待区
  if (net.room && net.room.phase === "waiting" && lobby) {
    return <WaitingRoom net={net} lobby={lobby} />;
  }

  return <Entry net={net} />;
}

