import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  activeReleaseRuns,
  assertDraftRelease,
  assertReleaseSource,
  cloudWorkflowReady,
  createReleaseContext,
  pnpm,
  publishWindowsRelease,
} from "./windows-release.mjs";

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function quotaBlockReason(jobs) {
  // 只有未分配运行器、未执行步骤的任务，才可能因额度不足自动转本机。
  if (
    !jobs.length ||
    jobs.some((job) => job.runner_id > 0 || (job.steps?.length ?? 0) > 0)
  ) {
    return null;
  }
  for (const job of jobs) {
    for (const annotation of job.annotations ?? []) {
      const message = annotation.message ?? "";
      if (
        /The job was not started because recent account payments have failed or your spending limit needs to be increased/i.test(
          message,
        ) ||
        /The job was not started because.*(?:minutes|quota).*(?:exhausted|exceeded)/i.test(
          message,
        )
      ) {
        return message;
      }
    }
  }
  return null;
}

export async function executeRelease({
  mode,
  github,
  local,
  log = console.log,
}) {
  assert(
    ["auto", "github", "local"].includes(mode),
    "模式必须为 auto、github 或 local",
  );
  if (mode === "local") return local();
  const result = await github();
  if (result.status === "published") return result;
  assert.equal(result.status, "quota-blocked", "未知的云端发布结果");
  if (mode === "github") {
    throw new Error(`GitHub 因额度或账单限制拒绝启动：${result.url}`);
  }
  log("GitHub 因额度或账单限制拒绝启动，开始使用本机发布同一个版本。");
  return local();
}

export async function waitForCloudRun({
  github,
  runId,
  pause = sleep,
  now = Date.now,
  log = console.log,
  timeoutMs = 90 * 60 * 1000,
}) {
  const started = now();
  let lastStatus = "";
  let lastMessage = 0;
  while (now() - started < timeoutMs) {
    const run = github.request(`${github.base}/actions/runs/${runId}`);
    if (run.status === "completed") return run;
    if (run.status !== lastStatus || now() - lastMessage >= 60_000) {
      log(`GitHub 构建状态：${run.status}；${run.html_url}`);
      lastStatus = run.status;
      lastMessage = now();
    }
    await pause(15_000);
  }
  throw new Error(
    "等待云端构建超时。任务可能仍在运行；为避免重复发布，没有自动启动本机构建。",
  );
}

async function dispatchCloudRun(context) {
  const { github, info, defaultBranch } = context;
  const requestId = randomUUID();
  const title = `Windows x64 ${info.tag} [${requestId}]`;
  github.request(`${github.base}/actions/workflows/release.yml/dispatches`, {
    method: "POST",
    body: {
      ref: defaultBranch,
      inputs: { tag: info.tag, request_id: requestId },
    },
  });
  console.log(`已请求 GitHub 构建：${info.tag}`);
  for (let attempt = 0; attempt < 20; attempt++) {
    const runs = github.request(
      `${github.base}/actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=100`,
    ).workflow_runs;
    const run = runs.find(
      (item) =>
        item.display_title === title && item.head_branch === defaultBranch,
    );
    if (run) return run;
    await sleep(3_000);
  }
  throw new Error(
    "GitHub 已接受构建请求，但尚未找到对应任务。请查看 Actions；没有自动启动本机构建。",
  );
}

async function publishOnGitHub(context) {
  assert(
    cloudWorkflowReady(context),
    "远程工作流尚未更新：请先将 Windows x64 发布脚本和工作流提交并推送到默认分支",
  );
  // 复用推送 Tag 已启动的任务；已结束的失败任务不缓存，月度重置后会重新尝试云端。
  const active = activeReleaseRuns(context);
  const started = active[0] ?? (await dispatchCloudRun(context));
  const run = await waitForCloudRun({
    github: context.github,
    runId: started.id,
  });
  if (run.conclusion === "success") {
    const release = context.github.findRelease(context.info.tag);
    assert(
      release && !release.draft,
      "云端任务已结束，但没有找到正式发布的版本",
    );
    assert.equal(
      release.target_commitish,
      context.head,
      "云端发布对应的源码提交不一致",
    );
    return { status: "published", url: release.html_url };
  }
  const { github } = context;
  const jobs = github.list(
    `${github.base}/actions/runs/${run.id}/jobs?filter=latest`,
    "jobs",
  );
  if (jobs.every((job) => !job.runner_id && !job.steps?.length)) {
    for (const job of jobs.filter((item) => item.conclusion === "failure")) {
      job.annotations = github.list(
        `${github.base}/check-runs/${job.id}/annotations`,
      );
    }
  }
  const reason = quotaBlockReason(jobs);
  if (reason) return { status: "quota-blocked", reason, url: run.html_url };
  throw new Error(
    `云端构建未成功（${run.conclusion}），不是已确认的额度阻塞；请修复后重试：${run.html_url}`,
  );
}

function printPreflight(context, mode) {
  const checks = [];
  const check = (name, operation) => {
    try {
      operation();
      checks.push({ check: name, ready: true });
    } catch (error) {
      checks.push({ check: name, ready: false, reason: error.message });
    }
  };
  check("源码与远程 Tag", () => assertReleaseSource(context));
  check("版本尚未发布", () => {
    if (context.release) {
      assertDraftRelease(context.release, context.info.tag, context.head);
    }
  });
  if (mode !== "local") {
    check("远程 Windows x64 工作流", () =>
      assert(cloudWorkflowReady(context), "新的工作流尚未推送到默认分支"),
    );
  }
  if (mode !== "github") {
    check("本机构建环境", () => {
      assert(
        process.platform === "win32" && process.arch === "x64",
        "需要 Windows x64",
      );
      assert(process.env.npm_execpath, "需要通过 pnpm 启动");
      pnpm(["--version"]);
      assert(
        process.env.TAURI_SIGNING_PRIVATE_KEY ||
          existsSync(
            path.join(os.homedir(), ".tauri", "cc-switch-updater.key"),
          ),
        "没有配置本机更新签名私钥",
      );
    });
  }
  console.log(
    JSON.stringify(
      {
        repository: context.github.repository,
        tag: context.info.tag,
        mode,
        target: "Windows x64（MSI、NSIS、便携包）",
        checks,
        note: "只读检查：未触发 Actions，未构建、上传或发布；本机工具链仍需实际构建验证。",
      },
      null,
      2,
    ),
  );
  if (checks.some((check) => !check.ready)) process.exitCode = 1;
}

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "auto" },
      tag: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "pnpm release [--tag v版本号] [--mode auto|github|local] [--dry-run]\n" +
        "默认先用 GitHub；仅在已确认的额度/账单阻塞时转本机。\n" +
        "运行前必须提交发布源码、推送对应 Tag，并将 Actions 超额预算设为 0。",
    );
    return;
  }
  assert(["auto", "github", "local"].includes(values.mode), "未知的发布模式");
  const context = createReleaseContext(values.tag);
  if (values["dry-run"]) return printPreflight(context, values.mode);
  assertReleaseSource(context);
  if (context.release && !context.release.draft) {
    assert.equal(
      context.release.target_commitish,
      context.head,
      "已发布版本对应的源码提交不一致",
    );
    console.log(`该版本已经发布，无需重复构建：${context.release.html_url}`);
    return;
  }
  if (context.release) {
    assertDraftRelease(context.release, context.info.tag, context.head);
  }
  const result = await executeRelease({
    mode: values.mode,
    github: () => publishOnGitHub(context),
    local: () => publishWindowsRelease(context),
  });
  console.log(`发布完成：${result.url}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
