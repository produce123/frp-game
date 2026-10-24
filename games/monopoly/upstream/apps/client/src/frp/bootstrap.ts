/*
 * frp-game 平台桥接层（不是上游的界面代码）。
 *
 * 只做四件事，全部是"平台外壳"的职责：
 *   1. 把服务端注入的 `window.__FRP_ME__` 变成上游认识的 localStorage.user（账号绑定）；
 *   2. 房间状态变了就向平台报一次（好友列表里的"正在玩 大富翁"）；
 *   3. `?join=房号`（好友点「进入」）自动进房，而且**不把不存在的房号变成新房**；
 *   4. 房间页右上角「邀请好友」弹窗（读平台好友、发平台邀请）。
 *
 * 不碰棋盘、房间布局、规则。上游界面保持原样。
 */

import { watch } from "vue";
import { FPMessage } from "@mine-monopoly/ui";
import { useRoomInfo } from "@src/store";

type FrpMe = { id: string; name: string; avatar?: string; color?: string };

declare global {
	interface Window {
		__FRP_ME__?: FrpMe;
	}
}

const PRESENCE_INTERVAL_MS = 15_000;

export function frpMe(): FrpMe | null {
	return typeof window !== "undefined" ? window.__FRP_ME__ || null : null;
}

export function isFrpHosted(): boolean {
	return Boolean(frpMe()?.id);
}

/** 简单稳定配色：id 哈希到 8 个色相，保证同一个账号每次颜色一致。 */
function colorFor(id: string): string {
	let hash = 0;
	for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
	const palette = [
		"#ef476f", "#f78c6b", "#ffd166", "#06d6a0",
		"#118ab2", "#7b61ff", "#c77dff", "#4cc9f0",
	];
	return palette[hash % palette.length];
}

/**
 * 在 Vue/Pinia 启动之前调用：把平台身份写进上游的游客格式。
 *
 * 上游 `useUserInfo` 从 localStorage.user 读 `{ userId, useraccount, username, avatar, color }`，
 * 游客登录也是这么存的。所以我们不伪造平台 cookie，也不改上游 store，只把身份"翻译"过去。
 * 同时清掉上游自己的 token —— 否则它的 axios 401 刷新逻辑会尝试连不存在的 /user/refresh-token。
 */
export function applyPlatformIdentity(): boolean {
	const me = frpMe();
	if (!me?.id) return false;

	const userId = String(me.id);
	const user = {
		userId,
		useraccount: "",
		username: me.name || "玩家",
		avatar: me.avatar || `/avatar/${encodeURIComponent(userId)}`,
		color: me.color || colorFor(userId),
	};
	localStorage.setItem("user", JSON.stringify(user));
	localStorage.removeItem("token");
	localStorage.removeItem("refreshToken");
	return true;
}

let started = false;
let presenceTimer: ReturnType<typeof setInterval> | null = null;

/** 在 app.mount 之后调用（此时 Pinia 已安装）。 */
export function startFrpBridge(): void {
	if (!isFrpHosted() || started) return;
	started = true;

	const roomInfo = useRoomInfo();
	let lastBody = "";

	const snapshot = () => {
		const room = String(roomInfo.roomId || "");
		if (!room) return { room: "", game: "monopoly" };
		return {
			room,
			game: "monopoly",
			started: Boolean(roomInfo.isStarted),
			count: Array.isArray(roomInfo.userList) ? roomInfo.userList.length : 0,
			joinable: !roomInfo.isStarted,
		};
	};

	const report = () => {
		const body = JSON.stringify(snapshot());
		if (body === lastBody) return;
		lastBody = body;
		try {
			fetch("/api/monopoly/state", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
				keepalive: true,
				credentials: "same-origin",
			}).catch(() => {});
		} catch {
			/* 页面正在卸载，忽略 */
		}
	};

	watch(
		() => [roomInfo.roomId, roomInfo.isStarted, roomInfo.userList?.length],
		report,
		{ immediate: true },
	);
	presenceTimer = setInterval(report, PRESENCE_INTERVAL_MS);

	const clear = () => {
		try {
			navigator.sendBeacon?.("/api/monopoly/state", JSON.stringify({ room: "", game: "monopoly" }));
		} catch {
			/* 忽略 */
		}
	};
	window.addEventListener("pagehide", clear);
	window.addEventListener("beforeunload", clear);
}

/* -------------------------------------------------------------------------- */
/* 邀请好友弹窗（平台外壳，样式独立，不依赖上游组件的 class）                    */
/* -------------------------------------------------------------------------- */

type Friend = {
	id: string;
	name: string;
	avatar?: string;
	online?: boolean;
	playing?: { game?: string; code?: string; started?: boolean } | null;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (style) node.setAttribute("style", style);
	return node;
}

function statusText(friend: Friend): string {
	if (!friend.online) return "离线";
	if (friend.playing?.game === "monopoly") {
		return friend.playing.started ? "正在大富翁对局中" : "在大富翁房间里";
	}
	if (friend.playing?.game) return "正在玩别的游戏";
	return "在线";
}

