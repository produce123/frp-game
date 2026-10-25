//! WebSocket 会话与广播。只传输消息，不读取或修改运行配置。
use host::HostError;
use kernel::World;
use protocol::{ClientMsg, EventInfo, ServerMsg};
use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{
    mpsc::{sync_channel, Receiver, SyncSender, TryRecvError, TrySendError},
    Arc, Mutex,
};
use std::{thread, time::Duration};
use tungstenite::{
    handshake::server::{Request, Response},
    Message, WebSocket,
};

/// 每个连接最多积压这么多条待发消息（每拍至少广播一条名册）；超出说明客户端收不过来，断开这条连接。
const OUTBOUND_QUEUE: usize = 1024;
/// 一次写入超过这么久没写完就断开这条连接。
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) struct Peer {
    sender: SyncSender<String>,
    /// 同一个套接字的副本：积压超限时从这里关闭，连接线程的读写随即失败退出。
    socket: TcpStream,
    input: Option<ClientMsg>,
}

impl Peer {
    /// 放进发送队列。连接已断开，或积压超限（这时关闭连接并记日志）时返回 false，
    /// 调用方把它移出连接表。
    fn deliver(&self, connection: u64, message: String) -> bool {
        match self.sender.try_send(message) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                eprintln!("[host] 连接 {connection} 积压超过 {OUTBOUND_QUEUE} 条消息，已断开");
                let _ = self.socket.shutdown(Shutdown::Both);
                false
            }
            Err(TrySendError::Disconnected(_)) => false,
        }
    }
}

pub(crate) type Clients = Arc<Mutex<BTreeMap<u64, Peer>>>;

/// 平台反代在 WS 握手 query 里注入的身份；直连（本机调试）没有这些参数，按房主处理。
#[derive(Debug, Clone, Default)]
pub(crate) struct PeerIdentity {
    pub role: String,
    pub user: String,
    pub name: String,
    pub avatar: String,
}

impl PeerIdentity {
    fn from_query(query: Option<&str>) -> Self {
        let mut out = Self::default();
        for pair in query.unwrap_or_default().split('&') {
            let Some((k, v)) = pair.split_once('=') else {
                continue;
            };
            let value = percent_decode(v);
            match k {
                "frp_role" => out.role = value,
                "frp_user" => out.user = value,
                "frp_name" => out.name = value,
                "frp_avatar" => out.avatar = value,
                _ => {}
            }
        }
        out
    }
    pub fn is_guest(&self) -> bool {
        self.role == "guest"
    }
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| -> Option<u8> {
                match b {
                    b'0'..=b'9' => Some(b - b'0'),
                    b'a'..=b'f' => Some(b - b'a' + 10),
                    b'A'..=b'F' => Some(b - b'A' + 10),
                    _ => None,
                }
            };
            if let (Some(a), Some(b)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(a * 16 + b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub(crate) enum NetworkEvent {
    /// 连接建立：把平台身份（房主/访客、账号名、头像）交给模拟线程。
    Connected {
        connection: u64,
        identity: PeerIdentity,
    },
    /// 客户端命令；消息体比断线事件大得多，装箱后队列里每项占用一样小。
    Command {
        connection: u64,
        message: Box<ClientMsg>,
    },
    Disconnected(u64),
}
pub(crate) fn send_to(clients: &Clients, connection: u64, message: &ServerMsg) {
    let mut peers = clients.lock().unwrap();
    if peers
        .get(&connection)
        .is_some_and(|peer| !peer.deliver(connection, encode(message)))
    {
        peers.remove(&connection);
    }
}
pub(crate) fn take_inputs(clients: &Clients) -> Vec<(u64, ClientMsg)> {
    clients
        .lock()
        .unwrap()
        .iter_mut()
        .filter_map(|(id, p)| p.input.take().map(|v| (*id, v)))
        .collect()
}

/// 所有连接共用的命令队列上限；满了就退回发送方，模拟循环每拍最多处理一批。
const COMMAND_QUEUE: usize = 256;

/// `greeting` 是握手成功后先发给每个连接的世界身份；没有时不发。
pub(crate) fn listen(
    port: u16,
    greeting: Option<String>,
    token: Option<String>,
) -> Result<(Clients, Receiver<NetworkEvent>, u16), HostError> {
    let clients: Clients = Arc::new(Mutex::new(BTreeMap::new()));
    let (to_sim, from_net) = sync_channel(COMMAND_QUEUE);
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| HostError::Runtime(format!("端口 {port} 被占用：{e}")))?;
    let actual_port = listener
        .local_addr()
        .map_err(|e| HostError::Runtime(format!("读取监听端口失败：{e}")))?
        .port();
    println!("[host] ws://127.0.0.1:{actual_port}/");
    let accepted = clients.clone();
    let ids = AtomicU64::new(1);
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let Ok(socket) = stream.try_clone() else {
                continue;
            };
            let Some((ws, identity)) = handshake(stream, token.as_deref(), greeting.as_deref())
            else {
                continue;
            };
            let (tx, rx) = sync_channel::<String>(OUTBOUND_QUEUE);
            let id = ids.fetch_add(1, Ordering::Relaxed);
            accepted.lock().unwrap().insert(
                id,
                Peer {
                    sender: tx,
                    socket,
                    input: None,
                },
            );
            let _ = to_sim.send(NetworkEvent::Connected {
                connection: id,
                identity,
            });
            let to_sim = to_sim.clone();
            let peers = accepted.clone();
            thread::spawn(move || {
                serve_connection(ws, rx, to_sim.clone(), id, &peers);
                peers.lock().unwrap().remove(&id);
                let _ = to_sim.send(NetworkEvent::Disconnected(id));
            });
        }
    });
    Ok((clients, from_net, actual_port))
}

