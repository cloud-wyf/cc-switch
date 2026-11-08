# 上游同步指南（个人自用版）

本指南用于把 `farion1231/cc-switch` 的更新合入 `cloud-wyf/cc-switch`，同时保留本项目的自用定制。同步源码、提交源码、发布安装包是独立操作；只有用户要求提交、推送或发版时，才执行相应操作。

## 1. 同步目标与仓库约定

| 项目                | 约定                                                                            |
| ------------------- | ------------------------------------------------------------------------------- |
| 自用仓库 `origin`   | `https://github.com/cloud-wyf/cc-switch.git`                                    |
| 上游仓库 `upstream` | `https://github.com/farion1231/cc-switch.git`，只获取更新                       |
| 日常分支            | `main`，追踪 `origin/main`                                                      |
| 默认同步目标        | 上游最新非预发布 Release 对应的提交；明确要求未发布代码时才选择 `upstream/main` |
| 合并方式            | 合并已固定的提交 SHA，保留已推送的自用历史，不改写历史                          |
| 应用更新来源        | 仍为自用仓库 `cloud-wyf/cc-switch`；合入上游源码不等于改回上游安装包                              |

不要直接执行 `git pull upstream main`。先获取和比较，再决定如何合并。不要把上游版本 Tag 导入本地 `refs/tags`：自用版本可能使用相同的 Tag 名称，但指向不同提交。

## 2. 必须保留的自用改动

| 范围           | 合并规则                                                                                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 自用仓库更新   | 保留 `src-tauri/src/services/app_updater.rs` 的 `cloud-wyf/cc-switch` 更新源、后端可选 GitHub Token 与匿名检查、公开附件直链、签名验证，以及应用内检查、下载、安装和重启。允许吸收错误提示等独立修复。                                                                      |
| 应用身份和签名 | 保留 `src-tauri/tauri.conf.json` 的应用标识和现有更新公钥。私钥仍在维护者本机和 Actions Secret，不更换、不提交、不输出。                                                                                                                      |
| 构建和发布     | 保留 Windows x64（`x86_64-pc-windows-msvc`）、MSI、NSIS、便携 ZIP、三项 Windows 更新清单，以及 `scripts/release.mjs` 的默认 GitHub 构建逻辑；本机构建仅在明确指定时使用。                                                                                   |
| CI             | 保留普通 Windows x64 CI 和手动 WSL2 检查，不恢复多平台矩阵、每日 WSL2 或上游推广工作流。                                                                                                                                                      |
| 供应商 | 原始 `src/config/*ProviderPresets.ts` 与上游同步；应用入口统一读取 `src/config/personalProviderPresets.ts` 的过滤结果。保留当前名单、顺序、无推广链接、NewAPI 与自定义网关。上游新增预设只作为原始输入，不自动进入自用名单；保留条目的模型、协议和端点修复继续吸收。 |
| 供应商兼容性   | 保留旧数据的兼容字段及必要的认证逻辑；不得把删除推广界面扩大为破坏已保存的供应商数据。模型价格、通用图标、手动配置能力和代理修复按功能判断，不因涉及第三方名称而一并删除。                                                                    |
| 宣传和文档 | 保留个人版 README、MIT 许可和 `docs/personal/` 自用说明。上游多语言介绍、手册及发布说明保留为参考并随上游更新；不将其中的推广入口恢复到产品界面。安装和发布以个人版 README 与自用规范为准。 |
| 依赖           | 保留本项目为安装包更新修复而对齐的 Tauri 前后端依赖。版本号冲突只改应用包版本，不以整份上游锁文件覆盖本地依赖。                                                                                                                               |

这些是用户已确认的定制要求，优先于通用同步工具的“远端优先”默认规则。对本表之外的功能冲突，先读两侧实现与提交理由；无法判断时把具体差异交给用户决定。

后续同步还必须保留：

- 供应商 TypeScript 代理脚本、独立开关、语法校验、Windows Node 查找，以及切换或保存当前脚本供应商时自动启用本地路由。已在聚合模式时不得因切换脚本开关退回普通路由。
- 独立的 `proxy-events.db`、完整请求链路记录、请求类型分类、按类型保留、多选筛选和筛选记忆；主库备份与云同步不得夹带详细日志。
- 退出单个应用的路由或聚合模式后，共享路由保持运行；用户明确关闭整个本地路由或退出应用时才停止。启用失败只能回收本次启动的服务，不能关闭已经运行的服务。
- 自用数据库迁移历史：19/20 为详细日志迁移，21 为 MiniMax Code，22 为 Pi MCP；23 为 Antigravity，24 为 Kimi，25 为 Oh My Pi MCP，26 为 DSH 和会话解析游标。不能直接使用上游同名版本号替换这些迁移。
- 旧界面组件被上游替换时，将功能和回归测试迁移到实际使用的新入口，不能只保留无人调用的旧文件。

## 3. 预检、获取和比较

以下命令在 Windows PowerShell 的项目根目录运行。每条 Git、gh 或 pnpm 命令出现非零退出码时先处理原因，再执行下一步。

