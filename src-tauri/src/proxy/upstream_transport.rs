//! Shared native transport for direct forwarding and a script's next() calls.

use super::{hyper_client::ProxyResponse, script_middleware::ScriptRequest, ProxyError};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::time::Duration;

pub(crate) struct UpstreamRequest {
    pub url: String,
    pub method: http::Method,
    pub headers: http::HeaderMap,
    pub body: Vec<u8>,
}

impl UpstreamRequest {
    pub fn for_script(&self) -> ScriptRequest {
        ScriptRequest {
            url: self.url.clone(),
            method: self.method.to_string(),
            headers: super::script_middleware::headers_to_pairs(&self.headers),
            body: STANDARD.encode(&self.body),
        }
    }

    pub fn from_script(request: ScriptRequest) -> Result<Self, ProxyError> {
        let mut url = url::Url::parse(&request.url)
            .map_err(|_| ProxyError::ConfigError("代理脚本返回了无效的 URL".into()))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(ProxyError::ConfigError(
                "代理脚本仅支持 HTTP/HTTPS 请求".into(),
            ));
        }
        url.set_fragment(None);
        let method = http::Method::from_bytes(request.method.as_bytes())
            .map_err(|_| ProxyError::ConfigError("代理脚本返回了无效的 HTTP 方法".into()))?;
        let mut headers = super::script_middleware::parse_headers(request.headers)?;
        super::response_processor::strip_hop_by_hop_response_headers(&mut headers);
        headers.remove(http::header::CONTENT_LENGTH);
        // Routing to another URL must also update Host; body framing remains transport-owned.
        let uri: http::Uri = url
            .as_str()
            .parse()
            .map_err(|_| ProxyError::ConfigError("代理脚本返回了无效的 HTTP URL".into()))?;
        if let Some(authority) = uri.authority() {
            headers.insert(
                http::header::HOST,
                http::HeaderValue::from_str(authority.as_str())
                    .map_err(|_| ProxyError::ConfigError("代理脚本返回了无效的 Host".into()))?,
            );
        }
        let body = if matches!(method, http::Method::GET | http::Method::HEAD) {
            Vec::new()
        } else {
            STANDARD
                .decode(request.body)
                .map_err(|_| ProxyError::ConfigError("代理脚本返回了无效的请求体".into()))?
        };
        Ok(Self {
            url: url.into(),
            method,
            headers,
            body,
        })
    }
}

#[derive(Clone)]
pub(crate) struct UpstreamTransport {
    pub preserve_exact_header_case: bool,
    pub proxy_url: Option<String>,
    pub extensions: http::Extensions,
    pub request_is_streaming: bool,
    pub non_streaming_timeout: Duration,
    pub streaming_first_byte_timeout: Duration,
}

impl UpstreamTransport {
    pub fn header_timeout(&self) -> Duration {
        if self.request_is_streaming && !self.streaming_first_byte_timeout.is_zero() {
            self.streaming_first_byte_timeout
        } else if !self.non_streaming_timeout.is_zero() {
            self.non_streaming_timeout
        } else {
            Duration::from_secs(600)
        }
    }

    pub async fn send(&self, request: UpstreamRequest) -> Result<ProxyResponse, ProxyError> {
        let is_socks_proxy = self
            .proxy_url
            .as_deref()
            .is_some_and(|url| url.starts_with("socks5"));
        if is_socks_proxy || !self.preserve_exact_header_case {
            let client = super::http_client::get();
            let mut builder = client.request(request.method, &request.url);
            if self.request_is_streaming {
                builder = builder.timeout(Duration::from_secs(24 * 60 * 60));
            } else if !self.non_streaming_timeout.is_zero() {
                builder = builder.timeout(self.non_streaming_timeout);
            }
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            let send = builder.body(request.body).send();
            let response = if self.request_is_streaming {
                tokio::time::timeout(self.header_timeout(), send)
                    .await
                    .map_err(|_| {
                        ProxyError::Timeout(format!(
                            "流式响应首包超时: {}s（上游未返回响应头）",
                            self.header_timeout().as_secs()
                        ))
                    })?
            } else {
                send.await
            }
            .map_err(super::forwarder::map_reqwest_send_error)?;
            Ok(ProxyResponse::Reqwest(response))
        } else {
            let target_for_log = crate::redact_url_origin_for_log(&request.url);
            let uri = request.url.parse().map_err(|error| {
                ProxyError::ForwardFailed(format!(
                    "Invalid upstream URL ({target_for_log}): {error}"
                ))
            })?;
            let timeout = if self.non_streaming_timeout.is_zero() {
                Duration::from_secs(600)
            } else {
                self.non_streaming_timeout
            };
            super::hyper_client::send_request(
                uri,
                &target_for_log,
                request.method,
                request.headers,
                self.extensions.clone(),
                request.body,
                timeout,
                self.proxy_url.as_deref(),
            )
            .await
        }
    }
}

#[cfg(test)]
#[path = "upstream_transport_tests.rs"]
mod tests;
