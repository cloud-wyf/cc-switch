//! Native transport and script middleware share the same send path and detailed logging.

use super::super::event_log::AttemptLog;
use super::super::upstream_transport::{UpstreamRequest, UpstreamTransport};
use super::*;

impl RequestForwarder {
    pub(super) async fn send_upstream(
        &self,
        provider: &Provider,
        app_type: &AppType,
        transport: UpstreamTransport,
        request: UpstreamRequest,
        log: Option<&AttemptLog>,
    ) -> Result<(ProxyResponse, Option<String>), ProxyError> {
        let mut outbound_model = None;
        let response = if let Some(source) = provider.active_proxy_script() {
            // 脚本输入只在脚本真正执行时记录；普通转发的 fwd_body 已经是同一份内容。
            if let Some(attempt) = log {
                attempt.script_input(&request);
                attempt.script_started();
            }
            let timeout = transport.header_timeout();
            let request = request.for_script();
            let script_model = Arc::new(std::sync::Mutex::new(None::<String>));
            let observed_model = script_model.clone();
            let attempt_log = log.cloned();
            // next() uses the same transport, including the configured HTTP/SOCKS proxy.
            let next: super::super::script_middleware::Transport = Arc::new(move |request| {
                let transport = transport.clone();
                let observed_model = observed_model.clone();
                let attempt_log = attempt_log.clone();
                Box::pin(async move {
                    let request =
                        super::super::upstream_transport::UpstreamRequest::from_script(request)?;
                    if let Ok(body) = serde_json::from_slice::<Value>(&request.body) {
                        if let Some(model) = body
                            .get("model")
                            .and_then(Value::as_str)
                            .filter(|model| !model.is_empty())
                        {
                            *observed_model.lock().map_err(|_| {
                                ProxyError::Internal("代理脚本模型记录锁异常".into())
                            })? = Some(model.to_string());
                        }
                    }
                    super::super::event_log::send(&transport, request, attempt_log.as_ref()).await
                })
            });
            let response = super::super::script_middleware::execute(
                source, request,
                serde_json::json!({"providerId":provider.id, "providerName":provider.name, "appType":app_type.as_str()}),
                next, timeout,
            ).await?;
            if let Some(model) = script_model
                .lock()
                .map_err(|_| ProxyError::Internal("代理脚本模型记录锁异常".into()))?
                .take()
            {
                outbound_model = Some(model);
            }
            response
        } else {
            super::super::event_log::send(&transport, request, log).await?
        };

        Ok((response, outbound_model))
    }
}
