import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateUpdaterManifest } from "./generate-updater-manifest.mjs";
import {
  readReleaseInfo,
  RELEASE_REPOSITORY,
  WINDOWS_TARGET,
  windowsInstallers,
} from "./validate-release.mjs";

export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const WORKFLOW_MARKER = "cc-switch-release: windows-x64-v1";

export function command(executable, args, options = {}) {
  const {
    cwd = PROJECT_ROOT,
    env = process.env,
    inherit = false,
    input,
  } = options;
  const result = spawnSync(executable, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    stdio: inherit ? "inherit" : "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stderr, result.stdout]
      .filter(Boolean)
      .join("\n")
      .trim();
    const error = new Error(
      `${executable} 执行失败（${result.status ?? result.signal}）${output ? "\n" + output : ""}`,
    );
    try {
      error.httpStatus = Number(JSON.parse(result.stdout).status);
    } catch {
      // 普通命令错误没有 GitHub HTTP 状态码。
    }
    throw error;
  }
  return result.stdout?.trim() ?? "";
}

export function createGitHubClient(repository = RELEASE_REPOSITORY) {
  const base = `repos/${repository}`;
  const request = (
    endpoint,
    { method = "GET", body, file, contentType } = {},
  ) => {
    const args = ["api", endpoint, "--method", method];
    if (body !== undefined) args.push("--input", "-");
    if (file) args.push("--input", file);
    if (contentType) args.push("--header", `Content-Type: ${contentType}`);
    const output = command("gh", args, {
      input: body === undefined ? undefined : JSON.stringify(body),
    });
    return output ? JSON.parse(output) : null;
  };
  const optional = (endpoint) => {
    try {
      return request(endpoint);
    } catch (error) {
      if (error.httpStatus === 404) return null;
      throw error;
    }
  };
  const list = (endpoint, key) => {
    const separator = endpoint.includes("?") ? "&" : "?";
    const pages = JSON.parse(
      command("gh", [
        "api",
        `${endpoint}${separator}per_page=100`,
        "--paginate",
        "--slurp",
      ]),
    );
    return pages.flatMap((page) => (key ? page[key] : page));
  };
  return {
    base,
    repository,
    request,
    optional,
    list,
    findRelease(tag) {
      const matches = list(`${base}/releases`).filter(
        (release) => release.tag_name === tag,
      );
      assert(
        matches.length <= 1,
        "同一 Tag 存在多个 Release，请先处理重复草稿",
      );
      return matches[0] ?? null;
    },
    tagCommit(tag) {
      let object = optional(`${base}/git/ref/tags/${tag}`)?.object;
      for (let depth = 0; object?.type === "tag" && depth < 8; depth++) {
        object = request(`${base}/git/tags/${object.sha}`).object;
      }
      if (!object) return null;
      assert.equal(object.type, "commit", "版本 Tag 必须最终指向源码提交");
      return object.sha;
    },
  };
}

export function assertReleaseSource({ dirty, head, tagCommit }) {
  assert(
    !dirty,
    "存在未提交文件；请先提交发布源码，避免云端和本机构建内容不同",
  );
  assert(tagCommit, "远程版本 Tag 不存在；请先推送与应用版本一致的 Tag");
  assert.equal(head, tagCommit, "当前源码提交与远程版本 Tag 不一致");
}

export function assertDraftRelease(release, tag, commit) {
  assert.equal(release.tag_name, tag, "草稿 Tag 与本次发布不一致");
  assert.equal(release.draft, true, "不能覆盖已经发布的版本，请增加版本号");
  assert.equal(
    release.target_commitish,
    commit,
    "草稿未绑定本次源码提交，不能混用其它构建的附件",
  );
}

