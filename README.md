# CC Switch（个人自用版）

基于 CC Switch 修改的个人维护版本，用于管理本地 AI 工具的供应商配置、代理路由、MCP、Skills 和会话。

本版本仅构建 Windows x64；安装版支持从私有仓库获取更新并在应用内安装。使用说明以当前代码行为为准。

## 开发环境

- Node.js：参考 `.node-version`（24.14.1）；供应商 TypeScript 中间件需要 Node.js 24+。
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

| 命令                                                     | 用途                              |
| -------------------------------------------------------- | --------------------------------- |
| `pnpm dev`                                               | 启动桌面应用开发模式              |
| `pnpm dev:renderer`                                      | 启动前端开发服务                  |
| `pnpm typecheck`                                         | 检查 TypeScript 类型              |
| `pnpm test:unit`                                         | 运行前端测试                      |
| `pnpm build:renderer`                                    | 构建前端                          |
| `pnpm build`                                             | 构建 Windows x64 桌面应用及安装包 |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml` | 检查 Rust 格式                    |
| `cargo test --manifest-path src-tauri/Cargo.toml`        | 运行 Rust 测试                    |

桌面应用构建产物位于 `src-tauri/target/x86_64-pc-windows-msvc/release/`，安装包位于其 `bundle/` 子目录。本地打包需要配置下文说明的更新签名私钥。

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

## 同步上游源码

按[上游同步指南](docs/guides/upstream-sync.md)获取并合入上游最新稳定版。指南记录了需要保留的私有更新源、签名公钥、供应商名单、Windows x64 发布方案，以及冲突处理和验证步骤；实际合入的版本和提交见指南末尾的同步记录。

4.0 的自用功能入口和数据库迁移说明见 [自用版 4.0 源码升级](docs/guides/v4-local-upgrade.md)。

## 应用内更新

更新源为私有仓库 [cloud-wyf/cc-switch](https://github.com/cloud-wyf/cc-switch)。应用启动后自动检查版本，发现新版时显示更新图标；在「设置 → 关于」中点击更新，程序会下载、校验签名、安装并重启。便携版沿用打开发布页、下载替换的方式。

更新检查包含 `3.20.2-1` 这样的预发布版本，并按 SemVer 选择更高版本。仅推送源码不会触发更新，需要发布带签名安装包和 `latest.json` 的 Release。上游发布新版后，应先合并源码、保留本地定制，再向本仓库发布。

### 私有仓库认证

在运行应用的机器上安装 [GitHub CLI](https://cli.github.com/)，使用有仓库读取权限的账号登录：

```bash
gh auth login --hostname github.com
```

应用后端复用本机 GitHub CLI 的登录凭据。也可通过 `CC_SWITCH_GITHUB_TOKEN` 提供仅对该仓库具有 `Contents: read` 权限的令牌；兼容 `GH_TOKEN`、`GITHUB_TOKEN`，优先级依次降低。令牌只在后端用于 GitHub API 请求，不写入源码、安装包或前端存储。

### Windows x64 构建与发布

云端和本地只构建 Windows x64，保留 MSI、NSIS（EXE）两种安装方式和便携 ZIP。更新清单只包含 Windows x64 的默认、MSI、NSIS 三个入口。两条构建路径使用同一个版本 Tag、签名密钥和发布脚本，已安装应用仍从本私有仓库检查、下载和安装更新。

更新公钥保存在 `src-tauri/tauri.conf.json`；对应私钥保存在维护者本机 `~/.tauri/cc-switch-updater.key`，必须备份并持续使用同一把密钥。私钥不提交到仓库，不放入安装包。发布脚本上传前会用应用公钥验证安装包签名。

#### 一次性准备

1. 按上文安装 Windows x64 构建环境，并通过 `gh auth login --hostname github.com` 登录具有仓库写入和 Actions 触发权限的维护者账号。发布不需要读取账单的 `user` scope。
2. 在本仓库 Actions Secrets 中配置 `TAURI_SIGNING_PRIVATE_KEY`，值为同一把私钥的文件内容；有密码时再配置 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
3. 在 [GitHub Billing](https://github.com/settings/billing) → **Budgets and alerts** 中，为 **Actions** 设置 **$0 的额外支出预算**，范围选择本仓库 `cloud-wyf/cc-switch`，启用 **Stop usage when budget limit is reached**。这是免费额度之外的付费上限，免费额度仍可使用。已有适用预算则编辑已有项，避免重复设置。仅开启提醒而不停止使用，不能保证额度用完后转本机。参见 [GitHub 官方预算说明](https://docs.github.com/en/billing/how-tos/set-up-budgets)。
4. 将这套发布脚本和工作流同步到默认分支。用于发版的新 Tag 也必须包含这套脚本；旧版多平台工作流不能与新入口混用。

本机直接构建时，显式使用已有签名密钥：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE/.tauri/cc-switch-updater.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
pnpm build
```

