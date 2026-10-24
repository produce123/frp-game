/*
 * frp-game 自建服的 PeerJS 替代实现：所有"点对点"消息改走同源 WebSocket 中转。
 *
 * 上游用 PeerJS(WebRTC)：房主浏览器跑游戏逻辑，客人通过 WebRTC DataChannel 连房主。
 * 跨网络时没有 TURN 经常连不上，而本项目的 SakuraFrp 隧道只映射了 7891 一个端口，
 * 不可能再开 UDP/TURN。所以这里只替换**传输层**：
 *
 *   浏览器 ──wss://<同源>/monopoly-relay──► server/monopoly/relay.mjs ──► 房主浏览器
 *
 * 对上游代码保持 PeerJS 的 API 形状（`new Peer()` / `peer.connect()` / `peer.on("connection")`
 * / `conn.send()` / `conn.on("data")`），所以 `PeerClient.ts`、`MonopolyHost.ts` 一行都不用改。
 * 游戏逻辑、消息格式、地图分块协议全都不动。
 *
 * 帧格式（文本帧一律 JSON；二进制帧用于地图分块这种大块数据）：
 *   文本：{ type:"hello"|"connect"|"connected"|"connection"|"data"|"close"|"peer-disconnect"|"error", ... }
 *   二进制：[1][目标 peerId 长度:1][目标 peerId UTF-8][原始字节]
 *
 * 约定：PeerJS 的 `peer.id` 由服务端分配；重连时带 `resume` 要回同一个 id，
 * 否则房主重连后客人手里的 hostPeerId 会失效（房间路由表里存的是旧 id）。
 */

type Listener = (...args: any[]) => void;

class Emitter {
	private readonly listeners = new Map<string, Listener[]>();

	on(event: string, fn: Listener) {
		const list = this.listeners.get(event);
		if (list) list.push(fn);
		else this.listeners.set(event, [fn]);
		return this;
	}

	once(event: string, fn: Listener) {
		const wrapper = (...args: any[]) => {
			this.off(event, wrapper);
			fn(...args);
		};
		return this.on(event, wrapper);
	}

	off(event: string, fn?: Listener) {
		if (!fn) {
			this.listeners.delete(event);
			return this;
		}
		const list = this.listeners.get(event);
		if (!list) return this;
		const idx = list.indexOf(fn);
		if (idx >= 0) list.splice(idx, 1);
		return this;
	}

	removeAllListeners(event?: string) {
		if (event) this.listeners.delete(event);
		else this.listeners.clear();
		return this;
	}

	protected emit(event: string, ...args: any[]) {
		const list = this.listeners.get(event);
		if (!list || list.length === 0) return;
		for (const fn of [...list]) {
			try {
				fn(...args);
			} catch (err) {
				console.error(`[relay-peer] listener for "${event}" failed`, err);
			}
		}
	}
}

/** 对上游暴露的连接对象；形状对齐 peerjs 的 DataConnection。 */
export class DataConnection extends Emitter {
	/** peerjs 里用于 debug 的字段，这里没有真实 RTC 连接。 */
	public readonly peerConnection = undefined;
	public readonly connectionId: number;
	public readonly peer: string;
	public readonly label: string;
	public readonly serialization = "binary";
	public readonly metadata: unknown = undefined;
	public open = false;
	public closed = false;

	private readonly owner: Peer;

	constructor(owner: Peer, remoteId: string, open: boolean, connectionId: number) {
		super();
		this.owner = owner;
		this.peer = remoteId;
		this.connectionId = connectionId;
		this.label = remoteId;
		this.open = open;
	}

	send(data: string | ArrayBuffer | ArrayBufferView): void {
		if (this.closed) return;
		this.owner._sendTo(this.peer, data);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.open = false;
		this.owner._dropConnection(this.peer, true);
		this.emit("close");
	}

	/** 由 Peer 调用：传输层断了（不是主动 close）。 */
	_remoteClose(): void {
		if (this.closed) return;
		this.closed = true;
		this.open = false;
		this.emit("close");
	}

	_deliver(payload: string | Uint8Array): void {
		if (this.closed) return;
		this.emit("data", payload);
	}

	_markOpen(): void {
		if (this.closed || this.open) return;
		this.open = true;
		this.emit("open");
	}
}

const RELAY_PATH = "/monopoly-relay";
const MAX_RECONNECT_DELAY = 10_000;

type PeerOptions = {
	host?: string;
	port?: number;
	path?: string;
	secure?: boolean;
	debug?: number;
	config?: unknown;
};

/**
 * 与 PeerJS 的 `Peer` 同名同形。构造后自动连 `/monopoly-relay`，
 * 收到服务端 `welcome` 后触发 `open`（带 peer id）。
 */
export default class Peer extends Emitter {
	public id = "";
	public destroyed = false;
	public disconnected = true;

	private readonly options: PeerOptions;
	private ws: WebSocket | null = null;
	private readonly conns = new Map<string, DataConnection>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectDelay = 1000;
	private nextConnectionId = 1;
	/** connect() 在 ws 还没 open 时排队，open 后统一发出。 */
	private readonly pendingConnects = new Set<string>();

	constructor(options: PeerOptions = {}) {
		super();
		this.options = options || {};
		this._open();
	}

