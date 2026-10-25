//! 向世界进程问一件事：连上、可选地发一条命令，等到第一条符合条件的消息就断开。
use crate::error::ApiError;
use serde_json::Value;
use std::net::TcpStream;
use std::time::{Duration, Instant};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

/// 连接世界；读超时设成 `tick`，到点没有消息就回到调用方检查期限。
fn connect(endpoint: &str, tick: Duration) -> Result<Socket, ApiError> {
    let (socket, _) =
        tungstenite::connect(endpoint).map_err(|_| ApiError::bad("无法连接世界服务"))?;
    if let MaybeTlsStream::Plain(stream) = socket.get_ref() {
        stream
            .set_read_timeout(Some(tick))
            .map_err(ApiError::from)?;
    }
    Ok(socket)
}

/// 读到的一条：解析后的文本消息、这一轮没有消息、连接已断。
enum Read {
    Message(Value),
    Idle,
    Closed,
}

/// 读下一条文本消息并解析；读超时算 `Idle`。
fn next(socket: &mut Socket) -> Read {
    loop {
        match socket.read() {
            Ok(Message::Text(text)) => {
                return Read::Message(serde_json::from_str(&text).unwrap_or(Value::Null));
            }
            Ok(Message::Close(_)) => return Read::Closed,
            Ok(_) => continue,
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                return Read::Idle
            }
            Err(_) => return Read::Closed,
        }
    }
}

pub fn query(
    endpoint: &str,
    command: Option<&Value>,
    want: impl Fn(&Value) -> bool,
) -> Result<Value, ApiError> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut socket = connect(endpoint, Duration::from_millis(200))?;
    if let Some(command) = command {
        socket
            .send(Message::Text(command.to_string()))
            .map_err(|_| ApiError::bad("世界连接已断开"))?;
    }
    let result = loop {
        if Instant::now() > deadline {
            break Err(ApiError::bad("世界服务没有及时回应"));
        }
        match next(&mut socket) {
            Read::Message(value) if want(&value) => break Ok(value),
            Read::Message(..) | Read::Idle => {}
            Read::Closed => break Err(ApiError::bad("世界连接已断开")),
        }
    };
    let _ = socket.close(None);
    let _ = socket.flush();
    result
}
