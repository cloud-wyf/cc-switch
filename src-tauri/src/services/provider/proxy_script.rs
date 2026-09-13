//! Shared script policy for forms, tray switches, profiles, and deep links.

use super::ProviderService;
use crate::{
    app_config::AppType,
    provider::{ClaudeDesktopMode, Provider},
    store::AppState,
};

pub(crate) async fn validate(app: &AppType, provider: &Provider) -> Result<(), String> {
    let Some(source) = provider.active_proxy_script() else {
        return Ok(());
    };
    if !app.supports_local_proxy() && !matches!(app, AppType::ClaudeDesktop) {
        return Err(format!("{} 不支持本地代理脚本", app.as_str()));
    }
    if provider.category.as_deref() == Some("official")
        && !super::official_provider_supports_proxy_takeover(app, provider)
    {
        return Err("此官方供应商不支持本地路由，无法启用代理脚本".into());
    }
    if matches!(app, AppType::ClaudeDesktop)
        && !matches!(
            crate::claude_desktop_config::provider_mode(provider),
            ClaudeDesktopMode::Proxy
        )
    {
        return Err("Claude Desktop 的代理脚本需要先选择本地路由模式".into());
    }
    crate::proxy::script_middleware::validate(source).await
}

pub(crate) async fn activate_current(
    state: &AppState,
    app: &AppType,
    id: &str,
) -> Result<(), String> {
    if ProviderService::current(state, app.clone()).map_err(|error| error.to_string())? != id {
        return Ok(());
    }
    let provider = state
        .db
        .get_provider_by_id(id, app.as_str())
        .map_err(|error| error.to_string())?;
    if provider
        .as_ref()
        .and_then(Provider::active_proxy_script)
        .is_some()
    {
        let activation = if matches!(app, AppType::ClaudeDesktop) {
            // Saving/switching Desktop already writes its dedicated gateway profile.
            // Start the listener without invoking the CLI live-config takeover flow.
            state.proxy_service.start().await.map(|_| ())
        } else {
            state
                .proxy_service
                .set_takeover_for_app(app.as_str(), true)
                .await
        };
        activation
            .map_err(|error| format!("供应商配置已保存，但启用脚本所需的本地路由失败：{error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderMeta;
    use serde_json::json;

    fn desktop_provider(mode: ClaudeDesktopMode) -> Provider {
        let mut provider = Provider::with_id(
            "desktop-script".into(),
            "Desktop script".into(),
            json!({}),
            None,
        );
        provider.meta = Some(ProviderMeta {
            claude_desktop_mode: Some(mode),
            local_proxy_script: Some("export default (_request, next) => next();".into()),
            ..Default::default()
        });
        provider
    }

    #[tokio::test]
    async fn claude_desktop_proxy_script_accepts_local_route_mode() {
        validate(
            &AppType::ClaudeDesktop,
            &desktop_provider(ClaudeDesktopMode::Proxy),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn claude_desktop_proxy_script_requires_local_route_mode() {
        let error = validate(
            &AppType::ClaudeDesktop,
            &desktop_provider(ClaudeDesktopMode::Direct),
        )
        .await
        .unwrap_err();
        assert!(error.contains("先选择本地路由模式"), "{error}");
    }

    #[tokio::test]
    async fn claude_desktop_proxy_script_disabled_draft_is_allowed_in_direct_mode() {
        let mut provider = desktop_provider(ClaudeDesktopMode::Direct);
        let meta = provider.meta.as_mut().unwrap();
        meta.local_proxy_script_enabled = Some(false);
        meta.local_proxy_script = Some("export default (".into());
        validate(&AppType::ClaudeDesktop, &provider).await.unwrap();
    }

    #[tokio::test]
    async fn claude_desktop_proxy_script_still_rejects_official_providers() {
        let mut provider = desktop_provider(ClaudeDesktopMode::Proxy);
        provider.category = Some("official".into());
        let error = validate(&AppType::ClaudeDesktop, &provider)
            .await
            .unwrap_err();
        assert!(error.contains("此官方供应商不支持本地路由"), "{error}");
    }
}