```powershell
git status --short --branch
git remote -v
git log -8 --oneline
$syncBefore = git rev-parse "HEAD"
```

确认处于 `main`、没有进行中的合并、工作区和暂存区干净。已有修改必须先妥善保存，不能覆盖。若只是本轮刚新建、上游不存在的指南，可按精确路径临时保存：

```powershell
git stash push --include-untracked -m "upstream-sync: preserve new guide" -- "docs/guides/upstream-sync.md"
$syncGuideStash = git rev-parse "stash@{0}"
```

仅在确实新建了该指南且本次 stash 成功创建后记录这个 SHA；不要误用旧 stash，也不要把其他未提交文件或构建缓存一起收走。

获取上游主分支，并查询最新稳定版。明确区分最新 Release 和尚未发布的 `main`：

```powershell
git fetch --no-tags "upstream" "refs/heads/main:refs/remotes/upstream/main"
$syncRelease = gh api --method GET "repos/farion1231/cc-switch/releases/latest" | ConvertFrom-Json
$syncTag = $syncRelease.tag_name
$syncExpected = gh api --method GET "repos/farion1231/cc-switch/commits/$syncTag" --jq ".sha"
git fetch --no-tags "upstream" "refs/tags/$syncTag"
$syncTarget = git rev-parse "FETCH_HEAD^{commit}"
if ($syncTarget -ne $syncExpected) { throw "上游 Tag 发生变化，重新核对目标" }
$syncBase = git merge-base "$syncBefore" "$syncTarget"
git rev-list --left-right --count "$syncBefore...$syncTarget"
git log --oneline "$syncBefore..$syncTarget"
git diff --stat "$syncBase" "$syncTarget"
git diff --name-status "$syncBase" "$syncTarget"
git diff --name-status "$syncBase" "$syncBefore"
```

`rev-list` 的左列为自用提交数，右列为未合入的上游提交数。记录本次同步前 SHA、上游 Tag 和固定的目标 SHA。若目标已是当前提交的祖先，则无需再次合并。

## 4. 合并并逐项处理冲突

```powershell
git merge --no-ff --no-commit "$syncTarget"
git diff --name-only --diff-filter=U
```

`--no-commit` 让结果先进入可检查状态，不自动创建提交。冲突导致的非零退出码不等于合并失败；继续查看冲突。不要全局使用 `-X ours`、`-X theirs` 或整目录取一侧。

对每个冲突文件，结合以下内容手工合并：

```powershell
git show ":1:路径"
git show ":2:路径"
git show ":3:路径"
git diff "$syncBase" "$syncBefore" -- "路径"
git diff "$syncBase" "$syncTarget" -- "路径"
```

`:1` 是共同基线，`:2` 是自用版，`:3` 是上游。新增或删除文件可能缺少某一阶段，按实际状态处理。

- **纯功能修复**：吸收上游改动，并保留互不冲突的自用行为。
- **供应商预设冲突**：原始目录和原始目录测试跟随上游；自用名单及链接只改 `personalProviderPresets.ts`。产品入口、新应用及其派生目录必须读取自用结果；运行个人版名单测试，不能仅靠界面隐藏。
- **删除/修改冲突**：已恢复的原始介绍、参考文档和预设测试跟随上游，不再继续删除。其他文件核对删除原因；产品推广入口仍不恢复。
- **没有冲突的新增内容**：同样复查。上游参考文档和原始预设测试可以保留；产品中新增的推广入口仍不纳入。新应用需要显式接入自用名单，不能直接展示原始完整目录。
- **更新错误显示**：保留私有更新链路，并合入上游更准确的错误描述，避免退回只显示通用失败信息。

解决后对具体文件执行 `git add -- "路径"`；确认继续删除的具体文件执行 `git rm -- "路径"`。不批量恢复整个目录。临时保存的指南用记录的 SHA 恢复：

```powershell
git stash apply "$syncGuideStash"
```

确认指南已恢复后再清理本次 stash；保留其他 stash。合并结果和同步记录完成后，在 README 中加入指南入口。

## 5. 版本和依赖

合入完整稳定版时，四处应用版本统一到目标稳定版，例如本次 `4.0.27`：

- `package.json` 的 `version`。
- `src-tauri/Cargo.toml` 的 `[package].version`。
- `src-tauri/tauri.conf.json` 的 `version`。
- `src-tauri/Cargo.lock` 中 `cc-switch` 包的 `version`。

后续基于 `4.0.27` 的自用修订从 `4.0.28-1` 开始。只有同步源码时不创建任何 Tag；等实际发版时，才把自用 Tag 指向包含本地定制的提交。上游 Tag 的 SHA 仅作为同步来源记录。

```powershell
node "scripts/validate-release.mjs"
pnpm install --frozen-lockfile
```

如果依赖声明没有变化，不无故升级依赖或重建锁文件。锁文件只在应用版本或确有依赖变更的位置调整。

## 6. 验证合并结果

先检查冲突和自用约束：

