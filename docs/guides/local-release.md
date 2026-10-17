# CC Switch 本机发布规范

本规范适用于个人自用仓库 `cloud-wyf/cc-switch`。目标是将本次修改形成可追溯的源码提交，在本机 Windows x64 构建签名安装包，发布到同一私有仓库，并验证已安装应用能够获取正确的更新制品。

## 触发与完成标准

用户在本项目说“发布”“发版”“发布当前修改”“打包并发布”，即授权执行以下完整流程：

```text
检查变更 → 确定版本和发布说明 → 验证 → 提交源码
→ 推送 main 和 Tag → 排除同版本云端任务
→ 本机编译与签名 → 上传草稿附件 → 发布 Release → 下载核验
```

这些指令已包含必要提交、推送、Tag 和 Release 操作的确认，不再逐项询问。发布前简述将发布的变更、版本及仓库即可继续。用户明确限定“只提交”“只打包”“暂不发布”时，按限定执行；仅讨论或编写本规范不启动发布。

**默认始终本机构建，与 GitHub 剩余额度无关。** 不自动安装或启动新版，不修改日常配置数据库。发布成功必须同时满足：远程 `main`/Tag 与本次提交一致，Release 非草稿，六个附件完整且已核验。只推代码不等于应用已更新。

## 固定约定

| 项目     | 约定                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| 发布远程 | `origin` → 私有 `cloud-wyf/cc-switch`；HTTPS/SSH 均须核对仓库身份                  |
| 上游     | `farion1231/cc-switch`，仅用于另行授权的源码同步                                   |
| 分支     | 已有 `main`，不为发布创建或自动切换分支                                            |
| 构建目标 | `x86_64-pc-windows-msvc`，MSI、NSIS EXE、便携 ZIP                                  |
| 工具链   | 以 `.node-version`、`rust-toolchain.toml`、`package.json` 的 `packageManager` 为准 |
| 私钥     | 默认 `~/.tauri/cc-switch-updater.key`，沿用已有密钥；也支持进程级签名环境变量      |
| 发布命令 | `pnpm release:local --tag <本次Tag>`                                               |
| 本机记录 | Git 忽略的 `release/<Tag>/`，日志和校验记录可放其 `validation/` 子目录             |

`pnpm release` 和 `pnpm release:local` 默认仅在本机发布。云端构建必须显式选择 `pnpm release:github` 或 `pnpm release --mode auto`；后者云端优先，可能等待运行器，最长 90 分钟。

## 1. 检查源码与远程

在项目根目录检查：

```powershell
git status --short
git branch --show-current
git remote -v
git diff --stat
git diff --cached --stat
git diff --name-only --diff-filter=U
git fetch origin
git rev-list --left-right --count origin/main...HEAD
```

- 阅读本次修改和会话范围；保留原有修改、新文件及删除。不要直接 `git add .`，不要把本机配置、私钥、令牌、验证输出或无关修改带入提交。
- 若当前不是 `main`、`origin` 身份不符、存在未解冲突或远程有本地没有的提交，先处理具体阻塞，不强推、不自动重置或切分支。不要在脏工作区直接 pull。
- 检查是否存在 `MERGE_HEAD`。合并已验证、冲突已解决时，发布提交应保留两个父提交；不要用压平历史的方式假装同步完成。
- `gh` 必须登录有本私有仓库写权限的账号。使用 `gh api`，不打印访问令牌。签名私钥可用且公钥匹配；不能为解决缺失密钥而另生成一把。
- 先读取目标版本的本地/远程 Tag 和 GitHub Release 状态；404 之外的权限、网络错误不能当作“版本不存在”。

## 2. 确定版本与发布说明

自用版本遵循 README 中的 SemVer 规则：基于上游 `4.0.2` 的修订使用 `4.0.3-1`、`4.0.3-2` 等。若当前发布版本为 `4.0.3-1`，有新修改时下一个通常为 `4.0.3-2`；必须检查实际 Tag/Release，不能硬编码或重复占用已有版本。

