use super::*;
use crate::provider::ProviderMeta;
use crate::proxy::{server::ProxyServer, ProxyConfig};
use axum::{
    routing::{any, post},
    Router,
};
use futures::StreamExt;
use http_body_util::BodyExt;
use rusqlite::types::ValueRef;
use std::time::Duration;

/// 有些既有路由/同步代码会读写 settings.json，拒绝误指向真实用户目录。
fn require_isolated_home() {
    assert_ne!(
        Some(crate::config::get_home_dir()),
        dirs::home_dir(),
        "Proxy event tests must run in an isolated home directory"
    );
}

fn rows(db: &Database) -> Vec<Value> {
    let conn = db.conn.lock().unwrap();
    let mut statement = conn
        .prepare("SELECT * FROM proxy_request_events ORDER BY id")
        .unwrap();
    let names: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_string)
        .collect();
    statement
        .query_map([], |row| {
            let mut values = serde_json::Map::new();
            for (index, name) in names.iter().enumerate() {
                let value = match row.get_ref(index)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(value) => json!(value),
                    ValueRef::Real(value) => json!(value),
                    ValueRef::Text(value) => {
                        let text = String::from_utf8_lossy(value);
                        if name.ends_with("_headers") || name.ends_with("_body") || name == "mods" {
                            serde_json::from_str(&text).unwrap_or_else(|_| json!(text))
                        } else {
                            json!(text)
                        }
                    }
                    ValueRef::Blob(_) => panic!("event fields should not be blobs"),
                };
                values.insert(name.clone(), value);
            }
            Ok(Value::Object(values))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

async fn wait_rows(db: &Database, count: usize) -> Vec<Value> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let events = rows(db);
            if events.len() >= count {
                return events;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("event writer finished")
}

async fn mock_server(app: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{address}"), task)
}

fn native_response(model: &str) -> Value {
    json!({"id":"event-test-response","object":"response","status":"completed","model":model,
        "output":[],"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}})
}

async fn native_upstream(request: Request) -> axum::Json<Value> {
    let bytes = axum::body::to_bytes(request.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    axum::Json(native_response(body["model"].as_str().unwrap_or("unknown")))
}

fn provider(id: &str, upstream: &str, script: Option<&str>, enabled: bool) -> Provider {
    let mut provider = Provider::with_id(
        id.into(),
        format!("Provider {id}"),
        json!({
            "base_url":format!("{upstream}/v1"), "auth":{"OPENAI_API_KEY":"upstream-private-key"}
        }),
        None,
    );
    provider.meta = Some(ProviderMeta {
        local_proxy_script: script.map(str::to_string),
        local_proxy_script_enabled: Some(enabled),
        ..Default::default()
    });
    provider
}

async fn proxy(db: Arc<Database>, provider: &Provider) -> (ProxyServer, String) {
    require_isolated_home();
    db.save_provider("codex", provider).unwrap();
    db.set_current_provider("codex", &provider.id).unwrap();
    let proxy = ProxyServer::new(
        ProxyConfig {
            listen_port: 0,
            ..Default::default()
        },
        db,
        None,
    );
    let address = proxy.start().await.unwrap();
    (proxy, format!("http://127.0.0.1:{}", address.port))
}

async fn post_request(url: &str) -> reqwest::Response {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .post(format!("{url}/v1/responses"))
        .header("authorization", "Bearer client-private-key")
        .json(&json!({"model":"original-model","input":"name this task","stream":false}))
        .send()
        .await
        .unwrap()
}

#[test]
fn migration_from_v18_keeps_data_and_leaves_no_events_table_in_main() {
    // 主库迁移不依赖附加库：备份恢复和 SQL 导入的暂存连接上没有 events。
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE existing_data (value TEXT); INSERT INTO existing_data VALUES ('keep'); PRAGMA user_version = 18;").unwrap();
    Database::apply_schema_migrations_on_conn(&conn).unwrap();
    Database::apply_schema_migrations_on_conn(&conn).unwrap();
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i32>(0))
            .unwrap(),
        crate::database::SCHEMA_VERSION
    );
    assert_eq!(
        conn.query_row("SELECT value FROM existing_data", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "keep"
    );
    let legacy_tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM main.sqlite_master WHERE name = 'proxy_request_events'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(legacy_tables, 0);
    // 附加库里的表由 Database 打开时创建，与主库版本无关。
    let db = Database::memory().unwrap();
    db.conn.lock().unwrap().prepare("SELECT script_used, request_changed, route_changed, orig_body, fwd_body, resp_body, client_body FROM events.proxy_request_events").unwrap();
}

#[test]
fn body_limit_bounds_storage_and_retains_true_size_and_binary_data() {
    let sample = Sample::new(8);
    sample.push(b"1234567890");
    sample.push(b"abcdef");
    sample.finish(None);
    assert_eq!(
        sample.json(),
        json!({"encoding":"text","size":16,"truncated":true,"complete":true,"data":"12345678"})
    );
    assert_eq!(lock(&sample.0).prefix.len(), 8);
    let binary = Sample::new(100);
    binary.push(&[0, 255, 1]);
    binary.finish(None);
    assert_eq!(binary.json()["encoding"], "base64");
    assert_eq!(
        STANDARD
            .decode(binary.json()["data"].as_str().unwrap())
            .unwrap(),
        vec![0, 255, 1]
    );
    let omitted = Sample::new(0);
    omitted.push(b"sensitive body");
    assert_eq!(omitted.json()["encoding"], "omitted");
    assert_eq!(omitted.json()["data"], Value::Null);
    assert_eq!(omitted.json()["size"], 14);
}

#[test]
fn secret_url_parameters_and_legacy_modification_fields_are_preserved_safely() {
    let cleaned = clean_url(
        "https://user:password@example.com/v1/responses?key=secret-query&api-version=stable",
    );
    assert!(!cleaned.contains("password"));
    assert!(!cleaned.contains("secret-query"));
    assert!(cleaned.contains("api-version=stable"));
    let original = UpstreamRequest {
        url: "https://example.com/v1/messages".into(),
        method: Method::POST,
        headers: [(
            "anthropic-beta".parse().unwrap(),
            "keep,drop".parse().unwrap(),
        )]
        .into_iter()
        .collect(),
        body: br#"{"model":"old","remove_me":true}"#.to_vec(),
    };
    let modified = UpstreamRequest {
        url: original.url.clone(),
        method: Method::POST,
        headers: [("anthropic-beta".parse().unwrap(), "keep".parse().unwrap())]
            .into_iter()
            .collect(),
        body: br#"{"model":"new","thinking":{"type":"disabled"}}"#.to_vec(),
    };
    let before = RequestSample::upstream(&original, 65536, None);
    let after = RequestSample::upstream(&modified, 65536, None);
    let diff = modifications(
        &before.headers,
        &after.headers,
        before.fields.as_ref(),
        after.fields.as_ref(),
    );
    assert_eq!(diff["dropped_beta"], json!(["drop"]));
    assert_eq!(diff["stripped_fields"], json!(["remove_me"]));
    assert_eq!(diff["injected_fields"], json!(["thinking"]));
    assert_eq!(diff["changed_fields"], json!(["model"]));
    assert_eq!(diff["diff_unavailable"], false);

    // 差异编码只存相对原始请求变化的顶层字段；放不进上限时退回保存前缀。
    let compact = RequestSample::upstream(&modified, 65536, before.fields.as_ref());
    assert_eq!(compact.body_json()["encoding"], "delta");
    assert_eq!(compact.body_json()["size"], modified.body.len());
    assert_eq!(
        compact.body_json()["data"],
        json!({"set":{"model":"new","thinking":{"type":"disabled"}},"unset":["remove_me"]})
    );
    let too_large = RequestSample::upstream(&modified, 8, before.fields.as_ref());
    assert_eq!(too_large.body_json()["encoding"], "text");
    assert_eq!(too_large.body_json()["truncated"], true);
    let text = UpstreamRequest {
        url: original.url.clone(),
        method: Method::POST,
        headers: HeaderMap::new(),
        body: b"plain text".to_vec(),
    };
    let unparsed = RequestSample::upstream(&text, 65536, before.fields.as_ref());
    assert_eq!(unparsed.body_json()["encoding"], "text");
    assert_eq!(
        modifications(
            &Value::Null,
            &Value::Null,
            before.fields.as_ref(),
            unparsed.fields.as_ref()
        )["diff_unavailable"],
        true
    );
}

#[tokio::test]
async fn body_limit_updates_apply_without_restarting_and_keep_the_actual_model() {
    let (upstream, server) =
        mock_server(Router::new().route("/v1/responses", post(native_upstream))).await;
    let db = Arc::new(Database::memory().unwrap());
    let (proxy, url) = proxy(db.clone(), &provider("large", &upstream, None, false)).await;
    for (index, limit) in [65536, 128 * 1024, 0].into_iter().enumerate() {
        let config = ProxyEventLogConfig {
            log_body_limit: limit,
            ..Default::default()
        };
        db.set_proxy_event_log_config(&config).unwrap();
        // 保存命令会把新配置推给运行中的服务器，请求路径不再每次读数据库。
        proxy.apply_event_log_config(config).await;
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .post(format!("{url}/v1/responses"))
            .json(&json!({"model":"original-model","input":"x".repeat(80_000)}))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.json::<Value>().await.unwrap()["model"],
            "original-model"
        );
        let events = wait_rows(&db, index + 1).await;
        let event = &events[index];
        assert_eq!(event["model"], "original-model");
        assert_eq!(event["request_model"], "original-model");
        assert_eq!(event["orig_body"]["truncated"], limit < 80_000);
        assert!(event["fwd_body"]["size"].as_u64().unwrap() > 80_000);
        assert!(event["upstream_header_ms"].is_number());
        assert!(event["upstream_duration_ms"].is_number());
        if limit == 0 {
            assert_eq!(event["fwd_body"]["encoding"], "omitted");
        } else {
            // 转发正文只记相对原始请求的差异，不再重复保存 80 KB 的前缀。
            assert_eq!(event["fwd_body"]["encoding"], "delta");
            assert_eq!(event["fwd_body"]["truncated"], false);
            assert!(event["fwd_body"]["data"]["set"].get("input").is_none());
        }
        assert!(event["script_body"].is_null(), "no script ran: {event:#}");
    }
    proxy.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn failover_records_each_provider_and_its_own_script_flag() {
    let (bad, bad_server) = mock_server(Router::new().route(
        "/v1/responses",
        post(|| async {
            (
                http::StatusCode::SERVICE_UNAVAILABLE,
                axum::Json(json!({"error":"temporary outage"})),
            )
        }),
    ))
    .await;
    let (good, good_server) =
        mock_server(Router::new().route("/v1/responses", post(native_upstream))).await;
    let db = Arc::new(Database::memory().unwrap());
    let mut first = provider(
        "first",
        &bad,
        Some("export default (_,next) => next();"),
        true,
    );
    first.sort_index = Some(0);
    let mut second = provider("second", &good, None, false);
    second.sort_index = Some(1);
    let (proxy, url) = proxy(db.clone(), &first).await;
    db.save_provider("codex", &second).unwrap();
    db.add_to_failover_queue("codex", "first").unwrap();
    db.add_to_failover_queue("codex", "second").unwrap();
    let mut config = db.get_proxy_config_for_app("codex").await.unwrap();
    config.auto_failover_enabled = true;
    config.max_retries = 1;
    db.update_proxy_config_for_app(config).await.unwrap();
    assert_eq!(
        post_request(&url).await.json::<Value>().await.unwrap()["model"],
        "original-model"
    );
    let events = wait_rows(&db, 2).await;
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["request_id"], events[1]["request_id"]);
    assert_eq!(events[0]["provider_id"], "first");
    assert_eq!(events[0]["script_used"], 1);
    assert_eq!(events[0]["attempt"], 1);
    assert_eq!(events[0]["status"], 503);
    assert_eq!(events[1]["provider_id"], "second");
    assert_eq!(events[1]["script_used"], 0);
    assert_eq!(events[1]["attempt"], 2);
    assert_eq!(events[1]["status"], 200);
    proxy.stop().await.unwrap();
    bad_server.abort();
    good_server.abort();
}

#[tokio::test]
async fn gzip_upstream_is_logged_before_script_decompression() {
    use std::io::Write;
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder
        .write_all(native_response("gzip-model").to_string().as_bytes())
        .unwrap();
    let compressed = encoder.finish().unwrap();
    let app = Router::new().route(
        "/v1/responses",
        post(move || {
            let bytes = compressed.clone();
            async move {
                Response::builder()
                    .header("content-type", "application/json")
                    .header("content-encoding", "gzip")
                    .body(Body::from(bytes))
                    .unwrap()
            }
        }),
    );
    let (upstream, server) = mock_server(app).await;
    let db = Arc::new(Database::memory().unwrap());
    let (proxy, url) = proxy(
        db.clone(),
        &provider(
            "gzip",
            &upstream,
            Some("export default (_,next) => next();"),
            true,
        ),
    )
    .await;
    assert_eq!(
        post_request(&url).await.json::<Value>().await.unwrap()["model"],
        "gzip-model"
    );
    let events = wait_rows(&db, 1).await;
    assert_eq!(events[0]["resp_headers"]["content-encoding"], "gzip");
    assert_eq!(events[0]["resp_body"]["encoding"], "base64");
    assert_eq!(events[0]["client_body"]["data"]["model"], "gzip-model");
    proxy.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn body_observer_preserves_trailers_and_records_unread_cancellation() {
    let trailers: HeaderMap = [("x-trailer".parse().unwrap(), "value".parse().unwrap())]
        .into_iter()
        .collect();
    let body = Body::new(http_body_util::StreamBody::new(futures::stream::iter([
        Ok::<_, std::io::Error>(Frame::data(Bytes::from_static(b"hello"))),
        Ok(Frame::trailers(trailers.clone())),
    ])));
    let sample = Sample::new(100);
    let collected = ObservedBody::wrap(body, sample.clone(), None)
        .collect()
        .await
        .unwrap();
    assert_eq!(collected.trailers(), Some(&trailers));
    assert_eq!(collected.to_bytes(), Bytes::from_static(b"hello"));
    assert_eq!(sample.json()["complete"], true);
    let cancelled = Sample::new(100);
    drop(ObservedBody::wrap(
        Body::from("unread"),
        cancelled.clone(),
        None,
    ));
    assert_eq!(cancelled.json()["complete"], false);
    assert!(cancelled.error().is_some());
}

#[tokio::test]
async fn requests_without_active_script_keep_four_phases_and_redact_credentials() {
    let (upstream, server) =
        mock_server(Router::new().route("/v1/responses", post(native_upstream))).await;
    for (id, script, enabled) in [
        ("none", None, false),
        (
            "disabled",
            Some("export default () => { throw new Error('must not execute'); }"),
            false,
        ),
        (
            "pass",
            Some("export default (_request, next) => next();"),
            true,
        ),
    ] {
        let db = Arc::new(Database::memory().unwrap());
        let (proxy, url) = proxy(db.clone(), &provider(id, &upstream, script, enabled)).await;
        let response = post_request(&url).await;
        assert!(response.status().is_success());
        let expected = response.json::<Value>().await.unwrap();
        let events = wait_rows(&db, 1).await;
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event["app_type"], "codex");
        assert_eq!(event["provider_id"], id);
        assert_eq!(event["script_used"], i32::from(enabled));
        assert_eq!(event["request_changed"], 0, "{event:#}");
        assert_eq!(event["route_changed"], 0);
        assert_eq!(event["orig_body"]["data"]["input"], "name this task");
        assert_eq!(event["model"], "original-model");
        if enabled {
            // 脚本原样转发：脚本输入是差异编码，转发正文只引用脚本输入。
            assert_eq!(event["script_body"]["encoding"], "delta");
            assert_eq!(event["fwd_body"]["encoding"], "same_as");
            assert_eq!(event["fwd_body"]["ref"], "script_body");
        } else {
            assert!(event["script_body"].is_null(), "{event:#}");
            assert_eq!(event["fwd_body"]["encoding"], "delta");
            assert!(event["fwd_body"]["data"]["set"].get("model").is_none());
        }
        assert_eq!(event["mods"]["changed_fields"], json!([]));
        assert_eq!(event["mods"]["diff_unavailable"], false);
        assert_eq!(event["resp_body"]["data"], expected);
        assert_eq!(event["client_body"]["encoding"], "forwarded");
        assert_eq!(event["orig_headers"]["authorization"], "[REDACTED]");
        assert!(!event.to_string().contains("client-private-key"));
        assert!(!event.to_string().contains("upstream-private-key"));
        proxy.stop().await.unwrap();
    }
    server.abort();
}

#[tokio::test]
async fn script_routing_and_response_rewrite_are_recorded_separately() {
    let (upstream, server) =
        mock_server(Router::new().route("/alternate/responses", post(native_upstream))).await;
    let script = r#"export default async (request, next) => {
        const body = await request.json(); body.model = 'deepseek-test';
        const headers = new Headers(request.headers); headers.set('authorization','Bearer script-private-key');
        const response = await next(new Request('__UPSTREAM__/alternate/responses', {method:'POST',headers,body:JSON.stringify(body)}));
        return Response.json({...await response.json(), rewritten:true}, {status:201});
    }"#.replace("__UPSTREAM__", &upstream);
    let db = Arc::new(Database::memory().unwrap());
    let (proxy, url) = proxy(
        db.clone(),
        &provider("script", &upstream, Some(&script), true),
    )
    .await;
    let response = post_request(&url).await;
    assert_eq!(response.status().as_u16(), 201);
    assert_eq!(response.json::<Value>().await.unwrap()["rewritten"], true);
    let events = wait_rows(&db, 1).await;
    let event = &events[0];
    assert_eq!(event["script_enabled"], 1);
    assert_eq!(event["script_used"], 1);
    assert_eq!(event["request_changed"], 1);
    assert_eq!(event["route_changed"], 1);
    assert_eq!(event["request_model"], "original-model");
    assert_eq!(event["model"], "deepseek-test");
    assert!(event["script_url"]
        .as_str()
        .unwrap()
        .ends_with("/v1/responses"));
    assert!(event["fwd_url"]
        .as_str()
        .unwrap()
        .ends_with("/alternate/responses"));
    // 脚本输入相对原始请求没有改动；脚本改写的模型只出现在转发正文的差异里，字段变更用完整正文比较。
    assert_eq!(event["script_body"]["encoding"], "delta");
    assert!(event["script_body"]["data"]["set"].get("model").is_none());
    assert_eq!(event["fwd_body"]["encoding"], "delta");
    assert_eq!(event["fwd_body"]["data"]["set"]["model"], "deepseek-test");
    assert_eq!(event["mods"]["changed_fields"], json!(["model"]));
    assert_eq!(event["resp_body"]["data"]["model"], "deepseek-test");
    assert_eq!(event["client_body"]["data"]["rewritten"], true);
    assert_eq!(event["status"], 200);
    assert_eq!(event["client_status"], 201);
    assert!(!event.to_string().contains("script-private-key"));
    proxy.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn script_retries_keep_every_upstream_result_under_one_request() {
    let (upstream, server) = mock_server(
        Router::new()
            .route("/v1/responses", post(native_upstream))
            .route(
                "/fail",
                any(|| async { (http::StatusCode::SERVICE_UNAVAILABLE, "try again") }),
            ),
    )
    .await;
    let script = r#"export default async (request,next) => {
        const response = await next(new Request('__UPSTREAM__/fail', {method:'POST',body:'{}'}));
        await response.text();
        return next();
    }"#
    .replace("__UPSTREAM__", &upstream);
    let db = Arc::new(Database::memory().unwrap());
    let (proxy, url) = proxy(
        db.clone(),
        &provider("retry", &upstream, Some(&script), true),
    )
    .await;
    assert!(post_request(&url)
        .await
        .json::<Value>()
        .await
        .unwrap()
        .get("usage")
        .is_some());
    let events = wait_rows(&db, 2).await;
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["request_id"], events[1]["request_id"]);
    assert_eq!(events[0]["attempt"], 1);
    assert_eq!(events[1]["attempt"], 1);
    assert_eq!(events[0]["forward_seq"], 1);
    assert_eq!(events[1]["forward_seq"], 2);
    assert_eq!(events[0]["status"], 503);
    assert_eq!(events[1]["status"], 200);
    assert_eq!(events[0]["resp_body"]["data"], "try again");
    assert_eq!(events[0]["script_used"], 1);
    assert_eq!(events[1]["script_used"], 1);
    proxy.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn synthetic_and_failed_scripts_are_logged_without_upstream_calls() {
    for (id, source, success) in [
        (
            "synthetic",
            "export default () => Response.json({object:'response',model:'synthetic',output:[]});",
            true,
        ),
        (
            "failure",
            "export default () => { throw new Error('script failed before next'); };",
            false,
        ),
    ] {
        let db = Arc::new(Database::memory().unwrap());
        let (proxy, url) = proxy(
            db.clone(),
            &provider(id, "http://127.0.0.1:1", Some(source), true),
        )
        .await;
        let response = post_request(&url).await;
        assert_eq!(response.status().is_success(), success);
        let _ = response.bytes().await.unwrap();
        let events = wait_rows(&db, 1).await;
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["forward_seq"], 0);
        assert_eq!(events[0]["script_used"], 1);
        assert_eq!(events[0]["fwd_url"], Value::Null);
        if !success {
            assert!(events[0]["error"]
                .as_str()
                .unwrap()
                .contains("script failed before next"));
        }
        proxy.stop().await.unwrap();
    }
}