	/** 建立/重建与中转服务的连接。 */
	private _open(): void {
		if (this.destroyed) return;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		const proto = typeof location !== "undefined" && location.protocol === "https:" ? "wss:" : "ws:";
		const host = typeof location !== "undefined" ? location.host : "127.0.0.1";
		let socket: WebSocket;
		try {
			socket = new WebSocket(`${proto}//${host}${RELAY_PATH}`);
		} catch (err) {
			this._scheduleReconnect();
			return;
		}
		socket.binaryType = "arraybuffer";
		this.ws = socket;

		socket.onopen = () => {
			this.reconnectDelay = 1000;
			this.disconnected = false;
			const hello: Record<string, unknown> = { type: "hello" };
			if (this.id) hello.resume = this.id;
			try { socket.send(JSON.stringify(hello)); } catch { /* 断了，onclose 会处理 */ }
		};

		socket.onmessage = (event) => {
			if (typeof event.data === "string") {
				this._handleText(event.data);
			} else {
				this._handleBinary(event.data);
			}
		};

		socket.onclose = () => {
			if (this.ws !== socket) return;
			this.ws = null;
			this.disconnected = true;
			for (const conn of [...this.conns.values()]) conn._remoteClose();
			this.conns.clear();
			this.emit("disconnected");
			// 上游的 PeerClient 会复用同一个 Peer 重连，所以这里自己重试；
			// 重试期间 connect() 的请求排队，等 open 后一次性发出。
			this._scheduleReconnect();
		};

		socket.onerror = () => {
			// 交给 onclose；PeerJS 也会在信令失败时只触发 disconnected/error。
		};
	}

	private _scheduleReconnect(): void {
		if (this.destroyed || this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this._open();
		}, this.reconnectDelay);
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
	}

	private _handleText(raw: string): void {
		let msg: any;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		switch (msg && msg.type) {
			case "welcome": {
				this.id = String(msg.id || "");
				this.disconnected = false;
				this.emit("open", this.id);
				// 补发排队中的 connect
				for (const target of [...this.pendingConnects]) {
					this.pendingConnects.delete(target);
					this._sendConnect(target);
				}
				return;
			}
			case "connected": {
				const conn = this.conns.get(String(msg.from || ""));
				if (conn) conn._markOpen();
				return;
			}
			case "connection": {
				const from = String(msg.from || "");
				if (!from) return;
				const conn = new DataConnection(this, from, true, this.nextConnectionId++);
				this.conns.set(from, conn);
				this.emit("connection", conn);
				return;
			}
			case "data": {
				const conn = this.conns.get(String(msg.from || ""));
				if (conn) conn._deliver(String(msg.payload ?? ""));
				return;
			}
			case "peer-disconnect": {
				const conn = this.conns.get(String(msg.id || ""));
				if (conn) {
					this.conns.delete(String(msg.id));
					conn._remoteClose();
				}
				return;
			}
			case "error": {
				const to = String(msg.to || "");
				const conn = to ? this.conns.get(to) : null;
				if (conn) {
					this.conns.delete(to);
					conn._remoteClose();
				}
				this.emit("error", new Error(String(msg.message || "中转连接失败")));
				return;
			}
			default:
				return;
		}
	}

	private _handleBinary(data: ArrayBuffer): void {
		const bytes = new Uint8Array(data);
		if (bytes.length < 2 || bytes[0] !== 1) return;
		const idLen = bytes[1];
		if (bytes.length < 2 + idLen) return;
		const from = new TextDecoder().decode(bytes.subarray(2, 2 + idLen));
		const payload = bytes.subarray(2 + idLen);
		const conn = this.conns.get(from);
		if (conn) conn._deliver(payload);
	}

	connect(remoteId: string): DataConnection {
		if (this.destroyed) throw new Error("Peer 已销毁");
		const id = String(remoteId);
		const existing = this.conns.get(id);
		if (existing && !existing.closed) return existing;

		const conn = new DataConnection(this, id, false, this.nextConnectionId++);
		this.conns.set(id, conn);
		if (this.ws && this.ws.readyState === WebSocket.OPEN && this.id) {
			this._sendConnect(id);
		} else {
			this.pendingConnects.add(id);
		}
		return conn;
	}

	private _sendConnect(target: string): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			this.pendingConnects.add(target);
			return;
		}
		try {
			this.ws.send(JSON.stringify({ type: "connect", to: target }));
		} catch {
			this.pendingConnects.add(target);
		}
	}

	_sendTo(remoteId: string, data: string | ArrayBuffer | ArrayBufferView): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		try {
			if (typeof data === "string") {
				this.ws.send(JSON.stringify({ type: "data", to: remoteId, payload: data }));
				return;
			}
			const bytes = data instanceof ArrayBuffer
				? new Uint8Array(data)
				: new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
			const idBytes = new TextEncoder().encode(remoteId);
			if (idBytes.length > 255) throw new Error("peerId 过长");
			const frame = new Uint8Array(2 + idBytes.length + bytes.length);
			frame[0] = 1;
			frame[1] = idBytes.length;
			frame.set(idBytes, 2);
			frame.set(bytes, 2 + idBytes.length);
			this.ws.send(frame);
		} catch (err) {
			console.error("[relay-peer] 发送失败", err);
		}
	}

	_dropConnection(remoteId: string, notifyRemote: boolean): void {
		this.conns.delete(remoteId);
		if (!notifyRemote) return;
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			try { this.ws.send(JSON.stringify({ type: "close", to: remoteId })); } catch { /* 已断 */ }
		}
	}

	disconnect(): void {
		if (this.ws) {
			this.ws.close();
		}
	}

	reconnect(): void {
		if (this.ws) this.ws.close();
		else this._open();
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		for (const conn of [...this.conns.values()]) conn._remoteClose();
		this.conns.clear();
		if (this.ws) {
			try { this.ws.close(); } catch { /* 已断 */ }
			this.ws = null;
		}
		this.emit("close");
	}

	/** 仅供调试：当前中转连接数。 */
	get connectionCount(): number {
		return this.conns.size;
	}
}