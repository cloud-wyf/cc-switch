//! 安装子进程的网络环境与有界实时输出；不改变系统环境或 npm 配置文件。
use std::io::Read;
use std::process::Command;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolNetworkMode {
    #[default]
    App,
    Direct,
    Inherit,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolLifecycleProgress {
    pub stage: &'static str,
    pub output: Option<String>,
}

impl ToolLifecycleProgress {
    pub fn stage(stage: &'static str) -> Self {
        Self {
            stage,
            output: None,
        }
    }
}

const PROXY_KEYS: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "npm_config_proxy",
    "npm_config_https_proxy",
    "NPM_CONFIG_PROXY",
    "NPM_CONFIG_HTTPS_PROXY",
];
const BYPASS_KEYS: &[&str] = &[
    "NO_PROXY",
    "no_proxy",
    "npm_config_noproxy",
    "NPM_CONFIG_NOPROXY",
];

pub fn configure_network(cmd: &mut Command, mode: ToolNetworkMode, proxy: Option<&str>) {
    let proxy = match mode {
        ToolNetworkMode::Inherit => return,
        // 未配置应用代理时保留用户自己的环境与 .npmrc。
        ToolNetworkMode::App => match proxy.filter(|url| !url.is_empty()) {
            Some(proxy) => proxy,
            None => return,
        },
        ToolNetworkMode::Direct => "",
    };
    for key in PROXY_KEYS {
        cmd.env(key, proxy);
    }
    for key in BYPASS_KEYS {
        cmd.env(key, if proxy.is_empty() { "*" } else { "" });
    }
    // WSL 不自动继承任意 Windows 环境变量。仅传递本次子进程的网络覆盖，
    // 不把凭据拼入 batch / shell 脚本。保留已有 WSLENV 条目。
    #[cfg(target_os = "windows")]
    {
        let inherited = std::env::var("WSLENV").unwrap_or_default();
        let mut keys: Vec<&str> = inherited.split(':').filter(|s| !s.is_empty()).collect();
        for key in PROXY_KEYS.iter().chain(BYPASS_KEYS) {
            if !keys
                .iter()
                .any(|entry| entry.split('/').next() == Some(*key))
            {
                keys.push(key);
            }
        }
        cmd.env("WSLENV", keys.join(":"));
    }
}

pub(super) fn clean_output(raw: &str) -> String {
    static ANSI: Lazy<Regex> = Lazy::new(|| Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").unwrap());
    static CREDENTIALS: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?i)([a-z][a-z0-9+.-]*://)[^\s/]*@").unwrap());
    let plain = ANSI.replace_all(raw, "");
    CREDENTIALS.replace_all(&plain, "$1***@").trim().to_string()
}

// 每条最多 16 KiB，超长行整条丢弃，避免无换行输出无限增长或截断后暴露 URL 凭据。
// 按行解码，UTF-8 多字节字符跨 read 边界时不会被拆坏；也支持 Windows 本地代码页。
pub(super) fn drain_output(
    mut reader: impl Read,
    emit: &dyn Fn(String),
) -> std::io::Result<Vec<u8>> {
    let mut all = Vec::new();
    let mut line = Vec::new();
    let mut dropped = false;
    let mut chunk = [0u8; 4096];
    let flush = |line: &mut Vec<u8>, dropped: &mut bool| {
        let text = if *dropped {
            "[output line exceeded 16 KiB]".to_string()
        } else {
            clean_output(&super::misc::decode_command_output(line))
        };
        line.clear();
        *dropped = false;
        if !text.is_empty() {
            emit(text);
        }
    };
    loop {
        let count = reader.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        all.extend_from_slice(&chunk[..count]);
        for byte in &chunk[..count] {
            if matches!(byte, b'\r' | b'\n') {
                flush(&mut line, &mut dropped);
            } else if !dropped {
                if line.len() == 16 * 1024 {
                    line.clear();
                    dropped = true;
                } else {
                    line.push(*byte);
                }
            }
        }
    }
    flush(&mut line, &mut dropped);
    Ok(all)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_override_is_confined_to_child_and_direct_bypasses_npmrc() {
        let mut cmd = Command::new("unused");
        configure_network(
            &mut cmd,
            ToolNetworkMode::App,
            Some("http://user:pass@localhost:7890"),
        );
        let env: std::collections::HashMap<_, _> = cmd
            .get_envs()
            .map(|(k, v)| (k.to_str().unwrap(), v.unwrap().to_str().unwrap()))
            .collect();
        assert_eq!(
            env["npm_config_https_proxy"],
            "http://user:pass@localhost:7890"
        );
        assert_eq!(env["NO_PROXY"], "");
        configure_network(&mut cmd, ToolNetworkMode::Direct, None);
        let env: std::collections::HashMap<_, _> = cmd
            .get_envs()
            .map(|(k, v)| (k.to_str().unwrap(), v.unwrap().to_str().unwrap()))
            .collect();
        assert_eq!(env["npm_config_noproxy"], "*");
        assert_eq!(env["HTTPS_PROXY"], "");
        let mut inherited = Command::new("unused");
        configure_network(&mut inherited, ToolNetworkMode::App, None);
        assert_eq!(inherited.get_envs().count(), 0);
        configure_network(
            &mut inherited,
            ToolNetworkMode::Inherit,
            Some("http://localhost"),
        );
        assert_eq!(inherited.get_envs().count(), 0);
    }

    #[test]
    fn output_is_bounded_and_redacts_credentials() {
        let events = std::sync::Mutex::new(Vec::new());
        let emit = |line| events.lock().unwrap().push(line);
        let raw = format!(
            "\x1b[32m下载 http://user:secret@localhost:7890/file\x1b[0m\r\n{}\nfinished",
            "x".repeat(100_000)
        );
        let captured = drain_output(raw.as_bytes(), &emit).unwrap();
        assert_eq!(captured, raw.as_bytes());
        let tail = events.lock().unwrap();
        assert_eq!(tail.len(), 3);
        assert_eq!(tail[0], "下载 http://***@localhost:7890/file");
        assert_eq!(tail[1], "[output line exceeded 16 KiB]");
        assert_eq!(tail[2], "finished");
    }
}