export function createReleaseContext(tag) {
  const info = readReleaseInfo(PROJECT_ROOT, tag);
  const github = createGitHubClient();
  if (process.env.GITHUB_REPOSITORY) {
    assert.equal(
      process.env.GITHUB_REPOSITORY,
      RELEASE_REPOSITORY,
      "发布仓库必须与应用内更新源一致",
    );
  }
  const repository = github.request(github.base);
  assert(
    repository.permissions?.push,
    "当前 GitHub 凭据没有发布仓库的写入权限",
  );
  const readSource = () => ({
    dirty: command("git", ["status", "--porcelain"]),
    head: command("git", ["rev-parse", "HEAD"]),
  });
  return {
    info,
    github,
    root: PROJECT_ROOT,
    defaultBranch: repository.default_branch,
    ...readSource(),
    readSource,
    tagCommit: github.tagCommit(info.tag),
    release: github.findRelease(info.tag),
  };
}

export function cloudWorkflowReady(context) {
  const file = context.github.optional(
    `${context.github.base}/contents/.github/workflows/release.yml?ref=${encodeURIComponent(context.defaultBranch)}`,
  );
  return Boolean(
    file?.content &&
      Buffer.from(file.content, "base64")
        .toString("utf8")
        .includes(WORKFLOW_MARKER),
  );
}

export function activeReleaseRuns(context) {
  const { github, info, head } = context;
  return github
    .request(`${github.base}/actions/workflows/release.yml/runs?per_page=100`)
    .workflow_runs.filter(
      (run) =>
        run.status !== "completed" &&
        ((run.event === "push" &&
          run.head_branch === info.tag &&
          run.head_sha === head) ||
          (run.event === "workflow_dispatch" &&
            run.display_title.startsWith(`Windows x64 ${info.tag} [`))),
    );
}

export function pnpm(args, options = {}) {
  const executable = process.env.npm_execpath;
  assert(
    executable && existsSync(executable) && /pnpm/i.test(executable),
    "请通过 pnpm release / pnpm release:local 运行发布脚本",
  );
  return command(process.execPath, [executable, ...args], {
    ...options,
    inherit: true,
  });
}

export function signingEnvironment() {
  const privateKey =
    process.env.TAURI_SIGNING_PRIVATE_KEY ??
    path.join(os.homedir(), ".tauri", "cc-switch-updater.key");
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
    assert(existsSync(privateKey), "找不到本机更新签名私钥，请按 README 配置");
  }
  return {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: privateKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD:
      process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
  };
}

export function verifyUpdaterSignature(bytes, signature, publicKey) {
  const publicLines = Buffer.from(publicKey.trim(), "base64")
    .toString("utf8")
    .trim()
    .split(/\r?\n/);
  const signatureLines = Buffer.from(signature.trim(), "base64")
    .toString("utf8")
    .trim()
    .split(/\r?\n/);
  const key = Buffer.from(publicLines[1] ?? "", "base64");
  const packet = Buffer.from(signatureLines[1] ?? "", "base64");
  assert(
    key.length === 42 &&
      key.subarray(0, 2).toString("ascii") === "Ed" &&
      packet.length === 74,
    "更新签名或公钥格式不正确",
  );
  assert(
    key.subarray(2, 10).equals(packet.subarray(2, 10)),
    "签名私钥与应用内置公钥不匹配",
  );
  const algorithm = packet.subarray(0, 2).toString("ascii");
  assert(["Ed", "ED"].includes(algorithm), "不支持的更新签名算法");
  const message =
    algorithm === "ED"
      ? createHash("blake2b512").update(bytes).digest()
      : bytes;
  const verifier = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      key.subarray(10),
    ]),
    format: "der",
    type: "spki",
  });
  assert(
    verify(null, message, verifier, packet.subarray(10)),
    "安装包签名校验失败",
  );
  assert(
    signatureLines[2]?.startsWith("trusted comment: "),
    "更新签名缺少可信注释",
  );
  assert(
    verify(
      null,
      Buffer.concat([
        packet.subarray(10),
        Buffer.from(signatureLines[2].slice("trusted comment: ".length)),
      ]),
      verifier,
      Buffer.from(signatureLines[3] ?? "", "base64"),
    ),
    "更新签名的可信注释校验失败",
  );
}

