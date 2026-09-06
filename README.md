# CC Switch（个人自用版）

基于 CC Switch 修改的个人维护版本，用于管理本地 AI 工具的供应商配置、代理路由、MCP、Skills 和会话。

本版本通过本地源码构建和更新。使用说明以当前代码行为为准。

## 开发环境

- Node.js：参考 `.node-version`（22.12.0）。
- pnpm：参考 `package.json` 的 `packageManager`（10.12.3）。
- Rust：参考 `rust-toolchain.toml`（1.95）。
- 安装 [Tauri 2 平台依赖](https://v2.tauri.app/start/prerequisites/)；Windows 需要 Microsoft C++ Build Tools 和 WebView2。

## 常用命令

在项目根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm dev
```

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动桌面应用开发模式 |
| `pnpm dev:renderer` | 启动前端开发服务 |
| `pnpm typecheck` | 检查 TypeScript 类型 |
| `pnpm test:unit` | 运行前端测试 |
| `pnpm build:renderer` | 构建前端 |
| `pnpm build` | 构建本机平台的桌面应用及安装包 |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml` | 检查 Rust 格式 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 运行 Rust 测试 |

桌面应用构建产物位于 `src-tauri/target/release/`，安装包位于其 `bundle/` 子目录。更新前备份应用配置目录，再用本项目构建的新版本替换已安装版本。

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