`pnpm build` 固定目标为 `x86_64-pc-windows-msvc`，使用锁定依赖，只生成 MSI、NSIS 和对应的 `.sig` 文件。产物位于 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/`。它只打包，不创建 Release。完整发布命令会再生成便携 ZIP、更新清单并上传。

#### 每次发布：GitHub 优先，额度不足转本机

每次向 `main` 推送会改变应用的提交（源码、依赖、配置），都要紧接着发布一个新版本；只推送源码时，已安装的应用检测不到更新。纯文档改动不需要发版。

1. 按上文规则同步四处版本号，例如下一个自用修订 `3.20.2-2`；运行 `node scripts/validate-release.mjs` 检查一致性。
2. 提交发布源码并推送对应 Tag，例如 `v3.20.2-2`。运行发布命令时，当前工作目录必须干净，HEAD 必须与远程 Tag 指向同一提交。
3. 在本机项目目录执行：

```powershell
pnpm release:check --tag v3.20.2-2
pnpm release --tag v3.20.2-2
```

本仓库的 GitHub Actions 免费额度已用完，第 3 步默认直接用 `pnpm release:local --tag v3.20.2-2`，在本机构建、签名并上传到本仓库的 Release。推送 Tag 触发的云端任务会在几秒内因额度失败，确认它已结束（`gh run list --workflow release.yml -L 1`）后再运行。额度恢复后可改回 `pnpm release`，优先使用云端构建。

`release:check` 只读检查源码、Tag、远程工作流和本机签名配置，不触发构建或上传。它不替代本机工具链的实际打包验证。省略 `--tag` 时，使用当前 `package.json` 的版本号。

正常发布的流程为：

```text
本机执行 pnpm release
  → 优先使用 GitHub Windows x64 工作流
    → 构建成功：GitHub 发布 Release
    → 明确因额度/账单限制未启动：本机打包、验签并发布同一版本
    → 编译、测试、网络或认证错误：停止并显示错误
```

- 推送 Tag 已启动的云端任务会被复用；没有正在运行的任务时，命令会请求一次云端构建。
- 每次发布都会重新尝试 GitHub，不保存“整月只用本机”的开关，因此额度重置后自动恢复云端优先。
- 切换依据是 GitHub 返回的明确额度/账单阻塞信息，不用任务时长或账单金额猜剩余额度。零额外支出预算是避免继续付费构建的前提，脚本不会修改你的付款方式或预算。
- 本机命令需要保持运行并联网。仅推送 Tag 而未运行本机发版命令，不会自动唤醒电脑兜底；恢复时重新运行 `pnpm release`。同一个版本一次只运行一个发布命令。
- 云端排队超过 90 分钟、主动取消、普通编译失败、权限或网络错误均不会自动转本机，以免同时有两个发布者。
- 只有安装包、签名、便携包和完整清单上传成功后才正式发布。中途失败会保留草稿；重试复用同一源码的草稿，相同摘要的附件跳过上传。已发布版本不会被覆盖。
- 本机打包期间不要修改源码或切换分支；打包后会再次核对工作目录和远程 Tag。
- 发布完成后本机可以关机，其他电脑仍从 GitHub 下载更新。

#### 手动指定构建位置

| 命令                                  | 行为                                     |
| ------------------------------------- | ---------------------------------------- |
| `pnpm release --tag v3.20.2-2`        | GitHub 优先，明确额度阻塞后自动转本机    |
| `pnpm release:github --tag v3.20.2-2` | 只使用 GitHub，额度不足时停止            |
| `pnpm release:local --tag v3.20.2-2`  | 直接使用本机，完成打包、验签、上传和发布 |
| `pnpm release:check --tag v3.20.2-2`  | 只读检查，不构建、不发布                 |

手动本机发布前，同一 Tag 的云端任务必须已结束。若因网络或排队问题需要手动切换，先在 Actions 页面取消对应任务并确认结束，再执行 `release:local`。本地发布默认读取 `~/.tauri/cc-switch-updater.key`，也支持上述 `TAURI_SIGNING_PRIVATE_KEY` 和密码环境变量。

完整发布会产生 6 个附件：MSI、MSI 签名、NSIS EXE、EXE 签名、便携 ZIP、`latest.json`。本地便携包和清单保存在已忽略的 `release/<Tag>/` 下；不会上传私钥、访问令牌或构建缓存。

#### CI 和额度

普通 CI 只检查 Windows x64；纯文档改动不触发 CI。原 WSL2 完整测试保留为 **WSL2 Manual Checks**，仅在修改 Windows/WSL 文件系统交互时手动运行，不再每天自动消耗额度。

普通 CI 仍会使用 GitHub 免费额度，额度耗尽后可能停止。发布命令的本机兜底只负责发版，不会冒充通过被跳过的云端 CI。本机可继续执行 `pnpm typecheck`、`pnpm format:check`、`pnpm test:unit`、`cargo clippy --locked --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml -- -D warnings` 和 `cargo test --locked --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml`。

更新签名负责证明安装包可信，GitHub 凭据负责读取或上传私有 Release；两者用途独立。

## 目录与文档

- `src/`：React、TypeScript 前端。
- `src-tauri/`：Rust 后端和 Tauri 打包配置。
- `tests/`：前端测试。
- [中文使用手册](docs/user-manual/zh/README.md)：功能配置与排障参考。
- `docs/guides/`：具体功能的操作指南。
- `docs/pi-*.md`：Pi 功能约束与设计说明。
- [会话管理设计](session-manager.md)。
- [深链接生成器](deplink.html)：在本地浏览器打开后生成导入链接。

## 许可证

沿用 [MIT License](LICENSE)，保留原作者的版权声明。
