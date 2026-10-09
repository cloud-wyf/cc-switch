//! 安装子进程的网络环境与有界实时输出；不改变系统环境或 npm 配置文件。
use std::collections::VecDeque;
use std::io::Read;
use std::process::{Command, Stdio};

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

pub type ProgressSink<'a> = dyn Fn(ToolLifecycleProgress) + Sync + 'a;

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

fn clean_output(raw: &str) -> String {
    static ANSI: Lazy<Regex> = Lazy::new(|| Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").unwrap());
    static CREDENTIALS: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(?i)([a-z][a-z0-9+.-]*://)[^\s/]*@").unwrap());
    let plain = ANSI.replace_all(raw, "");
    CREDENTIALS.replace_all(&plain, "$1***@").trim().to_string()
}

// 每条最多 16 KiB，超长行整条丢弃，避免无换行输出无限增长或截断后暴露 URL 凭据。
// 按行解码，UTF-8 多字节字符跨 read 边界时不会被拆坏；也支持 Windows 本地代码页。
fn drain_output(
    mut reader: impl Read,
    emit: &ProgressSink<'_>,
) -> Result<VecDeque<String>, String> {
    let mut tail = VecDeque::new();
    let mut line = Vec::new();
    let mut dropped = false;
    let mut chunk = [0u8; 4096];
    let mut flush = |line: &mut Vec<u8>, dropped: &mut bool| {
        let text = if *dropped {
            "[output line exceeded 16 KiB]".to_string()
        } else {
            clean_output(&super::misc::decode_command_output(line))
        };
        line.clear();
        *dropped = false;
        if !text.is_empty() {
            emit(ToolLifecycleProgress {
                stage: "running",
                output: Some(text.clone()),
            });
            tail.push_back(text);
            if tail.len() > 8 {
                tail.pop_front();
            }
        }
    };
    loop {
        let count = reader
            .read(&mut chunk)
            .map_err(|e| format!("读取安装日志失败: {e}"))?;
        if count == 0 {
            break;
        }
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
    Ok(tail)
}

pub fn run_command(cmd: &mut Command, emit: &ProgressSink<'_>) -> Result<(), String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // npm 默认的 notice 级别在下载期间通常无输出；http 级别展示请求耗时。
    cmd.env("npm_config_loglevel", "http")
        .env("npm_config_progress", "false");
    let mut child = cmd.spawn().map_err(|e| format!("启动安装进程失败: {e}"))?;
    emit(ToolLifecycleProgress::stage("running"));
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    // 两条管道必须并发消费，避免 stderr 写满后子进程阻塞；页面关闭也继续排空、等待退出。
    std::thread::scope(|scope| {
        let out = scope.spawn(|| drain_output(stdout, emit));
        let err = scope.spawn(|| drain_output(stderr, emit));
        let status = child.wait().map_err(|e| format!("等待安装进程失败: {e}"));
        let stdout = out
            .join()
            .map_err(|_| "安装日志读取任务失败".to_string())??;
        let stderr = err
            .join()
            .map_err(|_| "安装日志读取任务失败".to_string())??;
        let status = status?;
        if status.success() {
            return Ok(());
        }
        let detail = if stderr.is_empty() { stdout } else { stderr };
        Err(if detail.is_empty() {
            format!("命令执行失败 (exit code: {:?})", status.code())
        } else {
            detail.into_iter().collect::<Vec<_>>().join("\n")
        })
    })
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
        let emit =
            |event: ToolLifecycleProgress| events.lock().unwrap().push(event.output.unwrap());
        let raw = format!(
            "\x1b[32m下载 http://user:secret@localhost:7890/file\x1b[0m\r\n{}\nfinished",
            "x".repeat(100_000)
        );
        let tail = drain_output(raw.as_bytes(), &emit).unwrap();
        assert_eq!(tail.len(), 3);
        assert_eq!(tail[0], "下载 http://***@localhost:7890/file");
        assert_eq!(tail[1], "[output line exceeded 16 KiB]");
        assert_eq!(tail[2], "finished");
        let many = "line\n".repeat(100);
        assert_eq!(drain_output(many.as_bytes(), &|_| {}).unwrap().len(), 8);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn output_arrives_before_process_exit_and_failure_keeps_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let release = dir.path().join("release.txt");
        let script = dir.path().join("stream.cmd");
        std::fs::write(&script, "@echo off\r\necho first\r\npowershell -NoProfile -Command \"$limit = [DateTime]::UtcNow.AddSeconds(5); while (-not (Test-Path -LiteralPath $env:RELEASE_FILE)) { if ([DateTime]::UtcNow -gt $limit) { exit 1 }; Start-Sleep -Milliseconds 20 }\"\r\nif errorlevel 1 exit /b 9\r\necho failed 1>&2\r\nexit /b 7\r\n").unwrap();
        let mut cmd = Command::new("cmd");
        use std::os::windows::process::CommandExt;
        cmd.arg("/D")
            .arg("/C")
            .arg(script)
            .env("RELEASE_FILE", &release)
            .creation_flags(0x08000000);
        let emit = |event: ToolLifecycleProgress| {
            if event.output.as_deref() == Some("first") {
                std::fs::write(&release, "ok").unwrap();
            }
        };
        // 原来的 output() 会一直等进程退出，收不到 first，无法释放子进程。
        assert_eq!(run_command(&mut cmd, &emit).unwrap_err(), "failed");
        assert!(release.exists());
    }
}