```powershell
git diff --name-only --diff-filter=U
git diff --check
git diff --cached --check
git diff "$syncBefore" --stat
git diff "$syncBefore" -- ".github/workflows" "scripts" "src-tauri/src/services/app_updater.rs" "src/lib/updater.ts"
```

确认私有更新源、公钥、构建目标、发布回退和应用实际显示的供应商名单保持约定，且产品未重新带入推广内容。不要将私钥、Token 或本机真实配置写入日志。

按变更范围验证。涉及这次的代理、供应商和用量模块时，执行前端全量检查及 Windows x64 后端测试：

```powershell
pnpm typecheck
pnpm test:unit
pnpm build:renderer
cargo fmt --check --manifest-path "src-tauri/Cargo.toml"
cargo clippy --locked --target x86_64-pc-windows-msvc --manifest-path "src-tauri/Cargo.toml" -- -D warnings
cargo test --locked --jobs 1 --no-fail-fast --target x86_64-pc-windows-msvc --manifest-path "src-tauri/Cargo.toml" -- --test-threads=1
```

前端测试包含私有更新、供应商和发布脚本测试。后端测试使用测试专用目录；核对 `src-tauri/tests/support.rs` 的隔离逻辑，避免操作本机真实配置。`--jobs 1` 限制编译并发，降低 Windows 大型调试库的内存压力；`--test-threads=1` 另外限制测试执行并发，两者作用不同。格式检查重点覆盖改动文件；若全量检查有原有问题，明确区分并记录，不把无关格式重排混进同步。

Windows 符号链接测试需要相应权限。若在创建测试链接时返回错误 1314，记录具体用例和未验证范围；`--no-fail-fast` 让其他测试目标继续执行。在具备符号链接权限的 Windows 环境复跑受影响用例，不修改断言掩盖失败，也不为同步源码自动修改系统设置。单独复跑某个用例时，可在 Cargo 参数中使用 `--lib` 或 `--test skill_sync`，后接完整用例名称，再加 `-- --exact`。

涉及安装包配置、更新链路或依赖变化时，再按 [Windows 发布规范](local-release.md) 中的本机签名配置执行 `pnpm build` 并验签；单纯合入源码不执行 `pnpm release`。CI 因额度停止时，如实记录本机验证结果，不能把未运行的云端检查写成通过。

## 7. 记录与交付

每次同步在本指南末尾记录：同步前提交、目标 Tag/SHA、纳入的关键修复、按自用要求未引入的上游内容、版本与验证结果。

合并待提交时，`git status` 会显示仍在合并流程中；在用户授权提交前保留该状态。后续授权提交时应完成此次合并提交，使上游目标成为本地历史的祖先。推送自用 `main` 不等于发布应用；推送后按 [Windows 构建与发布规范](local-release.md)发布新版本，已安装的应用才能收到更新。

## 同步记录

### 2026-09-12：同步 v3.20.3

- 同步前自用提交：`5fa65910c5aa3dacb7b75b469c2ea87009379dd8`。
- 上游 Tag：`v3.20.3`；固定提交：`d695a2d77fd9081eafd3e9eedcbf2a97b3410928`，与同步时的上游 `main` 一致。
- 共同基线：`db34612807244643d85ccedf9704c965facc4cba`；本次处理 48 个上游提交，所有合并冲突已解决。
- 应用版本四处统一为 `3.20.3`。保留现有 Tauri 依赖和锁文件中的依赖版本。
- 纳入代理转换和图片请求修复、各应用代理设置隔离、统一供应商子卡元数据保留、Windows Codex 用量游标、托盘账号额度、Claude Artifact 工具开关、模型定价等更新。
- 10 组预设名单与同步前完全一致；对上游有改动的 16 个保留预设做逐字段比对，其更新全部纳入，包括 Kimi 原生 Responses、Kimi 并行工具能力及 MiniMax M3。同步调整了相关测试和手册。
- 私有更新源、GitHub 认证、应用标识、公钥、Windows x64 构建与发布脚本均保持原有定制；吸收更新错误信息的提取改进。
- 未引入上游项目介绍、发布宣传、SoleAPI 赞助横幅、促销文案及已删除供应商的预设和专用测试。自动合入的 AtlasCloud 条目已移除。通用图标、模型能力与定价更新保留；DeepSeek 官方视觉模型的回归断言纳入现有测试。
- 已通过：版本一致性、锁定依赖安装、TypeScript、前端 132 个测试文件中的 964 项测试、前端生产构建、Rust 格式、Windows x64 Clippy（`-D warnings`）、冲突和差异空白检查。
- Windows x64 后端验证：单元测试 2,834 项通过，集成测试 127 项通过，共 2,961 项通过；3 项因本机缺少符号链接权限而未通过，另有 6 个单元测试和 2 个文档测试原有忽略。入口程序和测试辅助目标均无测试用例，执行成功。
- 权限受限的 3 项既有用例：`codex_config::tests::resolve_catalog_rejects_symlink_escaping_config_dir`、`services::session_usage_grokbuild::tests::symlink_cycle_does_not_cause_stack_overflow`、`skill_sync` 中的 `sync_to_app_removes_disabled_and_orphaned_ssot_symlinks`。均在创建符号链接时返回 Windows 错误 1314，未执行到对应功能断言；已核对其测试代码未被本次同步修改。受连带互斥锁中毒影响的卸载备份用例单独复跑通过。
- 编译环境问题已解决：首次默认并行编译触发 Windows 错误 1455（页面文件不足，无法映射大型调试库），并产生标准库和元数据的连带错误。相同源码、依赖、工具链、隔离目录和缓存下，单目标及完整测试集使用 `--jobs 1` 后均编译成功；没有修改系统内存设置或应用代码来处理该问题。
- 格式检查：本次其余修改文件及新指南通过 Prettier；三种语言的 `2.1-add.md`、`4.5-model-test.md` 和 `codex_deepseek_catalog_template.json` 共 7 个文件在同步前已经不符合当前 Prettier 格式，保留原有排版并记录，不做无关整篇重排。
- 本机验证日志位于已忽略的 `release/validation/upstream-v3.20.3/`。本次没有触发云端构建、上传安装包或发布 Release。
- 交付检查结果时保留待提交的合并状态，没有提交、推送或创建自用版本 Tag。后续提交须保留上游作为合并父提交；实时状态以 `git status` 和 `git log` 为准。

