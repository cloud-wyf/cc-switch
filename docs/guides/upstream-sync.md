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
| 应用更新来源        | 仍为自用私有仓库；合入上游源码不等于改回上游安装包                              |

不要直接执行 `git pull upstream main`。先获取和比较，再决定如何合并。不要把上游版本 Tag 导入本地 `refs/tags`：自用版本可能使用相同的 Tag 名称，但指向不同提交。

## 2. 必须保留的自用改动

| 范围           | 合并规则                                                                                                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 私有仓库更新   | 保留 `src-tauri/src/services/app_updater.rs` 的 `cloud-wyf/cc-switch` 更新源、后端 GitHub 认证、签名验证，以及应用内检查、下载、安装和重启。允许吸收错误提示等独立修复。                                                            |
| 应用身份和签名 | 保留 `src-tauri/tauri.conf.json` 的应用标识和现有更新公钥。私钥仍在维护者本机和 Actions Secret，不更换、不提交、不输出。                                                                                                            |
| 构建和发布     | 保留 Windows x64（`x86_64-pc-windows-msvc`）、MSI、NSIS、便携 ZIP、三项 Windows 更新清单，以及 `scripts/release.mjs` 的 GitHub 优先和额度不足时转本机逻辑。                                                                         |
| CI             | 保留普通 Windows x64 CI 和手动 WSL2 检查，不恢复多平台矩阵、每日 WSL2 或上游推广工作流。                                                                                                                                            |
| 供应商         | 以同步前各 `src/config/*ProviderPresets.ts` 的名单为准；保留应用官方入口和已保留的 Kimi、DeepSeek、智谱、MiniMax 等预设，吸收它们的协议、端点、模型和参数修复。统一供应商保留自定义网关。不要因上游新增或修改而恢复已删除的供应商。 |
| 供应商兼容性   | 保留旧数据的兼容字段及必要的认证逻辑；不得把删除推广界面扩大为破坏已保存的供应商数据。模型价格、通用图标、手动配置能力和代理修复按功能判断，不因涉及第三方名称而一并删除。                                                          |
| 宣传和文档     | 保留个人版 README、MIT 许可和实用手册。上游的赞助横幅、推广链接、促销提示、多语言项目介绍和发布宣传文档继续不纳入；把与实际功能相关的说明合入手册。                                                                                 |
| 依赖           | 保留本项目为安装包更新修复而对齐的 Tauri 前后端依赖。版本号冲突只改应用包版本，不以整份上游锁文件覆盖本地依赖。                                                                                                                     |

这些是用户已确认的定制要求，优先于通用同步工具的“远端优先”默认规则。对本表之外的功能冲突，先读两侧实现与提交理由；无法判断时把具体差异交给用户决定。

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
- **供应商预设混合冲突**：按同步前名单保留条目，再合入每个保留条目的上游更新；同步调整对应测试，不能整份保留旧文件而漏掉修复。
- **删除/修改冲突**：核对本项目为什么删除。属于已清理的介绍、推广或被移除预设的专用测试，继续保持删除；若包含仍需使用的通用逻辑，提取到保留文件。
- **没有冲突的新增内容**：同样复查。上游新添的赞助资源、发行宣传和已删除供应商的测试可能被 Git 自动带入，不能只处理冲突列表。
- **更新错误显示**：保留私有更新链路，并合入上游更准确的错误描述，避免退回只显示通用失败信息。

解决后对具体文件执行 `git add -- "路径"`；确认继续删除的具体文件执行 `git rm -- "路径"`。不批量恢复整个目录。临时保存的指南用记录的 SHA 恢复：

```powershell
git stash apply "$syncGuideStash"
```

确认指南已恢复后再清理本次 stash；保留其他 stash。合并结果和同步记录完成后，在 README 中加入指南入口。

## 5. 版本和依赖

合入完整稳定版时，四处应用版本统一到目标稳定版，例如本次 `3.20.3`：

- `package.json` 的 `version`。
- `src-tauri/Cargo.toml` 的 `[package].version`。
- `src-tauri/tauri.conf.json` 的 `version`。
- `src-tauri/Cargo.lock` 中 `cc-switch` 包的 `version`。

后续基于 `3.20.3` 的自用修订从 `3.20.4-1` 开始。只有同步源码时不创建任何 Tag；等实际发版时，才把自用 Tag 指向包含本地定制的提交。上游 Tag 的 SHA 仅作为同步来源记录。

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

确认私有更新源、公钥、构建目标、发布回退和供应商名单保持约定，且没有重新带入推广内容。不要将私钥、Token 或本机真实配置写入日志。

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

涉及安装包配置、更新链路或依赖变化时，再用 README 中的签名配置执行 `pnpm build` 并验签；单纯合入源码不执行 `pnpm release`。CI 因额度停止时，如实记录本机验证结果，不能把未运行的云端检查写成通过。

## 7. 记录与交付

每次同步在本指南末尾记录：同步前提交、目标 Tag/SHA、纳入的关键修复、按自用要求未引入的上游内容、版本与验证结果。

合并待提交时，`git status` 会显示仍在合并流程中；在用户授权提交前保留该状态。后续授权提交时应完成此次合并提交，使上游目标成为本地历史的祖先。推送自用 `main` 不等于发布应用；需要发版时继续遵循 [README 的构建与发布流程](../../README.md#windows-x64-构建与发布)。

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