export function collectWindowsArtifacts(root, info) {
  const bundleRoot = path.join(
    root,
    "src-tauri",
    "target",
    WINDOWS_TARGET,
    "release",
    "bundle",
  );
  const artifacts = [];
  const signatures = {};
  for (const installer of windowsInstallers(info.version)) {
    const directory = path.join(bundleRoot, installer.directory);
    const matches = readdirSync(directory).filter((name) =>
      name.endsWith(installer.suffix),
    );
    assert.equal(
      matches.length,
      1,
      `${installer.directory} 必须有且仅有一个本次版本的 x64 安装包`,
    );
    const file = path.join(directory, matches[0]);
    const signatureFile = `${file}.sig`;
    assert(statSync(file).size > 0, "安装包不能为空");
    const signature = readFileSync(signatureFile, "utf8").trim();
    verifyUpdaterSignature(readFileSync(file), signature, info.publicKey);
    const name = matches[0].replaceAll(" ", ".");
    artifacts.push(
      { file, name },
      { file: signatureFile, name: `${name}.sig` },
    );
    signatures[`${name}.sig`] = signature;
  }
  return { artifacts, signatures };
}

export function portableArtifact(root, info) {
  const directory = path.join(root, "release", info.tag, "portable");
  mkdirSync(directory, { recursive: true });
  copyFileSync(
    path.join(
      root,
      "src-tauri",
      "target",
      WINDOWS_TARGET,
      "release",
      "cc-switch.exe",
    ),
    path.join(directory, "cc-switch.exe"),
  );
  writeFileSync(path.join(directory, "portable.ini"), "");
  const name = `cc-switch-${info.tag}-${WINDOWS_TARGET}-portable.zip`;
  const file = path.join(root, "release", info.tag, name);
  command(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      'Compress-Archive -LiteralPath "$env:CC_SWITCH_PORTABLE_DIR/cc-switch.exe","$env:CC_SWITCH_PORTABLE_DIR/portable.ini" -DestinationPath "$env:CC_SWITCH_PORTABLE_ZIP" -Force',
    ],
    {
      env: {
        ...process.env,
        CC_SWITCH_PORTABLE_DIR: directory,
        CC_SWITCH_PORTABLE_ZIP: file,
      },
      inherit: true,
    },
  );
  return { file, name };
}

export function assertDraftAssets(release, allowedNames) {
  const names = release.assets.map((asset) => asset.name);
  assert.equal(new Set(names).size, names.length, "草稿存在重复附件");
  assert(
    names.every((name) => allowedNames.includes(name)),
    "草稿包含其它平台或未知附件，请先处理后重试",
  );
}

export function buildWindowsArtifacts(context) {
  const { info, root, head } = context;
  assert.equal(process.platform, "win32", "本机构建需要 Windows");
  assert.equal(process.arch, "x64", "本机构建需要 Windows x64 环境");
  const env = signingEnvironment();
  console.log(`开始构建 Windows x64：${info.tag}（${head.slice(0, 12)}）`);
  pnpm(["install", "--frozen-lockfile"], { cwd: root, env });
  pnpm(["build"], { cwd: root, env });
  const { artifacts, signatures } = collectWindowsArtifacts(root, info);
  artifacts.push(portableArtifact(root, info));
  return { artifacts, signatures };
}

function artifactCacheIdentity({ github, info, head }) {
  return {
    repository: github.repository,
    commit: head,
    tag: info.tag,
    version: info.version,
    target: WINDOWS_TARGET,
    publicKey: info.publicKey,
  };
}

