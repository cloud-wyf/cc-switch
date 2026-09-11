//! 从自用私有仓库检查更新，复用 Tauri 的签名校验和安装流程。

use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION};
use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

pub const REPOSITORY: &str = "cloud-wyf/cc-switch";
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const MANIFEST_NAME: &str = "latest.json";

#[derive(Deserialize)]
struct GitHubAsset {
    id: u64,
    name: String,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    draft: bool,
    assets: Vec<GitHubAsset>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    current_version: String,
    available_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub_date: Option<String>,
}

impl From<Update> for AppUpdateInfo {
    fn from(update: Update) -> Self {
        Self {
            current_version: update.current_version,
            available_version: update.version,
            notes: update.body,
            pub_date: update
                .raw_json
                .get("pub_date")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
        }
    }
}

pub fn releases_url(version: Option<&str>) -> Result<String, String> {
    let base = format!("https://github.com/{REPOSITORY}/releases");
    match version.filter(|value| !value.is_empty()) {
        Some(version) => {
            let version = parse_version(version).ok_or("发布版本号不是合法的 SemVer")?;
            Ok(format!("{base}/tag/v{version}"))
        }
        // Releases 列表包含自用预发布版本；/latest 会忽略它们。
        None => Ok(base),
    }
}

fn parse_version(tag: &str) -> Option<Version> {
    Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok()
}

fn latest_release<'a>(
    releases: &'a [GitHubRelease],
    current: &Version,
) -> Option<(Version, &'a GitHubRelease)> {
    releases
        .iter()
        .filter(|release| !release.draft)
        .filter(|release| {
            release
                .assets
                .iter()
                .any(|asset| asset.name == MANIFEST_NAME)
        })
        .filter_map(|release| parse_version(&release.tag_name).map(|version| (version, release)))
        .filter(|(version, _)| version.cmp_precedence(current).is_gt())
        .max_by(|(left, _), (right, _)| left.cmp_precedence(right))
}

fn asset_url(asset: &GitHubAsset) -> Url {
    Url::parse(&format!(
        "https://api.github.com/repos/{REPOSITORY}/releases/assets/{}",
        asset.id
    ))
    .expect("固定 GitHub API 地址及数字资产 ID 构成合法 URL")
}

fn authenticated_download_url(release: &GitHubRelease, download_url: &Url) -> Result<Url, String> {
    release
        .assets
        .iter()
        .find(|asset| {
            asset.name != MANIFEST_NAME
                && (asset.browser_download_url == download_url.as_str()
                    || asset_url(asset) == *download_url)
        })
        .map(asset_url)
        .ok_or_else(|| "更新包必须属于当前私有仓库的同一个 Release，已拒绝下载".to_owned())
}

async fn github_token() -> Result<String, String> {
    for name in ["CC_SWITCH_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] {
        if let Ok(token) = std::env::var(name) {
            let token = token.trim();
            if !token.is_empty() {
                return Ok(token.to_owned());
            }
        }
    }

    let mut command = tokio::process::Command::new("gh");
    command
        .args(["auth", "token", "--hostname", "github.com"])
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = tokio::time::timeout(Duration::from_secs(10), command.output()).await;
    if let Ok(Ok(output)) = output {
        if output.status.success() {
            if let Ok(token) = String::from_utf8(output.stdout) {
                let token = token.trim();
                if !token.is_empty() {
                    return Ok(token.to_owned());
                }
            }
        }
    }

    // 不回传命令输出，避免凭据意外出现在日志或 WebView 中。
    Err(format!(
        "更新仓库 {REPOSITORY} 需要 GitHub 认证。请使用 gh auth login 登录有仓库读取权限的账号，或设置 CC_SWITCH_GITHUB_TOKEN 后重新启动应用。"
    ))
}

fn github_headers(token: &str) -> Result<HeaderMap, String> {
    let mut authorization = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| "GitHub 访问令牌格式无效".to_owned())?;
    authorization.set_sensitive(true);
    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, authorization);
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/vnd.github+json"),
    );
    headers.insert(
        "X-GitHub-Api-Version",
        HeaderValue::from_static("2022-11-28"),
    );
    Ok(headers)
}

fn github_error(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        401 => "GitHub 登录凭据无效或已过期，请重新登录或更新 CC_SWITCH_GITHUB_TOKEN".to_owned(),
        403 => "GitHub 拒绝访问更新仓库，请检查仓库读取权限或稍后重试（可能已达到 API 请求限额）".to_owned(),
        404 => format!("无法读取私有更新仓库 {REPOSITORY}，请确认 GitHub 账号或令牌具有该仓库的 Contents: read 权限"),
        _ => format!("读取更新仓库失败（HTTP {status}）"),
    }
}

pub async fn check(app: &AppHandle) -> Result<Option<Update>, String> {
    tokio::time::timeout(CHECK_TIMEOUT, check_inner(app))
        .await
        .map_err(|_| "检查更新超时，请检查网络后重试".to_owned())?
}