### 2026-09-23：同步 v3.20.4

- 同步前自用提交：`21dd9881`（自用版 `3.20.4-6`）。
- 上游 Tag：`v3.20.4`；固定提交：`43e1d99084ed9b2f5dc252fd35c5adaf29d6876e`。共同基线：`d695a2d77fd9081eafd3e9eedcbf2a97b3410928`；本次处理 48 个上游提交。
- 应用版本四处统一为 `3.20.4`；`Cargo.lock` 保留自用依赖，只改 `cc-switch` 包版本。
- 纳入 MiniMax Code 应用支持、OpenCode 拉取模型批量添加、技能安装与大仓库修复、提示词外部编辑刷新、代理转换修复（工具描述、图片 detail、additional_tools、GPT-5.6 max effort、Copilot stop 参数）、WSL 版本探测、Codex 账号绑定恢复、DeepSeek V4.1 Flash、MiniMax 新官方端点、Kimi For Coding K2.8 等更新。
- 数据库：自用 v19/v20（详细请求日志迁移）保持不变，上游 v19 的 `enabled_mcode` 列改为 v20 → v21 迁移，`SCHEMA_VERSION` 为 21。
- 10 组预设名单与同步前一致；保留条目的上游字段更新全部纳入（逐字段比对无遗漏）。新的 MiniMax Code 预设由 Pi 预设派生，随 Pi 名单自动收敛。
- 未引入：Kimi Global / Kimi For Coding Global 变体、Soshow、FluxA 等新增合作预设及推广文案、关于页 GitHub Star 提示、多语言 README、CHANGELOG、发布说明和赞助横幅。CI 仅在 Windows x64 任务中吸收新增的前端构建步骤。
- 自用测试随上游调整：DeepSeek 预设改为断言官方模态（Flash 文本+图像，Pro 纯文本）；修正上一版详情页去掉返回按钮后未同步的 `ProxyEventLogViewer` 测试；`cargo fmt` 修正两处既有格式问题。
- 已通过：版本一致性、锁定依赖安装、TypeScript、Prettier、前端单测（`App.test.tsx` 全量下的超时为既有负载噪声，单独运行 9 项全过）、前端生产构建、Rust 格式、Windows x64 Clippy（`-D warnings`）。
- Windows x64 后端测试：库测试 2,940 项通过、10 项忽略；失败仅为既有的符号链接权限（错误 1314）3 项及其连带的卸载备份用例。

### 2026-10-06：同步 4.0.2 后的上游 main