| 状态                                        | 处理                                              |
| ------------------------------------------- | ------------------------------------------------- |
| 当前源码与已发布 Tag 完全一致、没有新修改   | 核验既有 Release 并返回链接，不制造无意义的新版本 |
| 新修改尚未发布                              | 选择高于已发布版本且未被其他源码占用的版本        |
| 未发布 Tag/草稿与当前干净 HEAD 一致         | 重试同版本，复用草稿                              |
| Tag/草稿已绑定其他提交，或打 Tag 后修了源码 | 选择新的修订号；保留旧 Tag/草稿，不改写它们       |

在提交前统一修改四处应用版本：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.lock` 中 `cc-switch` 包。只因应用版本变化不更新无关依赖或重建整个锁文件。

补齐 `src/whats-new/<版本>.json`，遵循该目录 README 的四语和长度规则。中文 Release 说明写到 `release/<Tag>/release-notes.md`，包括：用户可感知的变化、实际上游基线、保留的自用功能、必要的升级/回退说明、验证结果及尚未验证的范围。提交前完成所有会进入安装包的内容，避免构建后才补摘要而再次编译。

## 3. 按变更范围验证

先运行版本校验：

```powershell
node "scripts/validate-release.mjs"
```

| 变更范围                   | 必要验证                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 前端/UI                    | `pnpm typecheck`、相关 Vitest 回归、修改文件的 Prettier 检查；最终 `release:local` 自动执行前端生产构建                 |
| 新增/修改应用内摘要        | `pnpm exec vitest run "tests/config/whatsNewEntries.test.ts" "tests/lib/whatsNew.test.ts"`                              |
| 发布脚本、版本/更新链路    | `pnpm exec vitest run "tests/scripts/release.test.mjs" "tests/scripts/validate-release.test.mjs"`，以及受影响的更新测试 |
| Rust 后端                  | Rust fmt、对应回归；涉及广泛接口或行为时运行 Windows x64 Clippy 和后端测试                                              |
| 大范围上游合并、跨模块变更 | 前端全量、Clippy、Windows x64 后端完整测试，并记录实际限制                                                              |
| 纯文档                     | 内容、链接及格式检查；用户仅要求文档提交时不要求应用发版                                                                |

`.mjs` 发布测试由 Vitest 执行，不能用 `node --test`。前端测试与大型编译错开，避免资源争抢导致首次模块加载超时。同一源码已完成的检查可复用，只复跑后续变更影响的部分；不要为小型 UI 变更无差别重跑全部 Rust 测试。

后端完整检查的项目用法：

```powershell
cargo fmt --check --manifest-path "src-tauri/Cargo.toml"
cargo clippy --locked --jobs 1 --target x86_64-pc-windows-msvc --manifest-path "src-tauri/Cargo.toml" -- -D warnings
cargo test --locked --jobs 1 --no-fail-fast --target x86_64-pc-windows-msvc --manifest-path "src-tauri/Cargo.toml" -- --test-threads=1
```

测试使用隔离目录，不使用日常配置。新失败必须调查；不能直接忽略。已确认的既有 Windows 符号链接权限限制（错误 1314）逐项记录为未验证，不自动修改系统权限，不把未跑的云端 CI 写成通过。金标文件的真实输出空白不为消除 `diff --check` 提示而随意改动。

## 4. 提交并推送本次版本

1. 用明确路径暂存本次源码、重命名/删除、版本、摘要及相关文档；核对暂存差异和剩余工作区。发布源码应完整提交，工作区需干净。
2. 提交本次修改。已有 `MERGE_HEAD` 时完成真实合并提交并检查父提交。
3. 从四处一致的应用版本确定 `$releaseTag`，记录 `$releaseHead`。这些变量必须来自实际检查，下面的命令不能跳过预检直接粘贴。
4. 新版本创建附注 Tag；重试已有版本时只核验，不重复创建或移动 Tag。

```powershell
$releaseTag = "v$((Get-Content -Raw "package.json" | ConvertFrom-Json).version)"
$releaseHead = (git rev-parse HEAD).Trim()
git tag -a "$releaseTag" -m "CC Switch $releaseTag (Windows x64)"
git push --atomic origin main "refs/tags/$releaseTag"
```

每条命令检查退出码，失败不继续。推送后核对远程 `main`、Tag 解引用到的提交都等于 `$releaseHead`。只推本私有仓库和本次 Tag，不使用 `--force`、`--tags`、`reset --hard`。大量文件可使用 Git 的 `--pathspec-from-file`，避免 Windows 参数长度限制。

## 5. 确保同版本只有一个发布者

现有 `release.yml` 仍会被 `v*` Tag 推送触发。即使以前额度不足，本次也可能正常启动，不能靠等待其“自动失败”来规避并发。

```powershell
gh run list --repo cloud-wyf/cc-switch --workflow release.yml --limit 100 --json databaseId,displayTitle,headBranch,headSha,event,status,conclusion,url
```

精确匹配本次 Tag/SHA 的推送任务，或标题对应本 Tag 的手动任务（后者还须核对任务详情，不能仅凭默认分支 SHA 判断）。只取消匹配且尚未结束的任务，并轮询到 `completed`；不取消其他版本或普通 CI。已有结束的失败任务无需重跑。

若云端抢先发布了相同源码的版本，转入远程核验并说明实际构建来源，不覆盖它。若源码身份不同，保留现场并报告冲突。继续使用本机构建需要新的版本号。

## 6. 准备草稿并本机发布

先运行只读预检，并显式选择本机模式：

```powershell
pnpm release:check --mode local --tag "$releaseTag"
```

无 Release 时，用已准备好的说明创建草稿，将 `--target` 固定为确切 SHA，不用分支名。数字预发布版本加 `--prerelease`；正式版本省略该参数。以下是自用数字预发布版的命令：

```powershell
gh release create "$releaseTag" --repo cloud-wyf/cc-switch --verify-tag --target "$releaseHead" --title "CC Switch $releaseTag（Windows x64）" --notes-file "release/$releaseTag/release-notes.md" --draft --prerelease
```

若草稿已存在，确认 `tag_name`、`target_commitish`、`draft` 和附件范围一致后复用；必要时仅更新草稿说明。不要重复创建。先写说明使 `latest.json` 一起带入本版说明，不在发布后单独改正文造成两处不一致。

```powershell
$previousCargoJobs = $env:CARGO_BUILD_JOBS
try {
    $env:CARGO_BUILD_JOBS = "1"
    pnpm release:local --tag "$releaseTag"
    if ($LASTEXITCODE -ne 0) { throw "本机发布失败，请保留日志并检查失败阶段" }
} finally {
    $env:CARGO_BUILD_JOBS = $previousCargoJobs
}
```

首次构建时，发布脚本会冻结锁文件安装依赖，执行完整 `pnpm build`，生成 MSI/NSIS 及签名，使用应用公钥验签，再生成带 `portable.ini` 的 ZIP。构建成功且源码仍匹配后，将五个制品复制到 `release/<Tag>/build-cache/`，最后原子写入 `build.json`；记录绑定仓库、提交 SHA、Tag、版本、目标架构、公钥和每个制品的大小/SHA-256。记录在后续 GitHub 请求之前保存，上传前查询标签断网也不会丢掉构建结果。

Windows 发布构建保留 `opt-level = "s"`，但单独覆盖 Cargo 的 release 设置为 `codegen-units = 64`、`lto = false`。这样不改变其它平台或普通 Cargo release 的体积优化配置。2026-10-18 本机隔离冷构建的 Cargo 阶段为 4 分 32 秒，前端构建和 MSI/NSIS 封装另需少量时间；此前默认 ThinLTO 的 Rust 阶段历史记录为 16–17 分钟。对照包 MSI/NSIS 分别约大 8–10%（前端工作区也有变化，体积差仅作近似参考）。

同一源码重试 `pnpm release:local --tag "$releaseTag"` 时，先核对该记录、全部制品哈希和安装包签名。匹配则直接复用独立副本，跳过依赖安装、前端/Rust 编译和打包；原来的 `target` 产物被其他构建覆盖不影响缓存。记录缺失、不匹配、文件损坏或验签失败时重新构建。旧版本只有安装包但没有构建记录时，不凭文件名猜测来源或自动复用。

`latest.json` 不进入构建缓存，每次依据当前草稿说明和已验证签名重新生成。已有相同哈希的远程附件继续跳过上传，全部附件齐全后才公开 Release。源码干净、远程 Tag 一致、同版本云端任务已结束等检查在缓存命中时仍然执行。

需要主动更换工具链/构建环境，或明确要求重新打包时，在干净的同版本源码上使用 `pnpm release:local --tag "$releaseTag" --rebuild`。它跳过本机制品复用，但仍不允许覆盖已发布版本。首次切换到 Windows 快速发布配置时 Cargo 会建立对应的构建缓存；后续新版本的编译耗时随硬件、依赖变更而异，同源码重试则复用已验签制品并跳过编译。

构建期间不编辑源码、切换分支或并行启动第二个发布命令。保留日志，避免先手动 `pnpm build` 再运行 `release:local` 造成重复编译。私钥内容不出现在命令、日志和源码中；无需将已有密钥复制进仓库。

## 7. 远程核验与交付

不能只依据发布命令的最后一句成功提示。完成以下核验并记录到 `release/<Tag>/validation/`：

1. 通过 `gh api` / `gh release view` 确认私有仓库、正确 Tag、`target_commitish = $releaseHead`、`draft = false`、预发布标记符合版本规则；重新核对远程 main/Tag 和本地干净状态。
2. 六个附件恰好齐全：`CC.Switch_<版本>_x64_en-US.msi`、其 `.sig`、`CC.Switch_<版本>_x64-setup.exe`、其 `.sig`、`cc-switch-<Tag>-x86_64-pc-windows-msvc-portable.zip`、`latest.json`。
3. 用 `gh release download "$releaseTag" --repo cloud-wyf/cc-switch --dir <本次全新校验目录>` 重新下载；不覆盖其他版本的校验资料。每个文件的大小、SHA-256 与本机产物一致；GitHub 提供 `digest` 时也比对它。
4. 使用 `scripts/windows-release.mjs` 导出的 `verifyUpdaterSignature`，以应用原公钥验证下载后的 MSI、NSIS 及对应签名。使用 `scripts/validate-release.mjs` 的 `validateManifest` 检查下载后的清单：仅有 `windows-x86_64`、`windows-x86_64-msi`、`windows-x86_64-nsis`，URL 指向本仓库本次版本，签名与附件相同，默认入口等于 MSI 入口，`notes` 与 Release 说明一致。
5. 上传使用的五个本机制品以 `release/<Tag>/build-cache/build.json` 及同目录副本为准，更新清单位于 `release/<Tag>/latest.json`。首次构建的 MSI/NSIS 也位于 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/`，文件名中的空格上传时变为点。核对 ZIP 包含本次 `cc-switch.exe` 与空的 `portable.ini`。首次构建还应确认最终程序内嵌本次前端入口；复用缓存时不能与已被其他构建覆盖的 `target` 或 `dist` 作比较，应使用匹配的构建记录和副本。