async fn check_inner(app: &AppHandle) -> Result<Option<Update>, String> {
    let mut headers = github_headers(&github_token().await?)?;
    let client = reqwest::Client::builder()
        .user_agent(concat!("cc-switch/", env!("CARGO_PKG_VERSION")))
        .default_headers(headers.clone())
        .connect_timeout(Duration::from_secs(10))
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|error| format!("初始化更新请求失败: {error}"))?;

    // 按 SemVer 选择版本，不依赖 GitHub 的发布时间排序或 /releases/latest。
    let mut releases = Vec::new();
    let mut page = 1;
    loop {
        let response = client
            .get(format!(
                "https://api.github.com/repos/{REPOSITORY}/releases?per_page=100&page={page}"
            ))
            .send()
            .await
            .map_err(|error| format!("连接更新仓库失败: {error}"))?;
        if !response.status().is_success() {
            return Err(github_error(response.status()));
        }
        let batch: Vec<GitHubRelease> = response
            .json()
            .await
            .map_err(|error| format!("读取发布列表失败: {error}"))?;
        let has_next_page = batch.len() == 100;
        releases.extend(batch);
        if !has_next_page {
            break;
        }
        page += 1;
    }

    let Some((version, release)) = latest_release(&releases, &app.package_info().version) else {
        return Ok(None);
    };
    let manifest = release
        .assets
        .iter()
        .find(|asset| asset.name == MANIFEST_NAME)
        .expect("latest_release 已检查更新清单存在");

    // 私有仓库的清单和安装包都通过 Release Assets API 下载。
    headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));
    let updater = app
        .updater_builder()
        .headers(headers)
        .endpoints(vec![asset_url(manifest)])
        .map_err(|error| format!("设置更新源失败: {error}"))?
        .version_comparator(|current, release| release.version.cmp_precedence(&current).is_gt())
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|error| format!("初始化更新器失败: {error}"))?;
    let mut update = updater
        .check()
        .await
        .map_err(|error| format!("检查更新清单失败: {error}"))?
        .ok_or("发布版本与更新清单不一致，请重新发布完整的更新包")?;
    if parse_version(&update.version).as_ref() != Some(&version) {
        return Err("发布版本与更新清单的版本号不一致，已拒绝安装".to_owned());
    }

    // 不将认证头发送给清单内任意 URL；只接受本 Release 的资产。
    update.download_url = authenticated_download_url(release, &update.download_url)?;
    update.timeout = Some(Duration::from_secs(600));
    Ok(Some(update))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str) -> GitHubRelease {
        GitHubRelease {
            tag_name: tag.to_owned(),
            draft: false,
            assets: vec![
                GitHubAsset {
                    id: 10,
                    name: MANIFEST_NAME.to_owned(),
                    browser_download_url: format!(
                        "https://github.com/{REPOSITORY}/releases/download/{tag}/latest.json"
                    ),
                },
                GitHubAsset {
                    id: 11,
                    name: "setup.exe".to_owned(),
                    browser_download_url: format!(
                        "https://github.com/{REPOSITORY}/releases/download/{tag}/setup.exe"
                    ),
                },
            ],
        }
    }

    #[test]
    fn self_revisions_follow_semver_including_numeric_prerelease_order() {
        let releases = vec![
            release("v3.20.2-2"),
            release("v3.20.1"),
            release("v3.20.2-10"),
        ];
        let current = Version::parse("3.20.1").unwrap();
        assert_eq!(
            latest_release(&releases, &current).unwrap().0.to_string(),
            "3.20.2-10"
        );
    }

    #[test]
    fn upstream_stable_follows_self_revisions() {
        let releases = vec![release("v3.20.2-10"), release("v3.20.2")];
        let current = Version::parse("3.20.2-10").unwrap();
        assert_eq!(
            latest_release(&releases, &current).unwrap().0.to_string(),
            "3.20.2"
        );
    }

    #[test]
    fn drafts_incomplete_releases_invalid_tags_and_build_metadata_are_not_updates() {
        let mut draft = release("v3.21.0");
        draft.draft = true;
        let mut incomplete = release("v3.20.3");
        incomplete.assets.clear();
        let releases = vec![
            draft,
            incomplete,
            release("v3.20.1.1"),
            release("v3.20.1+2"),
            release("v3.20.0"),
        ];
        assert!(latest_release(&releases, &Version::parse("3.20.1").unwrap()).is_none());
    }

    #[test]
    fn private_download_uses_the_authenticated_asset_api() {
        let release = release("v3.20.2-1");
        let download = Url::parse(&release.assets[1].browser_download_url).unwrap();
        let expected = Url::parse(&format!(
            "https://api.github.com/repos/{REPOSITORY}/releases/assets/11"
        ))
        .unwrap();
        assert_eq!(
            authenticated_download_url(&release, &download).unwrap(),
            expected
        );
        assert_eq!(
            authenticated_download_url(&release, &expected).unwrap(),
            expected
        );
    }

    #[test]
    fn refuses_assets_outside_the_selected_release() {
        let release = release("v3.20.2-1");
        for url in [
            "https://github.com/farion1231/cc-switch/releases/download/v3.20.2-1/setup.exe",
            "https://example.com/setup.exe",
            "https://api.github.com/repos/cloud-wyf/cc-switch/releases/assets/99",
        ] {
            assert!(authenticated_download_url(&release, &Url::parse(url).unwrap()).is_err());
        }
    }

    #[test]
    fn release_links_include_prereleases_and_validate_versions() {
        assert_eq!(
            releases_url(None).unwrap(),
            format!("https://github.com/{REPOSITORY}/releases")
        );
        assert_eq!(
            releases_url(Some("3.20.2-1")).unwrap(),
            format!("https://github.com/{REPOSITORY}/releases/tag/v3.20.2-1")
        );
        assert!(releases_url(Some("../../other-repo")).is_err());
    }

    #[test]
    fn authentication_headers_are_sensitive_and_malformed_tokens_are_redacted() {
        let headers = github_headers("test-token").unwrap();
        assert!(headers[AUTHORIZATION].is_sensitive());
        let error = github_headers("private-token\ninvalid").unwrap_err();
        assert!(!error.contains("private-token"));
        assert!(github_error(reqwest::StatusCode::NOT_FOUND).contains("Contents: read"));
    }
}
