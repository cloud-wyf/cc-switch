use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

fn request() -> ScriptRequest {
    ScriptRequest {
        url: "https://upstream.invalid/v1/messages".into(),
        method: "POST".into(),
        headers: vec![("content-type".into(), "application/json".into())],
        body: STANDARD.encode(br#"{"model":"test","max_tokens":100}"#),
    }
}

async fn run(source: &str, transport: Transport) -> Result<ProxyResponse, ProxyError> {
    execute(
        source,
        request(),
        json!({"providerId":"test-provider"}),
        transport,
        Duration::from_secs(10),
    )
    .await
}

fn unused_transport() -> Transport {
    Arc::new(|_| Box::pin(async { panic!("a synthetic response must not contact an upstream") }))
}

async fn json_body(response: ProxyResponse) -> Value {
    serde_json::from_slice(&response.bytes_with_limit(1024 * 1024).await.unwrap()).unwrap()
}

#[tokio::test]
async fn syntax_validation_never_executes_user_code() {
    validate("throw new Error('must not execute'); export default () => new Response('ok');")
        .await
        .unwrap();
    assert!(validate("export default function (").await.is_err());
    assert!(
        validate("import './local-file.js'; export default () => new Response();")
            .await
            .unwrap_err()
            .contains("单文件")
    );
}

#[tokio::test]
async fn local_response_supports_typescript_and_provider_context() {
    let response = run(r#"
        enum Code { Created = 201 }
        export default function (_request: Request, _next: unknown, context: { providerId: string }): Response {
            return Response.json({ provider: context.providerId }, { status: Code.Created });
        }
    "#, unused_transport()).await.unwrap();
    assert_eq!(response.status(), http::StatusCode::CREATED);
    assert_eq!(json_body(response).await["provider"], "test-provider");
}

#[tokio::test]
async fn rewrites_request_and_response_through_native_next() {
    let called = Arc::new(AtomicUsize::new(0));
    let observed = called.clone();
    let transport: Transport = Arc::new(move |request| {
        observed.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            assert_eq!(request.url, "https://alternate.invalid/v1/messages");
            assert!(request.headers.contains(&("x-script".into(), "yes".into())));
            let body: Value =
                serde_json::from_slice(&STANDARD.decode(request.body).unwrap()).unwrap();
            assert_eq!(body["model"], "rewritten");
            Ok(ProxyResponse::buffered(
                http::StatusCode::OK,
                http::HeaderMap::new(),
                Bytes::from_static(br#"{"answer":42}"#),
            ))
        })
    });
    let response = run(r#"
        export default async function (request: Request, next: (request: Request) => Promise<Response>) {
            const body = await request.json();
            body.model = 'rewritten';
            const headers = new Headers(request.headers);
            headers.set('x-script', 'yes');
            const response = await next(new Request('https://alternate.invalid/v1/messages', {
                method: 'POST', headers, body: JSON.stringify(body),
            }));
            return Response.json({ ...(await response.json()), changed: true }, { status: 202 });
        }
    "#, transport).await.unwrap();
    assert_eq!(response.status(), http::StatusCode::ACCEPTED);
    assert_eq!(
        json_body(response).await,
        json!({"answer":42, "changed":true})
    );
    assert_eq!(called.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_script_can_retry_and_replace_an_empty_success() {
    let called = Arc::new(AtomicUsize::new(0));
    let observed = called.clone();
    let transport: Transport = Arc::new(move |_| {
        let attempt = observed.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            Ok(ProxyResponse::buffered(
                if attempt == 0 {
                    http::StatusCode::TOO_MANY_REQUESTS
                } else {
                    http::StatusCode::OK
                },
                http::HeaderMap::new(),
                Bytes::new(),
            ))
        })
    });
    let response = run(
        r#"
        export default async function (request, next) {
            let response = await next();
            if (response.status === 429) {
                await response.body?.cancel();
                response = await next();
            }
            if ((await response.arrayBuffer()).byteLength === 0) {
                return Response.json({ error: 'empty upstream response' }, { status: 502 });
            }
            return response;
        }
    "#,
        transport,
    )
    .await
    .unwrap();
    assert_eq!(response.status(), http::StatusCode::BAD_GATEWAY);
    assert_eq!(called.load(Ordering::SeqCst), 2);
    assert_eq!(
        json_body(response).await["error"],
        "empty upstream response"
    );
}

struct DropSignal(Option<oneshot::Sender<()>>);
impl Drop for DropSignal {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}

#[tokio::test]
async fn streaming_is_incremental_and_cancellation_drops_upstream() {
    let (dropped_tx, dropped_rx) = oneshot::channel();
    let dropped = Arc::new(std::sync::Mutex::new(Some(dropped_tx)));
    let transport: Transport = Arc::new(move |_| {
        let guard = DropSignal(dropped.lock().unwrap().take());
        Box::pin(async move {
            let stream = async_stream::stream! {
                let _guard = guard;
                yield Ok(Bytes::from_static(b"data: first\n\n"));
                std::future::pending::<()>().await;
            };
            Ok(ProxyResponse::streamed(
                http::StatusCode::OK,
                http::HeaderMap::new(),
                stream,
            ))
        })
    });
    let response = run(
        "export default async (_request, next) => next();",
        transport,
    )
    .await
    .unwrap();
    let mut stream = Box::pin(response.bytes_stream());
    let first = tokio::time::timeout(Duration::from_secs(2), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(first, Bytes::from_static(b"data: first\n\n"));
    drop(stream);
    tokio::time::timeout(Duration::from_secs(2), dropped_rx)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn next_decodes_compressed_responses_for_script_json_access() {
    use std::io::Write;
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(br#"{"compressed":true}"#).unwrap();
    let bytes = Bytes::from(encoder.finish().unwrap());
    let transport: Transport = Arc::new(move |_| {
        let bytes = bytes.clone();
        Box::pin(async move {
            let mut headers = http::HeaderMap::new();
            headers.insert("content-encoding", http::HeaderValue::from_static("gzip"));
            Ok(ProxyResponse::buffered(
                http::StatusCode::OK,
                headers,
                bytes,
            ))
        })
    });
    let response = run(
        "export default async (_request, next) => Response.json(await (await next()).json());",
        transport,
    )
    .await
    .unwrap();
    assert_eq!(json_body(response).await, json!({"compressed":true}));
}

#[tokio::test]
async fn script_errors_are_explicit_and_network_errors_remain_retryable() {
    let error = run(
        "export default () => { throw new Error('broken script'); };",
        unused_transport(),
    )
    .await
    .err()
    .unwrap();
    assert!(matches!(error, ProxyError::ScriptError(_)));
    assert!(error.to_string().contains("broken script"));
    assert!(!error.to_string().contains("data:text/javascript;base64"));
    let transport: Transport = Arc::new(|_| {
        Box::pin(async { Err(ProxyError::ForwardFailed("connection refused".into())) })
    });
    let error = run("export default (_request, next) => next();", transport)
        .await
        .err()
        .unwrap();
    assert!(matches!(error, ProxyError::ForwardFailed(_)));
}

#[tokio::test]
async fn invalid_return_values_and_non_terminating_scripts_fail() {
    let error = run("export default () => ({status:200});", unused_transport())
        .await
        .err()
        .unwrap();
    assert!(error.to_string().contains("Response"));
    let error = execute(
        "export default () => { while (true) {} };",
        request(),
        json!({}),
        unused_transport(),
        Duration::from_millis(700),
    )
    .await
    .err()
    .unwrap();
    assert!(matches!(error, ProxyError::ScriptError(_)));
}

#[tokio::test]
async fn binary_response_bytes_survive_chunked_process_transport() {
    let response = run(
        "export default () => new Response(Uint8Array.from({length: 200000}, (_, i) => i % 251));",
        unused_transport(),
    )
    .await
    .unwrap();
    let bytes = response.bytes_with_limit(300000).await.unwrap();
    assert_eq!(bytes.len(), 200000);
    assert!(bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| *byte == (index % 251) as u8));
}

#[tokio::test]
async fn shipped_compatibility_example_patches_beta_thinking_and_empty_response() {
    let source = include_str!("../../../docs/examples/anthropic-compatibility-middleware.ts");
    let mut input = request();
    input.body = STANDARD.encode(
        serde_json::to_vec(&json!({"model":"test", "max_tokens":4096, "messages":[]})).unwrap(),
    );
    input.headers.push((
        "anthropic-beta".into(),
        "context-1m-2025-08-07,structured-outputs-2025-12-15".into(),
    ));
    let transport: Transport = Arc::new(|request| {
        Box::pin(async move {
            let body: Value =
                serde_json::from_slice(&STANDARD.decode(request.body).unwrap()).unwrap();
            assert_eq!(
                body["thinking"],
                json!({"type":"enabled", "budget_tokens":1024})
            );
            assert!(request
                .headers
                .contains(&("anthropic-beta".into(), "context-1m-2025-08-07".into())));
            Ok(ProxyResponse::buffered(
                http::StatusCode::OK,
                http::HeaderMap::new(),
                Bytes::new(),
            ))
        })
    });
    let response = execute(source, input, json!({}), transport, Duration::from_secs(10))
        .await
        .unwrap();
    assert_eq!(response.status(), http::StatusCode::BAD_GATEWAY);
    assert_eq!(json_body(response).await["error"]["type"], "api_error");
}

#[tokio::test]
async fn validation_results_are_cached_by_source_digest() {
    let source = "export default (_request, next) => next(); // digest-cache";
    validate(source).await.unwrap();
    assert!(is_validated(&source_digest(source)));
    // 缓存命中不再启动 Node：即便进程槽全部被占用也立即返回。
    let permits = PROCESS_SLOTS.acquire_many(16).await.unwrap();
    validate(source).await.unwrap();
    drop(permits);
    let broken = "export default (";
    assert!(!is_validated(&source_digest(broken)));
    assert!(validate(broken).await.is_err());
    assert!(!is_validated(&source_digest(broken)));
}