- 用户确认同步最新源码。同步前自用提交：`dd2229fda0438c0f2a752eea8ba4ec25869c1d87`；上游固定提交：`3af748231729d34d5dffdc49efda37188e35fc04`；共同基线：`43e1d99084ed9b2f5dc252fd35c5adaf29d6876e`。
- 目标包括 `v4.0.2`（`bf2fe0d0becbfc8473955af66010c6b13f51b1e8`）及其后的 4 个提交：Claude 自动模式字段投影、MCP/提示词全页编辑及未保存保护、MiMo 预设更新、OpenCode v2 原生配置往返。共纳入 242 个上游提交；80 个冲突文件已逐项处理。
- 自用版本四处统一为 `4.0.3-1`。保留 Tauri 与 framer-motion 的自用依赖版本；新增上游界面需要的 `tailwindcss-animate`。Cargo 锁文件仅调整应用版本。
- 采用上游侧边栏、直连/路由/聚合模式、配置字段投影、会话阅读和用量页面。脚本表单、卡片开关、详细请求日志及其配置入口接入新界面；旧 ProxyPanel 和 RoutingActivationBrand 的功能转入模式页及路由设置页，相关测试同步迁移。
- 脚本保存与切换继续执行语法校验和自动启用路由；在聚合模式中切换脚本开关保持聚合。启用脚本的供应商不再显示会误导用户的“仍然直连”选项。退出单个应用前保留脚本停用提示。
- 保留退出应用接管后共享路由继续运行、失败启用只回收本次启动的路由、Claude Desktop 脚本接入、Windows Node 查找和请求日志链路。日志库回收空闲页同时吸收上游完整遍历 vacuum 结果的修复。
- 数据库保留自用 v19/v20/v21 历史，新增 v21 → v22 的 Pi MCP 列迁移。回归覆盖从自用 19/20/21 升级并保留已有 MCP 开关及独立日志内容。
- 各应用预设名单与同步前一致，MiniMax Code 仍从 Pi 派生；统一供应商保留 NewAPI 和自定义网关。按 AST 逐字段吸收保留预设的上游修改，同时保留无推广参数的链接。新增名单和链接约束测试；通用表单/协议测试使用独立测试预设，不恢复生产名单中的已删除条目。
- 私有更新实现、应用标识、公钥、Windows x64 发布脚本和发布 workflow 保持自用约定。普通 CI 保持 Windows x64；手动 WSL2 检查吸收上游工具链、超时及 WSL SQLite 限制处理，不启用定时任务。
- 未引入上游推广横幅、完整合作预设、多语言项目 README、发布宣传文档、官网托盘入口和多平台发布流程。应用内近期更新摘要保留；新版引导中的版本发布链接指向私有仓库。
- 已通过：版本一致性、锁定依赖安装、TypeScript、前端生产构建、Rust 格式和 Windows x64 Clippy（`-D warnings`）。前端全量复跑 1593 项通过；最后一项私有发布链接断言修正后，相关 5 个文件 30 项全部通过，包含新增的脚本模式保护用例。没有未处理的前端失败。
- Windows x64 后端最终验证：库测试 3380 项通过、10 项原有忽略；集成测试 181 项通过，共 3561 项通过。仅 3 项既有 Windows 符号链接测试因错误 1314 无法执行功能断言：`codex_config::tests::resolve_catalog_rejects_symlink_escaping_config_dir`、`services::session_usage_grokbuild::tests::symlink_cycle_does_not_cause_stack_overflow`、`skill_sync::sync_to_app_removes_disabled_and_orphaned_ssot_symlinks`。未修改系统权限或跳过断言。初次测试中的 3 处 Windows 文件占用错误 1175 在复跑中全部通过。
- `git diff --check` 仅剩上游新增的三个逐字节金标文件 `src-tauri/tests/golden/snapshots/rows/deeplink-{codex,gemini,grokbuild}.txt` 的末尾空行提示；文件与上游原样一致，金标测试通过，不修改用于验证真实输出的空白。无未解决冲突或冲突标记。
- 原始源码、完整自用差异及未提交补丁保存在已忽略的 `release/validation/upstream-main-3af74823/`；本次 stash 为 `24b7cac45583bcd6dd636fe198fbd0275dff0a07`，保留作额外恢复来源。日志过滤菜单的 `z-[100]` 修复已按原样恢复，并保持未暂存。
- Windows x64 发布构建成功：生成 `CC Switch_4.0.3-1_x64_en-US.msi` 和 `CC Switch_4.0.3-1_x64-setup.exe` 及各自 `.sig`。使用项目现有公钥独立验签，两项均通过；同时确认可执行程序嵌入最终前端入口 `index-CF3odHnh.js` 和 `index-BGj--Ucx.css`。制品 SHA-256 及大小记录在验证目录的 `artifacts.json`，未安装或上传。
- 前端最终补查：脚本供应商的模式确认框不提供会与脚本自动路由冲突的“仍然直连”选项；脚本关闭后仍可直连。相关模式页、脚本编辑器、卡片开关和新版引导共 30 项回归全部通过。最终源码再次通过 TypeScript 和前端生产构建。
- 交付状态为待提交的合并：`HEAD` 仍为同步前提交，`MERGE_HEAD` 为本次固定上游提交。未创建分支或合并提交，未推送或发布 Release；日常配置和数据库未用于验证，后端测试使用隔离目录。

### 2026-10-06：准备本机发布 v4.0.3-1

- 用户随后要求本机打包并发布至私有远程。将原有日志菜单层级修复纳入发布源码，并完成保留双父提交的合并；版本 Tag 使用 `v4.0.3-1`。
- 补齐四语应用内更新摘要；自用数字预发布号的详情链接打开私有 Release，上游摘要保留官网入口。摘要、链接及弹窗相关 22 项测试通过，TypeScript 与修改文件格式检查通过。
- 发布前检查发现 Vitest 的文件匹配遗漏 `.mjs`，已补入，使原有发布脚本测试纳入默认测试集；两份发布测试共 35 项通过。
- 完整发布按 `pnpm release:local --tag v4.0.3-1` 执行：从已提交源码重新构建、验签并上传 MSI、NSIS、便携 ZIP 和更新清单。远程发布状态以该 Tag 的 Release 为准，本条记录本次发布准备及验证结果。

