# CC Switch（个人自用版）

基于 CC Switch 修改的个人维护版本，用于管理本地 AI 工具的供应商配置、代理路由、MCP、Skills 和会话。

本版本从本仓库源码构建；安装版支持从私有仓库获取更新并在应用内安装。使用说明以当前代码行为为准。

## 开发环境

- Node.js：参考 `.node-version`（22.12.0）。
- pnpm：参考 `package.json` 的 `packageManager`（10.12.3）。
- Rust：参考 `rust-toolchain.toml`（1.95）。
- Tauri CLI：使用 pnpm 安装的项目版本（2.11.4 起），确保打包工具能正确写入应用内更新所需的安装类型标记。
- 安装 [Tauri 2 平台依赖](https://v2.tauri.app/start/prerequisites/)；Windows 需要 Microsoft C++ Build Tools 和 WebView2。

## 常用命令

在项目根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm dev
```

| 命令                                                     | 用途                           |
| -------------------------------------------------------- | ------------------------------ |
| `pnpm dev`                                               | 启动桌面应用开发模式           |
| `pnpm dev:renderer`                                      | 启动前端开发服务               |
| `pnpm typecheck`                                         | 检查 TypeScript 类型           |
| `pnpm test:unit`                                         | 运行前端测试                   |
| `pnpm build:renderer`                                    | 构建前端                       |
| `pnpm build`                                             | 构建本机平台的桌面应用及安装包 |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml` | 检查 Rust 格式                 |
| `cargo test --manifest-path src-tauri/Cargo.toml`        | 运行 Rust 测试                 |

桌面应用构建产物位于 `src-tauri/target/release/`，安装包位于其 `bundle/` 子目录。本地打包需要配置下文说明的更新签名私钥。

## 版本号规则

应用版本遵循 SemVer（`主版本.次版本.补丁版本`，可附预发布后缀），以满足 Cargo 和 Tauri 的版本格式要求。`3.20.1.1` 这样的四段数字不能作为应用版本号。

自用修订使用**下一补丁版本的数字预发布号**，修订序号从 `1` 开始递增。例如，基于上游 `3.20.1` 的自用修订依次使用 `3.20.2-1`、`3.20.2-2`，版本优先级为：

```text
3.20.1 < 3.20.2-1 < 3.20.2-2 < 3.20.2
```

发布说明应记录实际基于的上游版本。上游 `3.20.2` 发布后，合并其源码并保留本地定制，重新构建时使用正式版本号 `3.20.2`；后续自用修订从 `3.20.3-1` 开始。

发布时同步修改以下位置的应用版本：

- `package.json` 的 `version`。
- `src-tauri/Cargo.toml` 的 `[package].version`。
- `src-tauri/tauri.conf.json` 的 `version`。
- `src-tauri/Cargo.lock` 中本项目包的 `version`。

## 应用内更新

更新源为私有仓库 [cloud-wyf/cc-switch](https://github.com/cloud-wyf/cc-switch)。应用启动后自动检查版本，发现新版时显示更新图标；在「设置 → 关于」中点击更新，程序会下载、校验签名、安装并重启。便携版沿用打开发布页、下载替换的方式。

更新检查包含 `3.20.2-1` 这样的预发布版本，并按 SemVer 选择更高版本。仅推送源码不会触发更新，需要发布带签名安装包和 `latest.json` 的 Release。上游发布新版后，应先合并源码、保留本地定制，再向本仓库发布。

### 私有仓库认证

在运行应用的机器上安装 [GitHub CLI](https://cli.github.com/)，使用有仓库读取权限的账号登录：

```bash
gh auth login --hostname github.com
```

应用后端复用本机 GitHub CLI 的登录凭据。也可通过 `CC_SWITCH_GITHUB_TOKEN` 提供仅对该仓库具有 `Contents: read` 权限的令牌；兼容 `GH_TOKEN`、`GITHUB_TOKEN`，优先级依次降低。令牌只在后端用于 GitHub API 请求，不写入源码、安装包或前端存储。

### 构建与发布

更新使用本项目自己的签名密钥。`src-tauri/tauri.conf.json` 保存公钥；对应私钥保存在维护者本机 `~/.tauri/cc-switch-updater.key`，需妥善备份并持续使用同一密钥，不提交到仓库。

Windows 本地打包示例：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE/.tauri/cc-switch-updater.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
pnpm build
```

通过 GitHub Actions 发布：

1. 在本仓库的 Actions Secrets 中，将 `TAURI_SIGNING_PRIVATE_KEY` 设置为对应私钥文件的内容。如果私钥设有密码，再配置 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
2. 按上面的版本规则同步四处版本号，运行 `node scripts/validate-release.mjs` 检查一致性。
3. 推送与应用版本一致的 Tag，例如 `v3.20.2-1`。`Release` 工作流会创建草稿，构建并签名 Windows、macOS、Linux 安装包，检查各平台更新清单后再发布。
4. 已安装本项目构建的应用会在下次启动或手动检查更新时发现新版。首次从已移除更新功能的旧构建迁移时，需要先安装一次包含此更新功能的新构建。

更新签名私钥用于构建，GitHub 访问令牌用于读取私有 Release，二者各自独立。更新前建议备份应用配置目录。

## 目录与文档

- `src/`：React、TypeScript 前端。
- `src-tauri/`：Rust 后端和 Tauri 打包配置。
- `tests/`：前端测试。
- [中文使用手册](docs/user-manual/zh/README.md)：功能配置与排障参考。
- `docs/guides/`：具体功能的操作指南。
- `docs/pi-*.md`：Pi 功能约束与设计说明。
- [会话管理设计](session-manager.md)。
- [深链接生成器](deplink.html)：在本地浏览器打开后生成导入链接。
- [Flatpak 构建说明](flatpak/README.md)。

## 许可证

沿用 [MIT License](LICENSE)，保留原作者的版权声明。