/** 房间页「邀请好友」。重复点只开一个。 */
export function openFrpInviteDialog(roomId: string): void {
	if (!isFrpHosted()) return;
	const id = "frp-invite-overlay";
	if (document.getElementById(id)) return;

	const overlay = el("div", [
		"position:fixed", "inset:0", "z-index:99999", "background:rgba(8,19,31,.55)",
		"display:flex", "align-items:center", "justify-content:center", "padding:16px",
		"font-family:system-ui,-apple-system,'Segoe UI',sans-serif",
	].join(";"));
	overlay.id = id;

	const panel = el("div", [
		"width:min(440px,100%)", "max-height:min(560px,85vh)", "overflow:auto",
		"background:#fffaf0", "color:#3a2a18", "border-radius:18px",
		"box-shadow:0 18px 50px rgba(0,0,0,.35)", "padding:18px 18px 14px",
	].join(";"));

	const title = el("div", "font-size:18px;font-weight:700;margin-bottom:4px");
	title.textContent = "邀请好友来这局";
	const sub = el("div", "font-size:13px;color:#7a6a58;margin-bottom:12px");
	sub.textContent = `房号 ${roomId} · 好友点「进入」就能直接进房`;

	const list = el("div", "display:flex;flex-direction:column;gap:8px;min-height:80px");
	list.textContent = "正在读取好友列表…";

	const footer = el("div", "display:flex;gap:10px;justify-content:flex-end;margin-top:14px");
	const cancel = el("button", [
		"border:0", "border-radius:999px", "padding:10px 18px", "font-size:14px",
		"background:#eadfce", "color:#5a4632", "cursor:pointer",
	].join(";"));
	cancel.textContent = "取消";
	const send = el("button", [
		"border:0", "border-radius:999px", "padding:10px 18px", "font-size:14px",
		"background:#e2a03f", "color:#2b1d0e", "font-weight:700", "cursor:pointer",
	].join(";"));
	send.textContent = "发送邀请";

	footer.append(cancel, send);
	panel.append(title, sub, list, footer);
	overlay.append(panel);
	document.body.append(overlay);

	const close = () => {
		overlay.remove();
		document.removeEventListener("keydown", onKey);
	};
	const onKey = (event: KeyboardEvent) => {
		if (event.key === "Escape") close();
	};
	overlay.addEventListener("click", (event) => {
		if (event.target === overlay) close();
	});
	cancel.addEventListener("click", close);
	document.addEventListener("keydown", onKey);

	const selected = new Set<string>();
	let friends: Friend[] = [];

	const updateSendState = () => {
		send.disabled = selected.size === 0;
		send.style.opacity = selected.size === 0 ? "0.45" : "1";
	};

	const render = () => {
		list.textContent = "";
		if (friends.length === 0) {
			const empty = el("div", "font-size:14px;color:#7a6a58;line-height:1.6");
			empty.textContent = "平台里还没有好友。把房号发给朋友，他输入房号也能进来。";
			list.append(empty);
			send.disabled = true;
			send.style.opacity = "0.45";
			return;
		}
		for (const friend of friends) {
			const row = el("label", [
				"display:flex", "align-items:center", "gap:10px", "padding:8px 10px",
				"border-radius:12px", "background:#f6eddf", "cursor:pointer",
			].join(";"));
			const box = el("input");
			box.type = "checkbox";
			box.disabled = !friend.online;
			box.checked = selected.has(friend.id);
			box.addEventListener("change", () => {
				if (box.checked) selected.add(friend.id);
				else selected.delete(friend.id);
				updateSendState();
			});
			const avatar = el("img", "width:34px;height:34px;border-radius:50%;object-fit:cover;background:#ddd");
			avatar.src = friend.avatar || `/avatar/${encodeURIComponent(friend.id)}`;
			avatar.alt = "";
			const text = el("div", "display:flex;flex-direction:column;min-width:0");
			const name = el("div", "font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis");
			name.textContent = friend.name || "玩家";
			const st = el("div", "font-size:12px;color:#7a6a58");
			st.textContent = statusText(friend);
			text.append(name, st);
			row.append(box, avatar, text);
			list.append(row);
		}
		updateSendState();
	};

	fetch("/api/monopoly/friends", { credentials: "same-origin" })
		.then((res) => res.json())
		.then((json) => {
			friends = Array.isArray(json?.friends) ? json.friends : [];
			render();
		})
		.catch(() => {
			list.textContent = "好友列表加载失败，稍后再试。";
			send.disabled = true;
		});

	send.addEventListener("click", async () => {
		if (selected.size === 0) return;
		send.disabled = true;
		send.textContent = "发送中…";
		try {
			const res = await fetch("/api/monopoly/invite", {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify({ room: roomId, to: [...selected] }),
			});
			const json = await res.json().catch(() => ({}));
			if (!res.ok || json?.ok === false) throw new Error(json?.message || "邀请发送失败");
			const delivered = Array.isArray(json.delivered) ? json.delivered.length : selected.size;
			FPMessage({ type: "success", message: `已邀请 ${delivered} 位好友` });
			close();
		} catch (error: any) {
			FPMessage({ type: "error", message: error?.message || "邀请发送失败" });
			send.disabled = false;
			send.textContent = "发送邀请";
		}
	});
}

