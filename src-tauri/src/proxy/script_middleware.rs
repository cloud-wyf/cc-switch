//! Provider-scoped TypeScript middleware. HTTP transport stays in Rust; Node only runs the script.

use super::{hyper_client::ProxyResponse, ProxyError};
use base64::{engine::general_purpose::STANDARD, Engine};
use bytes::Bytes;
use futures::{future::BoxFuture, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{mpsc, oneshot},
    task::JoinSet,
};

const RUNNER: &str = include_str!("script_runner.mjs");
const MAX_SOURCE_BYTES: usize = 1024 * 1024;
const MAX_FRAME_BYTES: u64 = 300 * 1024 * 1024;
const WATCHDOG: Duration = Duration::from_secs(15);
static PROCESS_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(16);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct ScriptRequest {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    /// Base64 preserves binary request bodies across the process boundary.
    pub body: String,
}

pub(crate) type Transport = Arc<
    dyn Fn(ScriptRequest) -> BoxFuture<'static, Result<ProxyResponse, ProxyError>> + Send + Sync,
>;

#[derive(Deserialize)]
struct ResponseHead {
    status: u16,
    headers: Vec<(String, String)>,
}

/// Dropping an HTTP response or a cancelled request also stops its script and upstream requests.
struct RequestLifetime {
    _cancel: oneshot::Sender<()>,
}

pub(crate) fn headers_to_pairs(headers: &http::HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .map(|(name, value)| {
            (
                name.to_string(),
                String::from_utf8_lossy(value.as_bytes()).into(),
            )
        })
        .collect()
}

pub(crate) fn parse_headers(pairs: Vec<(String, String)>) -> Result<http::HeaderMap, ProxyError> {
    let mut headers = http::HeaderMap::new();
    for (name, value) in pairs {
        let name = http::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| script_error("脚本返回了无效的 Header 名称"))?;
        let value = http::HeaderValue::from_str(&value)
            .map_err(|_| script_error("脚本返回了无效的 Header 值"))?;
        headers.append(name, value);
    }
    Ok(headers)
}

fn script_error(message: impl std::fmt::Display) -> ProxyError {
    ProxyError::ScriptError(message.to_string())
}