本项目更新器按 SemVer 检测自用预发布版，不依赖 GitHub 的“Latest”标记；不要为了显示 Latest 而将数字预发布版假标为稳定版。用户的 GitHub 登录仍需有私有仓库读取权限。

最终答复提供：Release 链接和版本、源码提交、Windows 安装形式、远程哈希/签名/清单核验结果、实际验证限制。明确本机是否已安装；本流程默认只发布，不安装。

## 失败处理

| 失败位置         | 恢复方式                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| 测试或预检失败   | 修复实际问题并复查；版本/提交尚未固定时继续完善，不绕过检查                                                      |
| 推送被拒绝       | 保留本地提交与 Tag，重新读取远程状态；不强推，不回滚其他人的历史                                                 |
| 本机构建失败     | 保留日志和缓存；检查工具链/签名配置。若需修改已打 Tag 的源码，换新修订号重新走验证和提交                         |
| 上传或网络中断   | 保留同源码草稿和 `build-cache`，重试 `release:local`；先验签复用本机制品，跳过重复编译，再跳过相同哈希的远程附件 |
| 已发布后校验失败 | 先排除下载错误；不要覆盖已发布附件。确认制品或源码问题后修复并发布新的修订号                                     |
| 认证或密钥不可用 | 在缺少权限/正确密钥的步骤停止，说明缺什么；不输出凭据、不替换签名身份                                            |

瞬时网络问题可在重新核对状态后有限重试；同类失败重复出现时保留现场并报告，不无限重建、反复创建草稿或猜测状态。后续“继续发布”先识别已完成阶段，再按源码和版本身份恢复。
