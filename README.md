# CC Switch（个人自用版）

基于 CC Switch 修改的个人维护版本，用于管理本地 AI 工具的供应商配置、代理路由、MCP、Skills 和会话。

仅发布 Windows x64，提供 MSI、NSIS EXE 和便携 ZIP。下载见 [本仓库 Releases](https://github.com/cloud-wyf/cc-switch/releases)；上游仓库只作为源码来源。

## 开发

工具链以 `.node-version`、`rust-toolchain.toml` 和 `package.json` 的 `packageManager` 为准。Windows 开发需安装 [Tauri 2 平台依赖](https://v2.tauri.app/start/prerequisites/)；供应商 TypeScript 代理脚本需要 Node.js 24+。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

| 命令                  | 用途                                   |
| --------------------- | -------------------------------------- |
| `pnpm dev:renderer`   | 启动前端开发服务                       |
| `pnpm typecheck`      | 检查 TypeScript 类型                   |
| `pnpm test:unit`      | 运行前端测试                           |
| `pnpm build:renderer` | 构建前端                               |
| `pnpm build`          | 本机打包 Windows x64，需要已有签名私钥 |

## 发布与更新

对助手说“发布”，默认执行提交源码、推送 main/Tag、GitHub Actions 编译签名并发布 Release、下载核验。`pnpm release` 默认使用 GitHub；`pnpm release:local` 仅用于明确指定的本机发布。

公开仓库使用标准 `windows-2022` Runner。版本规则、签名配置、发布步骤和失败恢复集中在 [Windows 发布规范](docs/guides/local-release.md)。私钥仅存于维护者本机及 Actions Secrets。

安装版在「设置 → 关于」中检查、下载并验签安装更新；便携版从 Releases 下载替换。更新检查默认匿名访问 GitHub API，可在「设置 → 关于」填写自己的 GitHub API Token 以使用个人请求额度；清空 Token 恢复匿名。清单与安装包使用公开 Release 直链下载，令牌只用于 API 请求并仅保存在本机。仅推送源码不会产生应用更新。

## 文档

- [个人版手册](docs/personal/README.md)：自用功能配置与排障。
- [上游同步指南](docs/guides/upstream-sync.md)：同步步骤与自用保留规则。
- [自用版 4.0 源码升级](docs/guides/v4-local-upgrade.md)：功能入口及数据库迁移。
- [供应商 TypeScript 代理脚本](docs/guides/provider-proxy-script-zh.md)。
- [详细请求日志](docs/guides/provider-proxy-event-logs-zh.md)。
- [会话管理设计](session-manager.md)。
- [深链接生成器](deplink.html)。

`src/` 为 React/TypeScript 前端，`src-tauri/` 为 Rust 后端，`tests/` 为前端及发布测试。个人预设与翻译分别维护在 `src/config/personalProviderPresets.ts` 和 `src/i18n/personal/`；上游多语言介绍、手册和发布说明保留为参考。

## 许可证

沿用 [MIT License](LICENSE)，保留原作者版权声明。