/// 握手：校验会话标识，成功后先发世界身份。任何一步失败都丢弃这条连接。
fn handshake(
    stream: TcpStream,
    token: Option<&str>,
    greeting: Option<&str>,
) -> Option<(WebSocket<TcpStream>, PeerIdentity)> {
    stream.set_nodelay(true).ok();
    stream
        .set_read_timeout(Some(Duration::from_millis(50)))
        .ok();
    stream.set_write_timeout(Some(WRITE_TIMEOUT)).ok();
    let expected = token.map(|t| format!("session={t}"));
    let identity = Arc::new(Mutex::new(PeerIdentity::default()));
    let slot = identity.clone();
    let mut ws = tungstenite::accept_hdr(stream, move |request: &Request, response: Response| {
        let valid = match &expected {
            None => true,
            Some(expected) => request
                .uri()
                .query()
                .is_some_and(|q| q.split('&').any(|part| part == expected)),
        };
        if valid {
            *slot.lock().unwrap() = PeerIdentity::from_query(request.uri().query());
            Ok(response)
        } else {
            Err(tungstenite::http::Response::builder()
                .status(403)
                .body(Some("世界连接已失效，请从小镇列表重新进入".into()))
                .unwrap())
        }
    })
    .ok()?;
    if let Some(greeting) = greeting {
        if ws.send(Message::Text(greeting.into())).is_err() {
            return None;
        }
    }
    let identity = identity.lock().unwrap().clone();
    Some((ws, identity))
}

/// 一条连接：把广播队列全部发出，再读一条客户端命令（超时即过），直到任一方向断开。
fn serve_connection(
    mut ws: WebSocket<TcpStream>,
    rx: Receiver<String>,
    to_sim: SyncSender<NetworkEvent>,
    connection: u64,
    peers: &Clients,
) {
    loop {
        loop {
            match rx.try_recv() {
                Ok(msg) => {
                    if !send(&mut ws, connection, msg) {
                        return;
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }
        match ws.read() {
            Ok(Message::Text(txt)) => match serde_json::from_str::<ClientMsg>(&txt) {
                Ok(msg) => {
                    if matches!(msg, ClientMsg::AvatarInput { .. }) {
                        if let Some(peer) = peers.lock().unwrap().get_mut(&connection) {
                            peer.input = Some(msg);
                        }
                        continue;
                    }
                    let request_id = msg.request_id().map(str::to_owned);
                    match to_sim.try_send(NetworkEvent::Command {
                        connection,
                        message: Box::new(msg),
                    }) {
                        Ok(()) => {}
                        Err(TrySendError::Full(_)) => {
                            let error = ServerMsg::Error {
                                request_id,
                                message: "命令过多，这条已丢弃，请稍后再试".into(),
                            };
                            if !send(&mut ws, connection, encode(&error)) {
                                return;
                            }
                        }
                        Err(TrySendError::Disconnected(_)) => return,
                    }
                }
                Err(e) => {
                    eprintln!("[host] 客户端消息解析失败：{e}");
                    if !send(&mut ws, connection, encode(&malformed(&txt, &e))) {
                        return;
                    }
                }
            },
            Ok(Message::Close(_)) => return,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => return,
        }
    }
}

/// 发出一条消息；返回 false 时连接不能再用。写超时记日志，对方正常断开不记。
fn send(ws: &mut WebSocket<TcpStream>, connection: u64, text: String) -> bool {
    match ws.send(Message::Text(text)) {
        Ok(()) => true,
        Err(tungstenite::Error::Io(e))
            if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
        {
            eprintln!(
                "[host] 连接 {connection} 写入 {} 秒未完成，已断开",
                WRITE_TIMEOUT.as_secs()
            );
            false
        }
        Err(_) => false,
    }
}

fn encode(msg: &ServerMsg) -> String {
    serde_json::to_string(msg).expect("服务端消息都能编码")
}

/// 读不懂的命令：回一条错误。原文是 JSON 对象且带字符串编号（request_id，加入小镇是 op_id）时
/// 带上这个编号，发出者据此结束等待。
fn malformed(text: &str, error: &serde_json::Error) -> ServerMsg {
    let value = serde_json::from_str::<serde_json::Value>(text).ok();
    let request_id = ["request_id", "op_id"].into_iter().find_map(|key| {
        value
            .as_ref()?
            .get(key)?
            .as_str()
            .filter(|id| id.len() <= kernel::ID_MAX_BYTES)
            .map(str::to_owned)
    });
    ServerMsg::Error {
        request_id,
        message: format!("命令格式错误：{error}"),
    }
}

/// 世界日志一行：正文给人读，info 是种类、人物与提示卡细节。
pub(crate) fn broadcast_event(clients: &Clients, world: &World, text: String, info: EventInfo) {
    broadcast(
        clients,
        &ServerMsg::Event {
            sim_minutes: world.minutes(),
            clock: world.clock(),
            text,
            info,
        },
    );
}

pub(crate) fn broadcast(clients: &Clients, msg: &ServerMsg) {
    let json = encode(msg);
    clients
        .lock()
        .unwrap()
        .retain(|id, peer| peer.deliver(*id, json.clone()));
}
