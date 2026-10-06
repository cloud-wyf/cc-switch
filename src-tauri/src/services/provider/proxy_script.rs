//! Shared script policy for forms, tray switches, profiles, and deep links.

use super::ProviderService;
use crate::{
    app_config::AppType,
    claude_desktop_config::{provider_mode, DEFAULT_PROXY_ROUTES},
    provider::{ClaudeDesktopMode, ClaudeDesktopModelRoute, Provider},
    store::AppState,
};

fn desktop_local_route(app: &AppType, provider: &Provider) -> bool {
    matches!(app, AppType::ClaudeDesktop)
        && matches!(provider_mode(provider), ClaudeDesktopMode::Proxy)
}

/// Whether selecting this provider must bring the local routing online.
pub(crate) fn needs_routing(app: &AppType, provider: &Provider) -> bool {
    provider.active_proxy_script().is_some() || desktop_local_route(app, provider)
}

/// A Claude Desktop script can only run behind the local gateway. Enabling a
/// script on a direct provider switches it to local-route mode; direct routes
/// already use Desktop-safe role IDs, so they carry over one-to-one.
pub(crate) fn prepare(app: &AppType, provider: &mut Provider) -> bool {
    if !matches!(app, AppType::ClaudeDesktop)
        || provider.category.as_deref() == Some("official")
        || provider.active_proxy_script().is_none()
        || desktop_local_route(app, provider)
    {
        return false;
    }
    let meta = provider.meta.get_or_insert_with(Default::default);
    meta.claude_desktop_mode = Some(ClaudeDesktopMode::Proxy);
    if meta.claude_desktop_model_routes.is_empty() {
        for route in DEFAULT_PROXY_ROUTES {
            meta.claude_desktop_model_routes.insert(
                route.route_id.to_string(),
                ClaudeDesktopModelRoute {
                    model: route.route_id.to_string(),
                    label_override: None,
                    supports_1m: Some(route.supports_1m),
                },
            );
        }
    }
    true
}

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
    if matches!(app, AppType::ClaudeDesktop) && !desktop_local_route(app, provider) {
        return Err("Claude Desktop 的代理脚本需要供应商接入方式为本地路由".into());
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
        .is_some_and(|provider| needs_routing(app, provider))
    {
        let activation = if matches!(app, AppType::ClaudeDesktop) {
            // Saving/switching Desktop already writes its dedicated gateway profile.
            // Start the listener without invoking the CLI live-config takeover flow.
            if state.proxy_service.is_running().await {
                Ok(())
            } else {
                state.proxy_service.start().await.map(|_| ())
            }
        } else {
            let stack_mode = crate::mode::state::stack_mode(
                &crate::live::engine::DeviceStore::for_device(),
                app.as_str(),
            )
            .map_err(|error| error.to_string())?;
            crate::mode::controller::enter_with_route(state, app, stack_mode, Some(id)).await
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
        assert!(error.contains("接入方式为本地路由"), "{error}");
    }

    #[tokio::test]
    async fn claude_desktop_proxy_script_disabled_draft_is_allowed_in_direct_mode() {
        let mut provider = desktop_provider(ClaudeDesktopMode::Direct);
        let meta = provider.meta.as_mut().unwrap();
        meta.local_proxy_script_enabled = Some(false);
        meta.local_proxy_script = Some("export default (".into());
        validate(&AppType::ClaudeDesktop, &provider).await.unwrap();
    }

    #[test]
    fn prepare_upgrades_direct_desktop_provider_with_script() {
        let mut provider = desktop_provider(ClaudeDesktopMode::Direct);
        assert!(prepare(&AppType::ClaudeDesktop, &mut provider));
        let meta = provider.meta.as_ref().unwrap();
        assert_eq!(meta.claude_desktop_mode, Some(ClaudeDesktopMode::Proxy));
        assert_eq!(
            meta.claude_desktop_model_routes.len(),
            DEFAULT_PROXY_ROUTES.len()
        );
        assert!(!prepare(&AppType::ClaudeDesktop, &mut provider));
    }

    #[test]
    fn prepare_keeps_existing_direct_routes() {
        let mut provider = desktop_provider(ClaudeDesktopMode::Direct);
        provider
            .meta
            .as_mut()
            .unwrap()
            .claude_desktop_model_routes
            .insert(
                "claude-opus-4-7".into(),
                ClaudeDesktopModelRoute {
                    model: "claude-opus-4-7".into(),
                    label_override: None,
                    supports_1m: None,
                },
            );
        assert!(prepare(&AppType::ClaudeDesktop, &mut provider));
        let routes = &provider.meta.as_ref().unwrap().claude_desktop_model_routes;
        assert_eq!(routes.len(), 1);
        assert_eq!(routes["claude-opus-4-7"].model, "claude-opus-4-7");
    }

    #[test]
    fn prepare_ignores_disabled_scripts_and_other_apps() {
        let mut provider = desktop_provider(ClaudeDesktopMode::Direct);
        provider.meta.as_mut().unwrap().local_proxy_script_enabled = Some(false);
        assert!(!prepare(&AppType::ClaudeDesktop, &mut provider));
        let mut claude = desktop_provider(ClaudeDesktopMode::Direct);
        assert!(!prepare(&AppType::Claude, &mut claude));
        assert_eq!(provider_mode(&claude), ClaudeDesktopMode::Direct);
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