#[tokio::test]
async fn sse_first_chunk_does_not_wait_for_stream_end_and_disconnect_is_logged() {
    let app = Router::new().route("/v1/responses", post(|| async {
        let stream = futures::stream::once(async { Ok::<_, std::io::Error>(Bytes::from_static(b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"sse-test\",\"model\":\"original-model\"}}\n\n")) })
            .chain(futures::stream::pending());
        Response::builder().header("content-type","text/event-stream").body(Body::from_stream(stream)).unwrap()
    }));
    let (upstream, server) = mock_server(app).await;
    let db = Arc::new(Database::memory().unwrap());
    let (proxy, url) = proxy(db.clone(), &provider("stream", &upstream, None, false)).await;
    let response = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .post(format!("{url}/v1/responses"))
        .json(&json!({"model":"original-model","input":"hello","stream":true}))
        .send()
        .await
        .unwrap();
    let mut stream = response.bytes_stream();
    let first = tokio::time::timeout(Duration::from_secs(3), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(String::from_utf8_lossy(&first).contains("response.created"));
    assert!(rows(&db).is_empty(), "stream remains in flight");
    drop(stream);
    let events = wait_rows(&db, 1).await;
    assert_eq!(events[0]["finish_reason"], "cancelled");
    assert_eq!(events[0]["client_body"]["complete"], false);
    assert!(events[0]["total_bytes"].as_u64().unwrap() > 0);
    proxy.stop().await.unwrap();
    server.abort();
}

fn fixture_event(id: &str, created_at: i64) -> Value {
    json!({"request_id":id,"target":"test","run_at":"test","seq":1,"started_at":"test","created_at":created_at,
        "duration_ms":1,"method":"POST","url":"/test","finish_reason":"completed","attempt":1,"forward_seq":1,
        "script_enabled":false,"script_used":false,"request_changed":false,"route_changed":false,"orig_body":{"data":"local-only-marker"}})
}

#[test]
fn event_cleanup_obeys_boundary_and_does_not_delete_usage() {
    let db = Database::memory().unwrap();
    db.save_proxy_events(&[
        fixture_event("old", 99),
        fixture_event("boundary", 100),
        fixture_event("new", 101),
    ])
    .unwrap();
    {
        let conn = db.conn.lock().unwrap();
        conn.execute("INSERT INTO proxy_request_logs(request_id,provider_id,app_type,model,latency_ms,status_code,created_at) VALUES('keep-usage','p','codex','test',1,200,1)",[]).unwrap();
    }
    assert_eq!(db.cleanup_proxy_events_before(100).unwrap(), 1);
    assert_eq!(rows(&db).len(), 2);
    assert_eq!(rows(&db)[0]["request_id"], "boundary");
    let conn = db.conn.lock().unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM proxy_request_logs WHERE request_id='keep-usage'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

#[test]
fn cleanup_reads_saved_retention_and_saving_does_not_delete_logs() {
    let db = Database::memory().unwrap();
    let now = chrono::Utc::now().timestamp();
    db.save_proxy_events(&[
        fixture_event("twenty-days-old", now - 20 * 86_400),
        fixture_event("three-days-old", now - 3 * 86_400),
        fixture_event("recent", now - 3600),
    ])
    .unwrap();
    for (days, deleted, remaining) in [(30, 0, 3), (7, 1, 2), (1, 1, 1)] {
        let before = rows(&db).len();
        db.set_proxy_event_log_config(&ProxyEventLogConfig {
            purge_days: days,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(rows(&db).len(), before);
        assert_eq!(db.cleanup_proxy_events().unwrap(), deleted);
        assert_eq!(rows(&db).len(), remaining);
    }
    assert_eq!(rows(&db)[0]["request_id"], "recent");
}

#[test]
fn detailed_logs_are_local_and_survive_configuration_sync() {
    require_isolated_home();
    let db = Database::memory().unwrap();
    db.save_proxy_events(&[fixture_event("local-event", chrono::Utc::now().timestamp())])
        .unwrap();
    let exported = db.export_sql_string_for_sync().unwrap();
    assert!(!exported.contains("local-only-marker"));
    db.import_sql_string_for_sync(&exported).unwrap();
    assert_eq!(rows(&db).len(), 1);
    assert_eq!(rows(&db)[0]["request_id"], "local-event");
}

#[tokio::test]
async fn logging_can_be_disabled_without_affecting_forwarding() {
    let (upstream, server) =
        mock_server(Router::new().route("/v1/responses", post(native_upstream))).await;
    let db = Arc::new(Database::memory().unwrap());
    db.set_setting("proxy_event_log_config", r#"{"enabled":false}"#)
        .unwrap();
    let (proxy, url) = proxy(
        db.clone(),
        &provider("disabled-log", &upstream, None, false),
    )
    .await;
    assert_eq!(
        post_request(&url).await.json::<Value>().await.unwrap()["model"],
        "original-model"
    );
    assert!(rows(&db).is_empty());
    proxy.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn unforwarded_requests_record_kind_and_initiator_without_a_provider() {
    let db = Arc::new(Database::memory().unwrap());
    let (proxy, url) = proxy(
        db.clone(),
        &provider("unused", "http://127.0.0.1:9", None, false),
    )
    .await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let count = client
        .post(format!(
            "{url}/claude-desktop/v1/messages/count_tokens?beta=true"
        ))
        .json(&json!({"model":"claude-opus-5","messages":[]}))
        .send()
        .await
        .unwrap();
    assert_eq!(count.status().as_u16(), 404);
    wait_rows(&db, 1).await;
    let hello = client
        .head(format!("{url}/claude-desktop/api/hello"))
        .send()
        .await
        .unwrap();
    assert_eq!(hello.status().as_u16(), 404);
    let events = wait_rows(&db, 2).await;
    for (event, kind) in events.iter().zip(["count_tokens", "probe"]) {
        assert_eq!(event["kind"], kind, "{event:#}");
        assert_eq!(event["app_type"], "claude-desktop");
        assert_eq!(event["attempt"], 0);
        assert_eq!(event["target"], "");
        assert_eq!(event["client_status"], 404);
    }
    proxy.stop().await.unwrap();
}