### 2026-10-08：同步 v4.0.4 稳定版

- 用户确认同步稳定版，不纳入其后尚未发布的 main 提交。同步前自用提交：`68f9177fc81b99ee4f4f74709d95e9ebbc7e03e4`（`4.0.3-2`）；上游 Tag：`v4.0.4`；固定提交：`a29a4f3868e9c6ffc2212957cfa66a718642e344`；共同基线：`3af748231729d34d5dffdc49efda37188e35fc04`。共纳入 34 个上游提交，24 个冲突文件已逐项处理。
- 四处应用版本统一为 `4.0.4`；依赖版本不变，Cargo 锁文件只调整应用版本。保留私有更新源、认证和验签、应用标识、公钥、Windows x64 发布流程及现有 CI。
- 纳入混合 LF/CRLF 流式响应处理、关闭思考及模型最低推理档位、OpenCode Go 网关身份兼容、用量后台写入与缓存 Token 统计、模型成功率/速度、Codex Credits 余额、备份占用总览、Skills 全选与导入同步修复、Claude 快捷开关说明和自动模式检查开关、窄窗口速度列及项目切换器默认隐藏等更新。
- 切换日志在脚本校验、供应商切换和脚本路由启用全部返回后记录最终结果；模式确认框保留脚本供应商的直连限制，同时吸收上游操作日志。继续保留共享路由退出语义、独立详细请求日志和自用数据库 v19–v22 迁移历史。
- 所有 11 份供应商预设文件与同步前一致；本轮上游预设变更仅涉及自用名单外的条目。未引入 OpenCode Zen、模力方舟及已移除的其他预设、预设专用测试、Star 推广条、贡献者推广规范和发布宣传文档。通用网关兼容、图标、分组能力和应用内更新摘要照常吸收。
- 自用预设金标只增加四处 `CLAUDE_CODE_AUTO_MODE_SERVER: "0"`，对应新增第三方供应商的默认值；原有官方入口、模型、认证字段和自用名单保持不变。应用集成测试首次在全量高并发下超时并影响下一例，未修改断言，单独复跑 21 项全部通过。
- 原有 7 个未提交文件先备份后暂存，合并后按原始字节恢复并保持未暂存。备份、补丁、校验记录和测试日志位于已忽略的 `release/validation/upstream-v4.0.4-20261008/`；本次 stash `ee63d6b30ebbc6daa3afe029fd2130e0857b7a89` 保留作额外恢复来源。
- 已通过版本一致性、锁定依赖安装、TypeScript、前端生产构建、修改的前端文件 Prettier、Rust 格式及 Windows x64 Clippy（`-D warnings`）。前端全量复跑限制两个 worker，196 个测试文件、1733 项测试全部通过。
- 首次 Windows x64 后端验证：单任务编译完成；库测试 3408 项通过、10 项原有忽略，集成测试 181 项通过，共 3589 项通过。仅 3 项既有符号链接测试因 Windows 错误 1314 无法执行功能断言：`codex_config::tests::resolve_catalog_rejects_symlink_escaping_config_dir`、`services::session_usage_grokbuild::tests::symlink_cycle_does_not_cause_stack_overflow`、`skill_sync::sync_to_app_removes_disabled_and_orphaned_ssot_symlinks`。首次验证时这三个文件与同步前一致，未修改系统权限或测试断言。
- 用户随后要求停用这三项测试。按 Windows 条件添加带原因的 `ignore`，保留完整测试代码和断言；其他平台继续默认执行。Windows 具备符号链接权限后，可按测试名称配合 `-- --ignored --exact` 手动运行。修改后 Rust 格式检查通过，符号链接定向验证 5 项通过、这 3 项忽略、无失败。
- 保留待提交的合并状态：`HEAD` 仍为同步前自用提交，`MERGE_HEAD` 为本次固定上游提交。未创建或切换分支，未提交、推送、创建 Tag、发布或安装；测试使用隔离目录，不使用日常配置数据库。

### 2026-10-17：同步 v4.0.14 稳定版

- 同步前自用提交：`fbc256390ab67a55b811d92aa8e10e11db0db580`；上游 Tag：`v4.0.14`，固定提交：`5de6feb4e5adda61f4ad824ce0df2c449245f447`；共同基线：`a29a4f3868e9c6ffc2212957cfa66a718642e344`。纳入基线之后的 277 个上游提交。
- 应用版本统一为 `4.0.14`，版本校验通过；保留私有更新仓库 `cloud-wyf/cc-switch`、签名公钥、应用标识和 Windows x64 发布约定。上游 `farion1231/cc-switch` 仅作为源码来源。
- 纳入 Codex/Gemini 工具调用与代理重试修复、Skills 大仓库下载限制调整、侧栏用量显示和请求日志列自定义、币种显示、终端目录记忆、OpenCode 与用量统计修复及新增模型定价等上游改进。保留自用共享路由服务生命周期、数据库 v19–v22 迁移历史、自用预设名单和详细请求日志行为。
- 未引入上游赞助推广、促销内容、第三方项目发布流程及不属于自用名单的供应商预设，也没有新增预设卡或更改自用供应商名单。保留的 Claude 预设只吸收 1M 上下文能力字段调整；套餐用量检测改进到现有供应商及应用。
- TypeScript、前端 Vitest（230 个文件、2240 项）和 renderer 构建此前已通过。Rust `cargo fmt --check`、Windows x64 Clippy（`-D warnings`）通过；最终 Windows x64 后端全量测试通过：库测试 3775 项、集成测试 184 项，共 3959 项通过、13 项忽略（其中 1 项因 Windows 符号链接权限忽略）。Codex 显式远程压缩能力定向复跑通过。`git diff --check` 工作树检查通过；暂存检查只提示两份新增 golden 快照按测试要求保留的末尾空行，定向和全量测试均通过。
- 合并冲突已解决，当前 `HEAD` 仍是同步前提交，`MERGE_HEAD` 指向上述上游提交；改动保持待提交。未创建分支、未提交或推送、未创建 Tag、未发布或安装；验证使用测试隔离目录，没有使用日常配置数据库。

