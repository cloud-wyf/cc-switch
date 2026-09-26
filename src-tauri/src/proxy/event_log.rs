//! 本地代理的详细报文日志。只旁路采样，不预读响应、不改变流式背压。

use super::{
    hyper_client::ProxyResponse, server::ProxyState, upstream_transport::UpstreamRequest,
    ProxyError,
};
use crate::{
    database::{Database, ProxyEventLogConfig},
    provider::Provider,
};
use axum::{
    body::Body,
    extract::{Request, State},
    middleware::Next,
    response::Response,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use bytes::Bytes;
use futures::Stream;
use http::{HeaderMap, Method};
use http_body::{Body as HttpBody, Frame, SizeHint};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, OnceLock,
    },
    task::{Context, Poll},
    time::Instant,
};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
static RUN_AT: OnceLock<String> = OnceLock::new();

/// 顶层字段名到其规范化 JSON 摘要；用完整正文比较字段变化，不受采样截断影响。
type Fields = BTreeMap<String, [u8; 32]>;

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    // 日志状态损坏不能使正在代理的请求 panic。
    value.lock().unwrap_or_else(|error| error.into_inner())
}

fn local_time() -> String {
    chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string()
}

/// 递归按键排序，保证同一语义的对象无论来源如何摘要一致。
fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .map(|(key, value)| (key.clone(), canonical(value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

fn fields_of(value: &Value) -> Option<Fields> {
    value.as_object().map(|object| {
        object
            .iter()
            .map(|(key, value)| {
                let bytes = serde_json::to_vec(&canonical(value)).unwrap_or_default();
                (key.clone(), Sha256::digest(bytes).into())
            })
            .collect()
    })
}

/// 相对基准正文的顶层差异：新增或修改的字段带完整值，删除的字段只记名字。
fn field_delta(base: &Fields, object: &serde_json::Map<String, Value>, fields: &Fields) -> Value {
    let mut set = serde_json::Map::new();
    for (key, hash) in fields {
        if base.get(key) != Some(hash) {
            set.insert(key.clone(), object[key].clone());
        }
    }
    let unset: Vec<&String> = base
        .keys()
        .filter(|key| !fields.contains_key(*key))
        .collect();
    json!({"set": set, "unset": unset})
}

#[derive(Clone)]
struct Sample(Arc<Mutex<SampleState>>);

struct SampleState {
    prefix: Vec<u8>,
    limit: usize,
    size: u64,
    digest: Sha256,
    complete: bool,
    error: Option<String>,
}

impl Sample {
    fn new(limit: usize) -> Self {
        Self(Arc::new(Mutex::new(SampleState {
            prefix: Vec::new(),
            limit,
            size: 0,
            digest: Sha256::new(),
            complete: false,
            error: None,
        })))
    }

    fn push(&self, bytes: &[u8]) {
        let mut state = lock(&self.0);
        let available = state
            .limit
            .saturating_sub(state.prefix.len())
            .min(bytes.len());
        state.prefix.extend_from_slice(&bytes[..available]);
        state.size = state.size.saturating_add(bytes.len() as u64);
        state.digest.update(bytes);
    }

    fn finish(&self, error: Option<String>) {
        let mut state = lock(&self.0);
        if state.complete || state.error.is_some() {
            return;
        }
        state.complete = error.is_none();
        state.error = error;
    }

    fn signature(&self) -> (u64, [u8; 32]) {
        let state = lock(&self.0);
        (state.size, state.digest.clone().finalize().into())
    }

    fn json(&self) -> Value {
        let state = lock(&self.0);
        let truncated = state.size > state.prefix.len() as u64;
        let (encoding, data) = if state.size == 0 {
            ("empty", Value::Null)
        } else if state.limit == 0 {
            ("omitted", Value::Null)
        } else if !truncated && serde_json::from_slice::<Value>(&state.prefix).is_ok() {
            (
                "json",
                serde_json::from_slice(&state.prefix).unwrap_or(Value::Null),
            )
        } else if !state.prefix.contains(&0) && std::str::from_utf8(&state.prefix).is_ok() {
            ("text", json!(String::from_utf8_lossy(&state.prefix)))
        } else {
            ("base64", json!(STANDARD.encode(&state.prefix)))
        };
        json!({"encoding":encoding,"size":state.size,"truncated":truncated,
            "complete":state.complete,"data":data})
    }

    fn error(&self) -> Option<String> {
        lock(&self.0).error.clone()
    }
}

fn sensitive_header(name: &str) -> bool {
    matches!(
        name,
        "authorization"
            | "proxy-authorization"
            | "x-api-key"
            | "api-key"
            | "x-goog-api-key"
            | "cookie"
            | "set-cookie"
    )
}

fn headers_json(headers: &HeaderMap) -> Value {
    let mut result = serde_json::Map::new();
    for name in headers.keys() {
        let values: Vec<Value> = headers
            .get_all(name)
            .iter()
            .map(|value| {
                if sensitive_header(name.as_str()) {
                    json!("[REDACTED]")
                } else {
                    json!(String::from_utf8_lossy(value.as_bytes()))
                }
            })
            .collect();
        result.insert(
            name.to_string(),
            if values.len() == 1 {
                values[0].clone()
            } else {
                json!(values)
            },
        );
    }
    Value::Object(result)
}

fn header_secrets(headers: &HeaderMap) -> Vec<String> {
    headers
        .iter()
        .filter(|(name, _)| sensitive_header(name.as_str()))
        .filter_map(|(_, value)| value.to_str().ok())
        .flat_map(|value| [value, value.strip_prefix("Bearer ").unwrap_or(value)])
        .filter(|value| value.len() >= 8)
        .map(str::to_string)
        .collect()
}

fn clean_url(raw: &str) -> String {
    let relative = raw.starts_with('/');
    let absolute = if relative {
        format!("http://local.invalid{raw}")
    } else {
        raw.to_string()
    };
    let Ok(mut url) = url::Url::parse(&absolute) else {
        return "[invalid URL]".into();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_fragment(None);
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(key, value)| {
            let normalized = key.to_ascii_lowercase().replace('-', "_");
            let value = if matches!(
                normalized.as_str(),
                "key"
                    | "api_key"
                    | "apikey"
                    | "token"
                    | "access_token"
                    | "refresh_token"
                    | "authorization"
                    | "signature"
                    | "sig"
            ) {
                "[REDACTED]".to_string()
            } else {
                value.into_owned()
            };
            (key.into_owned(), value)
        })
        .collect();
    if !pairs.is_empty() {
        url.query_pairs_mut().clear().extend_pairs(pairs);
    }
    if relative {
        url[url::Position::BeforePath..].to_string()
    } else {
        url.to_string()
    }
}

#[derive(Clone)]
struct RequestSample {
    method: String,
    url: String,
    raw_url_hash: [u8; 32],
    headers: Value,
    header_hash: [u8; 32],
    secrets: Vec<String>,
    body: Sample,
    model_hint: Option<String>,
    /// 完整正文的顶层字段摘要；非 JSON 对象时为 None。
    fields: Option<Fields>,
    /// 相对原始请求的差异编码；能放进上限时替代正文前缀。
    delta: Option<Value>,
}

impl RequestSample {
    fn new(method: &Method, url: &str, headers: &HeaderMap, limit: usize) -> Self {
        // Host、长度和逐跳头由宿主重建，不将这些必然发生的变化误判为脚本改写。
        let comparable: BTreeMap<_, Vec<_>> = headers
            .keys()
            .filter(|name| {
                !matches!(
                    name.as_str(),
                    "host" | "content-length" | "connection" | "transfer-encoding"
                )
            })
            .map(|name| {
                (
                    name.as_str(),
                    headers.get_all(name).iter().map(|v| v.as_bytes()).collect(),
                )
            })
            .collect();
        Self {
            method: method.to_string(),
            url: clean_url(url),
            raw_url_hash: Sha256::digest(url.as_bytes()).into(),
            headers: headers_json(headers),
            header_hash: Sha256::digest(serde_json::to_vec(&comparable).unwrap_or_default()).into(),
            secrets: header_secrets(headers),
            body: Sample::new(limit),
            model_hint: None,
            fields: None,
            delta: None,
        }
    }

    /// 上游请求的完整正文都在内存里：先算字段摘要和差异，再决定是否还要保存前缀。
    fn upstream(request: &UpstreamRequest, limit: usize, base: Option<&Fields>) -> Self {
        let parsed: Option<Value> = serde_json::from_slice(&request.body).ok();
        let fields = parsed.as_ref().and_then(fields_of);
        let delta = match (base, parsed.as_ref().and_then(Value::as_object), &fields) {
            (Some(base), Some(object), Some(fields)) if limit > 0 => {
                let data = field_delta(base, object, fields);
                serde_json::to_vec(&data)
                    .ok()
                    .filter(|bytes| bytes.len() <= limit)
                    .map(|_| {
                        json!({"encoding":"delta","base":"orig_body","size":request.body.len(),
                            "truncated":false,"complete":true,"data":data})
                    })
            }
            _ => None,
        };
        let prefix_limit = if delta.is_some() { 0 } else { limit };
        let mut sample = Self::new(
            &request.method,
            &request.url,
            &request.headers,
            prefix_limit,
        );
        sample.model_hint = parsed
            .as_ref()
            .and_then(|body| body.get("model"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                url::Url::parse(&request.url).ok().and_then(|url| {
                    super::handler_context::extract_gemini_model_from_path(url.path())
                })
            });
        sample.fields = fields;
        sample.delta = delta;
        sample.body.push(&request.body);
        sample.body.finish(None);
        sample
    }

    fn changed(&self, other: &Self) -> bool {
        self.method != other.method
            || self.raw_url_hash != other.raw_url_hash
            || self.header_hash != other.header_hash
            || self.body.signature() != other.body.signature()
    }

    fn body_json(&self) -> Value {
        self.delta.clone().unwrap_or_else(|| self.body.json())
    }

    fn model(&self) -> Option<String> {
        if self.model_hint.is_some() {
            return self.model_hint.clone();
        }
        let body = self.body.json();
        body.get("data")?.get("model")?.as_str().map(str::to_string)
    }
}

#[derive(Clone)]
struct ResponseSample {
    status: u16,
    headers: Value,
    body: Sample,
}

impl ResponseSample {
    fn new(status: u16, headers: &HeaderMap, limit: usize) -> Self {
        Self {
            status,
            headers: headers_json(headers),
            body: Sample::new(limit),
        }
    }
}

struct ForwardState {
    request: RequestSample,
    response: Option<ResponseSample>,
    error: Option<String>,
    started: Instant,
    header_ms: Option<u64>,
    duration_ms: Option<u64>,
}

struct ForwardTiming(Arc<Mutex<ForwardState>>);

impl ForwardTiming {
    fn finish(&self) {
        let mut state = lock(&self.0);
        if state.duration_ms.is_none() {
            state.duration_ms = Some(state.started.elapsed().as_millis() as u64);
            if state.response.is_none() && state.error.is_none() {
                state.error = Some("upstream request cancelled before response headers".into());
            }
        }
    }
}

impl Drop for ForwardTiming {
    fn drop(&mut self) {
        self.finish();
    }
}

struct AttemptState {
    app_type: String,
    provider_id: String,
    target: String,
    session_id: String,
    request_model: Option<String>,
    script_enabled: bool,
    script_used: bool,
    script_input: Option<RequestSample>,
    forwards: Vec<Arc<Mutex<ForwardState>>>,
    error: Option<String>,
}

#[derive(Clone)]
pub(crate) struct AttemptLog {
    state: Arc<Mutex<AttemptState>>,
    /// 整次客户端请求的原始正文字段摘要，所有差异编码都相对它计算。
    original: Arc<Mutex<Option<Fields>>>,
    limit: usize,
}

impl AttemptLog {
    fn base(&self) -> Option<Fields> {
        lock(&self.original).clone()
    }

    pub(crate) fn script_input(&self, request: &UpstreamRequest) {
        let base = self.base();
        lock(&self.state).script_input =
            Some(RequestSample::upstream(request, self.limit, base.as_ref()));
    }

    pub(crate) fn script_started(&self) {
        lock(&self.state).script_used = true;
    }

    pub(crate) fn failed(&self, error: &ProxyError) {
        lock(&self.state).error = Some(error.to_string());
    }

    fn start_forward(&self, request: &UpstreamRequest) -> Arc<Mutex<ForwardState>> {
        let base = self.base();
        let forward = Arc::new(Mutex::new(ForwardState {
            request: RequestSample::upstream(request, self.limit, base.as_ref()),
            response: None,
            error: None,
            started: Instant::now(),
            header_ms: None,
            duration_ms: None,
        }));
        lock(&self.state).forwards.push(forward.clone());
        forward
    }
}

/// 每次 next() 单独采样，脚本重试和并发调用不会覆盖上一条上游记录。
pub(crate) async fn send(
    transport: &super::upstream_transport::UpstreamTransport,
    request: UpstreamRequest,
    attempt: Option<&AttemptLog>,
) -> Result<ProxyResponse, ProxyError> {
    let forward = attempt.map(|log| log.start_forward(&request));
    let timing = forward.clone().map(ForwardTiming);
    let response = transport.send(request).await;
    let Some(forward) = forward else {
        return response;
    };
    match response {
        Ok(response) => {
            let status = response.status();
            let headers = response.headers().clone();
            let sample =
                ResponseSample::new(status.as_u16(), &headers, attempt.map_or(0, |a| a.limit));
            {
                let mut state = lock(&forward);
                state.header_ms = Some(state.started.elapsed().as_millis() as u64);
                state.response = Some(sample.clone());
            }
            let stream = ObservedStream {
                inner: Box::pin(response.bytes_stream()),
                sample: sample.body,
                ended: false,
                timing: timing.expect("a recorded forward has a timer"),
            };
            Ok(ProxyResponse::streamed(status, headers, stream))
        }
        Err(error) => {
            lock(&forward).error = Some(error.to_string());
            Err(error)
        }
    }
}

struct ObservedStream {
    inner: Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>,
    sample: Sample,
    ended: bool,
    timing: ForwardTiming,
}

impl Stream for ObservedStream {
    type Item = Result<Bytes, std::io::Error>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let result = self.inner.as_mut().poll_next(cx);
        match &result {
            Poll::Ready(Some(Ok(bytes))) => self.sample.push(bytes),
            Poll::Ready(Some(Err(error))) => {
                self.sample.finish(Some(error.to_string()));
                self.ended = true;
                self.timing.finish();
            }
            Poll::Ready(None) => {
                self.sample.finish(None);
                self.ended = true;
                self.timing.finish();
            }
            Poll::Pending => {}
        }
        result
    }
}

impl Drop for ObservedStream {
    fn drop(&mut self) {
        if !self.ended {
            self.sample
                .finish(Some("upstream body not fully consumed".into()));
        }
    }
}

struct TraceState {
    attempts: Vec<AttemptLog>,
    client: Option<ResponseSample>,
}

struct TraceInner {
    db: Arc<Database>,
    config: ProxyEventLogConfig,
    request_id: String,
    seq: u64,
    started_at: String,
    created_at: i64,
    start: Instant,
    original: RequestSample,
    /// 第一次进入转发器时的客户端正文字段摘要。
    original_fields: Arc<Mutex<Option<Fields>>>,
    state: Mutex<TraceState>,
}

#[derive(Clone)]
pub(crate) struct RequestTrace(Arc<TraceInner>);

impl RequestTrace {
    fn new(db: Arc<Database>, config: ProxyEventLogConfig, request: &Request) -> Self {
        Self(Arc::new(TraceInner {
            db,
            original: RequestSample::new(
                request.method(),
                &request.uri().to_string(),
                request.headers(),
                config.log_body_limit,
            ),
            config,
            request_id: uuid::Uuid::new_v4().to_string(),
            seq: SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1,
            started_at: local_time(),
            created_at: chrono::Utc::now().timestamp(),
            start: Instant::now(),
            original_fields: Arc::new(Mutex::new(None)),
            state: Mutex::new(TraceState {
                attempts: Vec::new(),
                client: None,
            }),
        }))
    }

    pub(crate) fn start_attempt(
        &self,
        app_type: &str,
        provider: &Provider,
        session_id: &str,
        request_model: Option<&str>,
        body: &Value,
    ) -> AttemptLog {
        {
            let mut original = lock(&self.0.original_fields);
            if original.is_none() {
                *original = fields_of(body);
            }
        }
        let attempt = AttemptLog {
            limit: self.0.config.log_body_limit,
            original: self.0.original_fields.clone(),
            state: Arc::new(Mutex::new(AttemptState {
                app_type: app_type.into(),
                provider_id: provider.id.clone(),
                target: provider.name.clone(),
                session_id: session_id.into(),
                script_enabled: provider.active_proxy_script().is_some(),
                request_model: request_model.map(str::to_string),
                script_used: false,
                script_input: None,
                forwards: Vec::new(),
                error: None,
            })),
        };
        lock(&self.0.state).attempts.push(attempt.clone());
        attempt
    }

    fn events(&self, finish_reason: &str) -> Vec<Value> {
        let state = lock(&self.0.state);
        let client = state.client.as_ref();
        let original_fields = lock(&self.0.original_fields).clone();
        let base = json!({
            "request_id":self.0.request_id,"run_at":RUN_AT.get_or_init(local_time),"seq":self.0.seq,
            "started_at":self.0.started_at,"created_at":self.0.created_at,"duration_ms":self.0.start.elapsed().as_millis() as u64,
            "method":self.0.original.method,"url":self.0.original.url,"request_model":self.0.original.model(),
            "orig_headers":self.0.original.headers,"orig_body":self.0.original.body.json(),
            "client_status":client.map(|r| r.status),"client_headers":client.map(|r| &r.headers),
            "client_body":client.map(|r| r.body.json()),"finish_reason":finish_reason,
            "attempt":0,"forward_seq":0,"script_enabled":false,"script_used":false,
            "request_changed":false,"route_changed":false,"target":"",
            "error":client.and_then(|r| r.body.error()),
        });
        let mut events = Vec::new();
        let mut secrets = self.0.original.secrets.clone();
        for (index, attempt) in state.attempts.iter().enumerate() {
            let attempt = lock(&attempt.state);
            let mut entry = base.clone();
            entry["attempt"] = json!(index + 1);
            entry["app_type"] = json!(attempt.app_type);
            entry["provider_id"] = json!(attempt.provider_id);
            entry["target"] = json!(attempt.target);
            entry["session_id"] = json!(attempt.session_id);
            entry["request_model"] = json!(attempt.request_model);
            entry["script_enabled"] = json!(attempt.script_enabled);
            entry["script_used"] = json!(attempt.script_used);
            if let Some(error) = &attempt.error {
                entry["error"] = json!(error);
            }
            if let Some(input) = &attempt.script_input {
                secrets.extend(input.secrets.clone());
                entry["script_url"] = json!(input.url);
                entry["script_headers"] = input.headers.clone();
                entry["script_body"] = input.body_json();
            }
            if attempt.forwards.is_empty() {
                events.push(entry);
                continue;
            }
            for (seq, forward) in attempt.forwards.iter().enumerate() {
                let forward = lock(forward);
                let mut event = entry.clone();
                secrets.extend(forward.request.secrets.clone());
                event["forward_seq"] = json!(seq + 1);
                event["upstream"] = json!(forward.request.url);
                event["fwd_url"] = json!(forward.request.url);
                event["fwd_method"] = json!(forward.request.method);
                event["fwd_headers"] = forward.request.headers.clone();
                // 脚本原样转发时正文与脚本输入逐字节相同，只记引用不重复保存。
                let same_as_input = attempt.script_input.as_ref().is_some_and(|input| {
                    input.body.signature() == forward.request.body.signature()
                });
                event["fwd_body"] = if same_as_input {
                    let size = forward.request.body.signature().0;
                    json!({"encoding":"same_as","ref":"script_body","size":size,"truncated":false,"complete":true,"data":Value::Null})
                } else {
                    forward.request.body_json()
                };
                event["model"] = json!(forward.request.model());
                event["upstream_header_ms"] = json!(forward.header_ms);
                event["upstream_duration_ms"] = json!(forward.duration_ms);
                if let Some(input) = &attempt.script_input {
                    event["request_changed"] =
                        json!(attempt.script_used && input.changed(&forward.request));
                    event["route_changed"] = json!(
                        attempt.script_used && input.raw_url_hash != forward.request.raw_url_hash
                    );
                }
                event["mods"] = modifications(
                    &self.0.original.headers,
                    &forward.request.headers,
                    original_fields.as_ref(),
                    forward.request.fields.as_ref(),
                );
                if let Some(error) = &forward.error {
                    event["error"] = json!(error);
                }
                if let Some(response) = &forward.response {
                    event["status"] = json!(response.status);
                    event["resp_headers"] = response.headers.clone();
                    event["resp_body"] = response.body.json();
                    event["total_bytes"] = json!(response.body.signature().0);
                    event["stream_error"] = json!(response.body.error());
                    if let Some(client) = client {
                        let same_body = client.body.signature() == response.body.signature();
                        if same_body
                            && client.body.json()["complete"] == true
                            && response.body.json()["complete"] == true
                        {
                            event["client_body"]["encoding"] = json!("forwarded");
                            event["client_body"]["data"] = Value::Null;
                        }
                        if !same_body || client.status != response.status {
                            event["rewritten"] =
                                json!("client response differs from this upstream response");
                        }
                    }
                }
                events.push(event);
            }
        }
        if events.is_empty() {
            let mut event = base;
            let original = &self.0.original;
            event["app_type"] = json!(guess_app(&original.url, &original.headers));
            events.push(event);
        }
        secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
        secrets.dedup();
        for event in &mut events {
            redact_values(event, &secrets);
        }
        events
    }
}

/// 未进入转发的请求没有 attempt，按路径前缀和 UA 推断发起方。
fn guess_app(url: &str, headers: &Value) -> Option<&'static str> {
    let path = url.split('?').next().unwrap_or(url);
    let by_path = [
        ("/claude-desktop/", "claude-desktop"),
        ("/claude/", "claude"),
        ("/codex/", "codex"),
        ("/grokbuild/", "grokbuild"),
        ("/gemini/", "gemini"),
        ("/v1beta/", "gemini"),
    ];
    if let Some((_, app)) = by_path.iter().find(|(prefix, _)| path.starts_with(prefix)) {
        return Some(app);
    }
    let header = |name: &str| headers[name].as_str().unwrap_or("").to_ascii_lowercase();
    let ua = header("user-agent");
    let originator = header("originator");
    if ua.starts_with("claude-cli/") || ua.contains("claude-code") {
        Some("claude")
    } else if ua.starts_with("codex_") || originator.starts_with("codex_") {
        Some("codex")
    } else if ua.starts_with("geminicli/") || ua.contains("gemini-cli") {
        Some("gemini")
    } else {
        None
    }
}

fn redact_values(value: &mut Value, secrets: &[String]) {
    match value {
        Value::String(value) => {
            for secret in secrets {
                *value = value.replace(secret, "[REDACTED]");
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                redact_values(value, secrets);
            }
        }
        Value::Array(values) => {
            for value in values {
                redact_values(value, secrets);
            }
        }
        _ => {}
    }
}

/// 原始请求与转发请求的顶层字段变化；字段摘要来自完整正文，与采样截断无关。
fn modifications(
    before_headers: &Value,
    after_headers: &Value,
    before: Option<&Fields>,
    after: Option<&Fields>,
) -> Value {
    let betas = |headers: &Value| -> Vec<String> {
        let values = match &headers["anthropic-beta"] {
            Value::String(value) => vec![value.as_str()],
            Value::Array(values) => values.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        values
            .into_iter()
            .flat_map(|value| value.split(','))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect()
    };
    let after_betas = betas(after_headers);
    let dropped_beta: Vec<_> = betas(before_headers)
        .into_iter()
        .filter(|beta| !after_betas.contains(beta))
        .collect();
    let mut removed = Vec::new();
    let mut added = Vec::new();
    let mut changed = Vec::new();
    if let (Some(before), Some(after)) = (before, after) {
        for (key, hash) in before {
            match after.get(key) {
                None => removed.push(key),
                Some(other) if other != hash => changed.push(key),
                Some(_) => {}
            }
        }
        for key in after.keys() {
            if !before.contains_key(key) {
                added.push(key);
            }
        }
    }
    json!({"dropped_beta":dropped_beta,"stripped_fields":removed,"injected_fields":added,"changed_fields":changed,
        "diff_unavailable":before.is_none() || after.is_none()})
}

/// 根 guard 在响应读取完毕或客户端中断时提交一次；未轮询响应也不会漏掉日志。
struct TraceGuard(Option<RequestTrace>);

impl TraceGuard {
    fn finish(&mut self, reason: &str) {
        let Some(trace) = self.0.take() else {
            return;
        };
        let reason = reason.to_string();
        let save = move || {
            let events = trace.events(&reason);
            if let Err(error) = trace.0.db.save_proxy_events(&events) {
                log::warn!("详细代理日志写入失败: {error}");
            }
        };
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn_blocking(save);
        } else {
            save();
        }
    }
}

impl Drop for TraceGuard {
    fn drop(&mut self) {
        self.finish("cancelled");
    }
}

struct ObservedBody {
    inner: Body,
    sample: Sample,
    guard: Option<TraceGuard>,
    ended: bool,
}

impl ObservedBody {
    fn wrap(inner: Body, sample: Sample, guard: Option<TraceGuard>) -> Body {
        let mut observed = Self {
            inner,
            sample,
            guard,
            ended: false,
        };
        if observed.inner.is_end_stream() {
            observed.finish(None);
        }
        Body::new(observed)
    }

    fn finish(&mut self, error: Option<String>) {
        if self.ended {
            return;
        }
        self.ended = true;
        let reason = if error.is_some() {
            "stream_error"
        } else {
            "completed"
        };
        self.sample.finish(error);
        if let Some(guard) = &mut self.guard {
            guard.finish(reason);
        }
    }
}

impl HttpBody for ObservedBody {
    type Data = Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let result = Pin::new(&mut self.inner).poll_frame(cx);
        match &result {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    self.sample.push(data);
                }
                if self.inner.is_end_stream() {
                    self.finish(None);
                }
            }
            Poll::Ready(Some(Err(error))) => self.finish(Some(error.to_string())),
            Poll::Ready(None) => self.finish(None),
            Poll::Pending => {}
        }
        result
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl Drop for ObservedBody {
    fn drop(&mut self) {
        if !self.ended {
            self.sample.finish(Some("body not fully consumed".into()));
            if let Some(guard) = &mut self.guard {
                guard.finish("cancelled");
            }
        }
    }
}

pub(crate) async fn middleware(
    State(state): State<ProxyState>,
    request: Request,
    next: Next,
) -> Response {
    if matches!(request.uri().path(), "/health" | "/status")
        || !state.config.read().await.enable_logging
    {
        return next.run(request).await;
    }
    // 配置由保存命令推送到内存副本，热路径不碰数据库锁。
    let config = state.event_log.read().await.clone();
    if !config.enabled {
        return next.run(request).await;
    }
    let trace = RequestTrace::new(state.db.clone(), config, &request);
    let guard = TraceGuard(Some(trace.clone()));
    let (mut parts, body) = request.into_parts();
    parts.extensions.insert(trace.clone());
    let request = Request::from_parts(
        parts,
        ObservedBody::wrap(body, trace.0.original.body.clone(), None),
    );
    let response = next.run(request).await;
    let sample = ResponseSample::new(
        response.status().as_u16(),
        response.headers(),
        trace.0.config.log_body_limit,
    );
    lock(&trace.0.state).client = Some(sample.clone());
    response.map(|body| ObservedBody::wrap(body, sample.body, Some(guard)))
}

#[cfg(test)]
#[path = "event_log_tests.rs"]
mod tests;
