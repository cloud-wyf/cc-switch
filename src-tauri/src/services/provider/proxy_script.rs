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
    if !app.supports_local_proxy() {
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
        state
            .proxy_service
            .set_takeover_for_app(app.as_str(), true)
            .await
            .map_err(|error| format!("供应商配置已保存，但启用脚本所需的本地路由失败：{error}"))?;
    }
    Ok(())
}