## 自用差异隔离规则

- `src/config/personalProviderPresets.ts` 是应用预设入口，原始目录保留上游全部条目。类型、协议辅助函数仍从原始模块导入。
- 新增应用的派生预设同样通过个人模块过滤；Kimi / Oh My Pi / DSH 沿用原有五项国产供应商名单，官方账号登录入口独立保留。`presetModelMetadata.ts` 和 `ClaudeFormFields.tsx` 的模型/协议识别读取完整目录，确保已有供应商与手动配置仍可使用上游兼容修复。
- `src/i18n/personal/` 只存自用新增和覆盖文案；五份 `locales/*.json` 保持上游原样。在初始化时递归覆盖，未覆盖字段继承上游。
- `docs/personal/` 保留个人版改写，原始手册、发布说明与多语言介绍仅作上游参考。迁移时保留原有相对链接的实际目标。
- `tests/config/personalProviderPresets.test.ts` 验证过滤后的名单、顺序、链接和模型参数继承；上游目录测试读取原始目录。
- 不通过恢复参考数据改变私有更新、代理脚本、详细日志、路由生命周期或自用数据库迁移。

### 2026-11-07：隔离预设、翻译和参考文档

- 上游基线仍为 `v4.0.14` / `5de6feb4e5adda61f4ad824ce0df2c449245f447`；本次未合入新的上游版本。
- 11 个原始预设模块、25 个原始目录测试、五份语言 JSON 及 189 份参考文档恢复为基线内容；自用名单和无推广链接集中处理，43 份改写文档保存在 `docs/personal/`。
- 迁移前后 11 份自用目录逐字段比较一致，包含名单、顺序、模型参数、认证字段及链接。五份语言的全部原有字段保持原值；此前未提交的五个卡片、列表、侧栏源码文件逐字节保留。
- 以固定 `v4.0.22` 提交 `b76426741ef93069e2f374ac01ca7ef5760e1d0e` 模拟合并：包含原有未提交改版的操作前工作区为 76 个冲突文件，操作后为 33 个，减少 43 个（约 57%）；45 个旧冲突消除，Pi/MiniMax Code 两个表单新增小范围预设入口冲突。模拟使用独立临时索引和 Git tree，未创建提交、未改动真实暂存区。
- 验证通过：TypeScript、最终前端 247 个测试文件共 2536 项、renderer 生产构建、自用修改文件 Prettier、版本校验、差异空白检查及个人版文档链接检查。构建保留原有的大 chunk 提示；未改依赖。
- 后端、代理脚本、详细日志、共享路由、签名、公钥、私有更新与发布实现均未修改，本次不重跑后端构建；未操作日常配置数据库，未提交、推送或发布。
- 操作前备份、逐字段比较、冲突模拟和测试日志位于已忽略的 `release/validation/conflict-isolation/`。

### 2026-11-07：同步 v4.0.27 稳定版