function verifyBuiltArtifacts(artifacts, info) {
  assert.equal(artifacts.length, 5, "本机制品必须包含两种安装包、签名和便携包");
  const names = artifacts.map(({ name }) => name);
  assert(
    names.every((name) => typeof name === "string" && /^[\w.-]+$/.test(name)),
    "制品名称必须是不含路径的文件名",
  );
  assert.equal(new Set(names).size, names.length, "存在重复制品");
  const expected = [`cc-switch-${info.tag}-${WINDOWS_TARGET}-portable.zip`];
  const installers = windowsInstallers(info.version).map(({ suffix }) => {
    const matches = artifacts.filter(({ name }) => name.endsWith(suffix));
    assert.equal(matches.length, 1, "安装包版本、类型或架构不匹配");
    expected.push(matches[0].name, `${matches[0].name}.sig`);
    return matches[0];
  });
  assert.deepEqual([...names].sort(), expected.sort(), "本机制品不完整");
  for (const { file } of artifacts) {
    const stat = lstatSync(file);
    assert(stat.isFile() && stat.size > 0, "制品必须是非空普通文件");
  }
  const signatures = {};
  for (const installer of installers) {
    const signatureName = `${installer.name}.sig`;
    const signature = readFileSync(
      artifacts.find(({ name }) => name === signatureName).file,
      "utf8",
    ).trim();
    verifyUpdaterSignature(
      readFileSync(installer.file),
      signature,
      info.publicKey,
    );
    signatures[signatureName] = signature;
  }
  return signatures;
}

