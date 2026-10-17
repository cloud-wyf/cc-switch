use super::*;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

#[tokio::test]
async fn script_forwarding_updates_host_and_content_length_on_the_wire() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(socket);
        let mut header = String::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            header.push_str(&line);
            if line == "\r\n" {
                break;
            }
        }
        let content_length: usize = header
            .lines()
            .find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse().unwrap())
            })
            .unwrap();
        let mut body = vec![0; content_length];
        reader.read_exact(&mut body).await.unwrap();
        reader.get_mut().write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}").await.unwrap();
        (header, body)
    });
    let request = UpstreamRequest::from_script(ScriptRequest {
        url: format!("http://{address}/changed?mode=test"),
        method: "POST".into(),
        headers: vec![
            ("host".into(), "old.invalid".into()),
            ("content-length".into(), "9999".into()),
            ("x-script".into(), "yes".into()),
        ],
        body: STANDARD.encode(br#"{"changed":true}"#),
    })
    .unwrap();
    let transport = UpstreamTransport {
        preserve_exact_header_case: true,
        extensions: http::Extensions::new(),
        request_is_streaming: false,
        non_streaming_timeout: Duration::from_secs(3),
        streaming_first_byte_timeout: Duration::ZERO,
    };
    let response = transport.send(request).await.unwrap();
    assert_eq!(
        response.bytes_with_limit(1024).await.unwrap().as_ref(),
        br#"{"ok":true}"#
    );
    let (headers, body) = server.await.unwrap();
    assert!(headers.starts_with("POST /changed?mode=test HTTP/1.1\r\n"));
    assert!(headers
        .to_lowercase()
        .contains(&format!("host: {address}\r\n")));
    assert!(!headers.contains("9999"));
    assert_eq!(body, br#"{"changed":true}"#);
}

#[test]
fn script_transport_rejects_non_http_urls() {
    assert!(UpstreamRequest::from_script(ScriptRequest {
        url: "file:///private.txt".into(),
        method: "GET".into(),
        headers: vec![],
        body: String::new(),
    })
    .is_err());
}