- 用户要求继续执行同步。同步前自用提交：`e928dd85e26feeaa0abd52f0405ded237585c7bb`；上游最新非预发布 Release 为 `v4.0.27`，固定提交 `26629ff49f0ca3c2ea9fee426ce8e911d52d2a85`；共同基线仍为 `v4.0.14` / `5de6feb4e5adda61f4ad824ce0df2c449245f447`。纳入基线之后的 480 个上游提交，不纳入其后未发布的 main 代码。
- 包含原有未提交界面改版、同一目标 SHA 的比较：隔离前 86 个冲突文件，隔离后 43 个，减少 50%。46 个旧冲突消除，新增三个预设入口/测试导入冲突。上游原始预设、翻译和参考文档已自动合并；保留个人覆盖层。
- 保存 317 个修改或新增文件的副本、二进制补丁及完整 Git tree。额外 stash 为 `affef4c9478a4e86a27b5ac299d88b076905b7a9`，保留作恢复来源。三方合并使用包含本地工作区改造的 tree，真实合并仍保留同步前 HEAD 与目标 MERGE_HEAD；没有创建提交。
- 纳入 Claude 官方账号切换、Kimi Code / Antigravity / Oh My Pi / DeepSeek Harness、原生格式编辑、MCP 连通检查、Codex 官方额度保护、会话正文搜索、界面密度/缩放、托盘面板、模型定价搜索，以及代理、流式响应、工具调用、Skills、Windows CLI 检测、符号链接配置写入等修复。
- 保留分组行列表、不可拖动的当前项、中性背景、模式色细标记、主操作图标加文字及侧栏分区。分组行高和内距接入上游密度变量，舒适密度同样生效。吸收应用顺序拖动、套餐副标题及新增客户端行为。
- Kimi / Oh My Pi / DSH 的派生预设经个人模块过滤，继续使用原有五项国产供应商名单；官方账号登录入口独立保留。已有应用名单、无推广链接、NewAPI 和自定义网关保持原约定。原始目录和模型/协议识别使用完整上游数据，自用界面不展示推广。
- 吸收上游预设模型更新，包含 Kimi K3.1 Pro、DeepSeek Flash 默认值及 MiniMax M3.1 Flash。四份个人新增行快照经差异核对后更新；协议转换/原生往返测试使用独立 fixture，不以恢复生产供应商条目来满足测试。
- 自用数据库保留已发布 v19–v22，追加 v22→v23 的 Antigravity、v23→v24 的 Kimi、v24→v25 的 Oh My Pi MCP、v25→v26 的 DSH 与会话解析游标。现有迁移、独立日志库回归测试保留，并新增自用 v22–v25 升级测试。日志清理吸收上游启动后后台维护和备份失败不阻塞清理的修复。
- 代理同时保留脚本输送、Windows Node 查找、详细链路日志、脚本开关和自动路由；吸收上游加密子任务纠正、熔断许可回收及浏览器请求防护。Codex 公共/私有配置层保留，吸收官方登录快照与绝对模型目录指针的修复。退出单个应用继续保留共享服务，启用失败只回收本次新启动的服务。
- 合并回归发现 Codex 配置分层在普通路由切换前归档磁盘配置，会把相同客户端契约误判为变化。配置漂移继续在直连切换和编辑保存时归档；普通路由切换交给契约判断，不为归档而读取或改写客户端配置。上游的相同契约回归测试保持原断言并通过。
- 私有更新源、认证、验签、应用标识和公钥保持原约定；将 `REBOOT=ReallySuppress` 接入私有更新 builder，并吸收 MSI 模板的禁止自动重启属性。保留自用 Windows x64 发布与 CI；不恢复多平台发布、定时 WSL2 或推广流程。上游新增的自动关闭 schema PR 工作流仅在上游仓库生效。
- 五个 GitHub Issue/PR 模板恢复为上游参考，推广静态图片仅作为参考文档资源保留，产品没有增加推广入口。根个人 README 与本机发布流程保留。四处应用版本统一为 `4.0.27`；现有 Tauri 前后端和 framer-motion 自用依赖保留，新增必要 YAML/MCP/原生平台依赖及上游 TOML 解析修复。
- 逐字节保留检查通过：14 个原始预设模块与五份原始语言文件匹配目标上游；54 个个人文档、覆盖翻译和改版素材匹配操作前备份；应用标识、公钥和私有端点检查通过；没有代码冲突标记。
- 最终前端通过 312 个文件、3235 项测试，TypeScript、renderer 生产构建、自用修改文件 Prettier、版本一致性、Rust 格式及 Windows x64 Clippy（`-D warnings`）通过。
- Windows x64 最终后端全量：库测试 4534 项通过、16 项按项目/上游规则忽略；唯一失败为 `mode::controller::mode_tests::the_first_model_of_the_defaults_list_leads_the_aliases` 的临时目录 `live-state.json` 原子替换遇到 Windows 文件占用错误 1175。该用例在上一轮全量通过，保持代码和断言不变单独复跑后通过。全部集成测试 214 项通过、1 项按现有 Windows 符号链接规则忽略。合计 4749 个用例获得通过结果、17 项忽略；没有未处理的功能失败，未把带 1175 失败的全量命令记为零失败退出。证据为 `backend-complete.log` 与 `claude-alias-retry.log`。
- 库测试编译保留上游 `SystemKeychain::named` 在 Windows 测试配置下未使用的警告；普通 Windows Clippy 的 `-D warnings` 检查通过。前端构建保留上游/既有的大 chunk、Browserslist 与 baseline-browser-mapping 提示，没有为消除提示更新无关依赖。
- 差异检查仅保留两份原有文档的历史空白：`docs/release-notes/v3.8.0-ja.md` 的 Markdown 硬换行与上游原样一致，`docs/personal/user-manual/zh/5-faq/5.2-questions.md` 的空白行与操作前副本一致；其他文件的差异空白检查通过。未修改原始文档来消除这些提示。
- 验证与备份位于已忽略的 `release/validation/upstream-v4.0.27-20261107/`。工作保持待提交合并；未创建或切换分支，未提交、推送、创建 Tag、发布或安装，验证不使用日常配置数据库。