function artifactDigest(file) {
  const bytes = readFileSync(file);
  return {
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function readArtifactCache(context, directory) {
  const recordFile = path.join(directory, "build.json");
  if (!existsSync(recordFile)) return null;
  try {
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    assert.equal(record.schema, 1, "不支持的制品记录版本");
    assert.deepEqual(record.identity, artifactCacheIdentity(context));
    const artifacts = record.artifacts.map(({ name }) => ({
      name,
      file: path.join(directory, name),
    }));
    // 先检查文件名和签名，再逐项核对大小与哈希；不信任记录中的路径或签名。
    const signatures = verifyBuiltArtifacts(artifacts, context.info);
    for (const [index, artifact] of artifacts.entries()) {
      const digest = artifactDigest(artifact.file);
      assert.equal(digest.size, record.artifacts[index].size);
      assert.equal(digest.sha256, record.artifacts[index].sha256);
    }
    return { artifacts, signatures };
  } catch {
    console.log("已保存的制品记录或校验不匹配，将重新构建。");
    return null;
  }
}

/** 构建结果在任何后续 GitHub 请求之前落盘，上传失败后可跨进程复用。 */
export async function prepareWindowsArtifacts(
  context,
  { build = buildWindowsArtifacts, rebuild = false } = {},
) {
  const assertCurrentSource = () =>
    assertReleaseSource({ ...context.readSource(), tagCommit: context.head });
  assertReleaseSource(context);
  assertCurrentSource();
  const directory = path.join(
    context.root,
    "release",
    context.info.tag,
    "build-cache",
  );
  const cached = rebuild ? null : readArtifactCache(context, directory);
  if (cached) {
    assertCurrentSource();
    console.log(
      `复用已验签的本机制品：${context.info.tag}（${context.head.slice(0, 12)}），跳过编译和打包。`,
    );
    return cached;
  }

  const built = await build(context);
  assertCurrentSource();
  verifyBuiltArtifacts(built.artifacts, context.info);
  mkdirSync(directory, { recursive: true });
  const artifacts = built.artifacts.map(({ name, file }) => {
    const saved = path.join(directory, name);
    copyFileSync(file, saved);
    return { name, file: saved };
  });
  const signatures = verifyBuiltArtifacts(artifacts, context.info);
  const record = {
    schema: 1,
    identity: artifactCacheIdentity(context),
    builtAt: new Date().toISOString(),
    artifacts: artifacts.map(({ name, file }) => ({
      name,
      ...artifactDigest(file),
    })),
  };
  const temporary = path.join(directory, `build-${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temporary, path.join(directory, "build.json"));
  assertCurrentSource();
  console.log(`本机制品已保存：${directory}`);
  return { artifacts, signatures };
}

export async function publishWindowsRelease(
  context,
  { build = buildWindowsArtifacts, rebuild = false } = {},
) {
  const { github, info, root, head } = context;
  assertReleaseSource(context);
  if (context.release) assertDraftRelease(context.release, info.tag, head);
  if (process.env.GITHUB_ACTIONS !== "true") {
    assert.equal(
      activeReleaseRuns(context).length,
      0,
      "该版本仍有云端任务运行，请先等待或取消",
    );
  }
  const { artifacts, signatures } = await prepareWindowsArtifacts(context, {
    build,
    rebuild,
  });
  assertReleaseSource({ ...context.readSource(), tagCommit: head });
  const allowedNames = [
    ...artifacts.map((artifact) => artifact.name),
    "latest.json",
  ];

  // 构建成功并验签后才创建草稿，上传过程中始终检查草稿与源码身份。
  assert.equal(
    github.tagCommit(info.tag),
    head,
    "构建期间远程 Tag 被移动，已停止发布",
  );
  let release = github.findRelease(info.tag);
  if (release) {
    assertDraftRelease(release, info.tag, head);
    assertDraftAssets(release, allowedNames);
  } else {
    release = github.request(`${github.base}/releases`, {
      method: "POST",
      body: {
        tag_name: info.tag,
        target_commitish: head,
        name: `CC Switch ${info.tag}（Windows x64）`,
        body: `个人自用版本，基于上游 v${info.upstreamVersion}，仅提供 Windows x64。`,
        draft: true,
        prerelease: info.prerelease,
      },
    });
  }
  const releaseId = release.id;
  const readDraft = () => {
    const current = github.request(`${github.base}/releases/${releaseId}`);
    assertDraftRelease(current, info.tag, head);
    assertDraftAssets(current, allowedNames);
    return current;
  };
  const upload = (artifact, contentType = "application/octet-stream") => {
    const current = readDraft();
    const existing = current.assets.find(
      (asset) => asset.name === artifact.name,
    );
    const digest = `sha256:${createHash("sha256").update(readFileSync(artifact.file)).digest("hex")}`;
    if (existing?.digest === digest) return;
    if (existing) {
      github.request(`${github.base}/releases/assets/${existing.id}`, {
        method: "DELETE",
      });
    }
    const uploaded = github.request(
      `https://uploads.github.com/${github.base}/releases/${releaseId}/assets?name=${encodeURIComponent(artifact.name)}`,
      { method: "POST", file: artifact.file, contentType },
    );
    assert.equal(
      uploaded.name,
      artifact.name,
      "GitHub 返回的附件名称与预期不一致",
    );
    if (uploaded.digest)
      assert.equal(uploaded.digest, digest, "上传附件摘要与本机不一致");
    console.log(`已上传：${uploaded.name}`);
  };
  for (const artifact of artifacts) upload(artifact);
  release = readDraft();
  const manifest = generateUpdaterManifest({
    version: info.version,
    repository: github.repository,
    release,
    signatures,
  });
  const manifestFile = path.join(root, "release", info.tag, "latest.json");
  mkdirSync(path.dirname(manifestFile), { recursive: true });
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  upload({ file: manifestFile, name: "latest.json" }, "application/json");
  release = readDraft();
  assert.deepEqual(
    release.assets.map((asset) => asset.name).sort(),
    allowedNames.sort(),
    "发布附件不完整",
  );
  assert.equal(
    github.tagCommit(info.tag),
    head,
    "上传期间远程 Tag 被移动，已停止发布",
  );
  const published = github.request(`${github.base}/releases/${releaseId}`, {
    method: "PATCH",
    body: {
      tag_name: info.tag,
      target_commitish: head,
      name: release.name,
      body: release.body,
      prerelease: info.prerelease,
      draft: false,
      make_latest: info.prerelease ? "false" : "true",
    },
  });
  assert.equal(published.draft, false, "Release 尚未正式发布");
  return { status: "published", url: published.html_url };
}