fn spawn_runner(source: &str) -> Result<Child, ProxyError> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(script_error("脚本不能超过 1 MiB"));
    }
    let mut command = Command::new("node");
    command
        .args([
            "--no-warnings=ExperimentalWarning",
            "--experimental-vm-modules",
            "--max-old-space-size=512",
            "--input-type=module",
            "--eval",
            RUNNER,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    command.spawn().map_err(|error| {
        script_error(format!(
            "无法启动 Node.js，请安装 Node.js 24 或更新版本并确保 node 在 PATH 中：{error}"
        ))
    })
}

async fn read_frame(reader: &mut BufReader<tokio::process::ChildStdout>) -> Result<Value, String> {
    let mut bytes = Vec::new();
    let count = reader
        .take(MAX_FRAME_BYTES + 1)
        .read_until(b'\n', &mut bytes)
        .await
        .map_err(|error| error.to_string())?;
    if count == 0 {
        return Err("脚本进程提前退出".into());
    }
    if count as u64 > MAX_FRAME_BYTES {
        return Err("脚本通信数据超过大小上限".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "脚本通信格式错误，请使用 console 输出日志，勿写入 stdout".into())
}

pub(crate) async fn validate(source: &str) -> Result<(), String> {
    if source.trim().is_empty() {
        return Ok(());
    }
    let _slot = tokio::time::timeout(WATCHDOG, PROCESS_SLOTS.acquire())
        .await
        .map_err(|_| "代理脚本繁忙，请稍后重试语法校验".to_string())?
        .map_err(|error| error.to_string())?;
    let mut child = spawn_runner(source).map_err(|error| error.to_string())?;
    let mut input = child.stdin.take().expect("piped stdin");
    let mut output = BufReader::new(child.stdout.take().expect("piped stdout"));
    let result = tokio::time::timeout(WATCHDOG, async {
        let packet = format!("{}\n", json!({"type":"validate", "source":source}));
        input
            .write_all(packet.as_bytes())
            .await
            .map_err(|error| error.to_string())?;
        loop {
            let message = read_frame(&mut output).await?;
            match message["type"].as_str() {
                Some("valid") => return Ok(()),
                Some("heartbeat") => continue,
                _ => {
                    return Err(message["message"]
                        .as_str()
                        .unwrap_or("脚本校验失败")
                        .to_string())
                }
            }
        }
    })
    .await
    .map_err(|_| "脚本语法校验超时".to_string())
    .and_then(|result| result);
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

pub(crate) async fn execute(
    source: &str,
    request: ScriptRequest,
    context: Value,
    transport: Transport,
    header_timeout: Duration,
) -> Result<ProxyResponse, ProxyError> {
    let slot = tokio::time::timeout(header_timeout, PROCESS_SLOTS.acquire())
        .await
        .map_err(|_| script_error("等待脚本执行名额超时"))?
        .map_err(script_error)?;
    let child = spawn_runner(source)?;
    let (commands, command_rx) = mpsc::channel(16);
    let (head_tx, head_rx) = oneshot::channel();
    let (body_tx, mut body_rx) = mpsc::channel::<Result<Option<Bytes>, String>>(1);
    let (lifetime_tx, lifetime_rx) = oneshot::channel();
    let lifetime = RequestLifetime {
        _cancel: lifetime_tx,
    };
    let init = json!({"type":"init", "source":source, "request":request, "context":context});
    tokio::spawn(supervise(
        child,
        init,
        transport,
        command_rx,
        head_tx,
        body_tx,
        lifetime_rx,
        slot,
    ));
    let head = tokio::time::timeout(header_timeout, head_rx)
        .await
        .map_err(|_| script_error("等待中间件响应超时"))?
        .map_err(|_| script_error("脚本进程未返回响应"))??;
    let status = http::StatusCode::from_u16(head.status).map_err(script_error)?;
    let mut headers = parse_headers(head.headers)?;
    super::response_processor::strip_hop_by_hop_response_headers(&mut headers);
    headers.remove(http::header::CONTENT_LENGTH);
    let stream = async_stream::stream! {
        let _lifetime = lifetime;
        loop {
            if commands.send(json!({"type":"response_pull"})).await.is_err() {
                yield Err(std::io::Error::other("代理脚本进程已退出"));
                break;
            }
            match body_rx.recv().await {
                Some(Ok(Some(bytes))) => yield Ok(bytes),
                Some(Ok(None)) => break,
                Some(Err(error)) => { yield Err(std::io::Error::other(error)); break; }
                None => { yield Err(std::io::Error::other("代理脚本响应流提前结束")); break; }
            }
        }
    };
    Ok(ProxyResponse::streamed(status, headers, stream))
}

#[allow(clippy::too_many_arguments)]
async fn supervise(
    mut child: Child,
    init: Value,
    transport: Transport,
    mut commands: mpsc::Receiver<Value>,
    head_tx: oneshot::Sender<Result<ResponseHead, ProxyError>>,
    body_tx: mpsc::Sender<Result<Option<Bytes>, String>>,
    mut lifetime: oneshot::Receiver<()>,
    _slot: tokio::sync::SemaphorePermit<'static>,
) {
    let mut input = child.stdin.take().expect("piped stdin");
    let mut output = BufReader::new(child.stdout.take().expect("piped stdout"));
    let stderr = child.stderr.take().expect("piped stderr");
    let provider_id = init["context"]["providerId"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let (writer, mut writes) = mpsc::channel::<Value>(16);
    let mut tasks = JoinSet::new();
    // Read complete frames in a dedicated task: cancelling read_until halfway through a
    // frame when another command arrives would otherwise corrupt the JSON stream.
    let (frames_tx, mut frames_rx) = mpsc::channel(8);
    tasks.spawn(async move {
        loop {
            let frame = read_frame(&mut output).await;
            let failed = frame.is_err();
            if frames_tx.send(frame).await.is_err() || failed {
                break;
            }
        }
    });
    tasks.spawn(async move {
        while let Some(message) = writes.recv().await {
            let packet = format!("{message}\n");
            if input.write_all(packet.as_bytes()).await.is_err() {
                break;
            }
        }
    });
    tasks.spawn(async move {
        let mut reader = BufReader::new(stderr);
        loop {
            let mut line = Vec::new();
            match (&mut reader).take(4096).read_until(b'\n', &mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => log::debug!(
                    "[ProxyScript:{provider_id}] {}",
                    String::from_utf8_lossy(&line).trim_end()
                ),
            }
        }
    });
    let _ = writer.send(init).await;
    let mut head_tx = Some(head_tx);
    let mut fetches: HashMap<u64, mpsc::Sender<bool>> = HashMap::new();
    let mut transport_failure = false;
    let outcome: Result<(), String> = async {
        loop {
            while tasks.try_join_next().is_some() {}
            let message = tokio::select! {
                _ = &mut lifetime => return Ok(()),
                command = commands.recv() => {
                    let Some(command) = command else { return Ok(()); };
                    writer.send(command).await.map_err(|_| "脚本输入流已关闭")?;
                    continue;
                }
                frame = tokio::time::timeout(WATCHDOG, frames_rx.recv()) => {
                    frame.map_err(|_| "代理脚本无响应，已终止运行")?
                        .ok_or("脚本输出流已关闭")??
                }
            };
            match message["type"].as_str() {
                Some("heartbeat") => {}
                Some("response_head") => {
                    let head: ResponseHead =
                        serde_json::from_value(message).map_err(|error| error.to_string())?;
                    let sender = head_tx.take().ok_or("脚本重复返回响应头")?;
                    sender.send(Ok(head)).map_err(|_| "请求已取消")?;
                }
                Some("response_chunk") => {
                    let bytes = STANDARD
                        .decode(message["body"].as_str().ok_or("缺少响应数据")?)
                        .map_err(|error| error.to_string())?;
                    body_tx
                        .try_send(Ok(Some(Bytes::from(bytes))))
                        .map_err(|_| "脚本响应超出读取需求")?;
                }
                Some("response_end") => {
                    let _ = body_tx.try_send(Ok(None));
                    return Ok(());
                }
                Some("fetch") => {
                    let id = message["id"].as_u64().ok_or("缺少转发请求 ID")?;
                    fetches.retain(|_, sender| !sender.is_closed());
                    if fetches.len() >= 16 || fetches.contains_key(&id) {
                        return Err("中间件并发转发超过上限".into());
                    }
                    let request: ScriptRequest =
                        serde_json::from_value(message).map_err(|error| error.to_string())?;
                    let (control, receiver) = mpsc::channel(2);
                    fetches.insert(id, control);
                    tasks.spawn(forward_request(
                        id,
                        request,
                        transport.clone(),
                        writer.clone(),
                        receiver,
                    ));
                }
                Some("fetch_pull" | "fetch_cancel") => {
                    if let Some(control) = message["id"].as_u64().and_then(|id| fetches.get(&id)) {
                        let _ = control.try_send(message["type"] == "fetch_pull");
                    }
                }
                Some("error") => {
                    transport_failure = message["transport"] == true;
                    return Err(message["message"]
                        .as_str()
                        .unwrap_or("脚本执行失败")
                        .to_string());
                }
                _ => return Err("未知的脚本通信消息".into()),
            }
        }
    }
    .await;
    if let Err(error) = outcome {
        if let Some(sender) = head_tx {
            let error = if transport_failure {
                ProxyError::ForwardFailed(error)
            } else {
                script_error(error)
            };
            let _ = sender.send(Err(error));
        } else {
            let _ = body_tx.try_send(Err(error));
        }
    }
    tasks.abort_all();
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn forward_request(
    id: u64,
    request: ScriptRequest,
    transport: Transport,
    writer: mpsc::Sender<Value>,
    mut control: mpsc::Receiver<bool>,
) {
    let method = request.method.clone();
    let response = tokio::select! {
        _ = control.recv() => return,
        result = transport(request) => result,
    };
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            let transport_error = !matches!(
                error,
                ProxyError::ScriptError(_)
                    | ProxyError::ConfigError(_)
                    | ProxyError::InvalidRequest(_)
            );
            let _ = writer.send(json!({"type":"fetch_error", "id":id, "message":error.to_string(), "transport":transport_error})).await;
            return;
        }
    };
    if writer.send(json!({"type":"fetch_head", "id":id, "status":response.status().as_u16(), "headers":headers_to_pairs(response.headers()), "method":method})).await.is_err() { return; }
    let mut stream = Box::pin(response.bytes_stream());
    while control.recv().await == Some(true) {
        let chunk = tokio::select! {
            _ = control.recv() => return,
            chunk = stream.next() => chunk,
        };
        let message = match chunk {
            Some(Ok(bytes)) => {
                json!({"type":"fetch_chunk", "id":id, "body":STANDARD.encode(bytes)})
            }
            Some(Err(error)) => json!({"type":"fetch_error", "id":id, "message":error.to_string()}),
            None => json!({"type":"fetch_end", "id":id}),
        };
        let ended = message["type"] != "fetch_chunk";
        if writer.send(message).await.is_err() || ended {
            return;
        }
    }
}

#[cfg(test)]
#[path = "script_middleware_tests.rs"]
mod tests;
