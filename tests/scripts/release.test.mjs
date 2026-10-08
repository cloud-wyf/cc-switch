import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  executeRelease,
  quotaBlockReason,
  waitForCloudRun,
} from "../../scripts/release.mjs";
import {
  assertDraftAssets,
  assertDraftRelease,
  assertReleaseSource,
  collectWindowsArtifacts,
  prepareWindowsArtifacts,
  publishWindowsRelease,
  verifyUpdaterSignature,
} from "../../scripts/windows-release.mjs";

const billingMessage =
  "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings";
const published = {
  status: "published",
  url: "https://github.com/owner/app/releases/tag/v1.0.0",
};
const quota = {
  status: "quota-blocked",
  url: "https://github.com/owner/app/actions/runs/1",
};

describe("GitHub-first release routing", () => {
  it("uses GitHub while it is available", async () => {
    const github = vi.fn().mockResolvedValue(published);
    const local = vi.fn();
    await expect(
      executeRelease({ mode: "auto", github, local }),
    ).resolves.toEqual(published);
    expect(github).toHaveBeenCalledOnce();
    expect(local).not.toHaveBeenCalled();
  });

  it("falls back for a quota block, then tries GitHub again on the next release", async () => {
    const github = vi
      .fn()
      .mockResolvedValueOnce(quota)
      .mockResolvedValueOnce(published);
    const local = vi.fn().mockResolvedValue(published);
    const options = { mode: "auto", github, local, log: vi.fn() };
    await executeRelease(options);
    await executeRelease(options);
    expect(github).toHaveBeenCalledTimes(2);
    expect(local).toHaveBeenCalledOnce();
  });

  it.each([
    "compilation failed",
    "network error",
    "authentication failed",
    "timeout",
  ])("does not hide %s by publishing locally", async (message) => {
    const local = vi.fn();
    await expect(
      executeRelease({
        mode: "auto",
        github: vi.fn().mockRejectedValue(new Error(message)),
        local,
      }),
    ).rejects.toThrow(message);
    expect(local).not.toHaveBeenCalled();
  });

  it("honors explicit GitHub-only and local-only modes", async () => {
    const github = vi.fn().mockResolvedValue(quota);
    const local = vi.fn().mockResolvedValue(published);
    await expect(
      executeRelease({ mode: "github", github, local }),
    ).rejects.toThrow(/额度/);
    expect(local).not.toHaveBeenCalled();
    github.mockClear();
    await executeRelease({ mode: "local", github, local });
    expect(github).not.toHaveBeenCalled();
    expect(local).toHaveBeenCalledOnce();
  });
});

describe("quota rejection evidence", () => {
  const blocked = () => ({
    runner_id: 0,
    steps: [],
    annotations: [{ message: billingMessage }],
  });

  it("recognizes the GitHub billing annotation for a job that never started", () => {
    expect(quotaBlockReason([blocked()])).toBe(billingMessage);
  });

  it("rejects ordinary failures, empty jobs, and missing annotations", () => {
    expect(quotaBlockReason([])).toBeNull();
    expect(quotaBlockReason([{ runner_id: 0, steps: [] }])).toBeNull();
    expect(
      quotaBlockReason([
        { ...blocked(), annotations: [{ message: "test failed" }] },
      ]),
    ).toBeNull();
  });

  it("does not fall back while any job may have run or modified the release", () => {
    expect(quotaBlockReason([{ ...blocked(), runner_id: 123 }])).toBeNull();
    expect(
      quotaBlockReason([{ ...blocked(), steps: [{ name: "Build" }] }]),
    ).toBeNull();
    expect(
      quotaBlockReason([blocked(), { runner_id: 123, steps: [] }]),
    ).toBeNull();
  });
});

describe("cloud run waiting", () => {
  it("waits for the same run to finish before making a fallback decision", async () => {
    const github = {
      base: "repos/owner/app",
      request: vi
        .fn()
        .mockReturnValueOnce({ status: "queued" })
        .mockReturnValueOnce({ status: "in_progress" })
        .mockReturnValueOnce({ status: "completed", conclusion: "success" }),
    };
    const pause = vi.fn().mockResolvedValue();
    const result = await waitForCloudRun({
      github,
      runId: 42,
      pause,
      now: () => 0,
      log: vi.fn(),
    });
    expect(result.conclusion).toBe("success");
    expect(pause).toHaveBeenCalledTimes(2);
    expect(
      github.request.mock.calls.every(([url]) => url.endsWith("/runs/42")),
    ).toBe(true);
  });

  it("stops at a timeout without starting a concurrent local publisher", async () => {
    let elapsed = 0;
    const github = {
      base: "repos/owner/app",
      request: () => ({ status: "queued" }),
    };
    await expect(
      waitForCloudRun({
        github,
        runId: 42,
        pause: async (milliseconds) => {
          elapsed += milliseconds;
        },
        now: () => elapsed,
        timeoutMs: 30_000,
        log: vi.fn(),
      }),
    ).rejects.toThrow(/没有自动启动本机构建/);
  });
});

describe("release identity guards", () => {
  const source = { dirty: "", head: "a".repeat(40), tagCommit: "a".repeat(40) };
  const draft = {
    tag_name: "v3.20.2-2",
    draft: true,
    target_commitish: source.head,
    assets: [],
  };

  it("requires clean source and a pushed tag pointing at the same commit", () => {
    expect(() => assertReleaseSource(source)).not.toThrow();
    expect(() =>
      assertReleaseSource({ ...source, dirty: " M package.json" }),
    ).toThrow(/未提交/);
    expect(() => assertReleaseSource({ ...source, tagCommit: null })).toThrow(
      /Tag 不存在/,
    );
    expect(() =>
      assertReleaseSource({ ...source, tagCommit: "b".repeat(40) }),
    ).toThrow(/不一致/);
  });

  it("refuses published releases and drafts from another source commit", () => {
    expect(() =>
      assertDraftRelease(draft, draft.tag_name, source.head),
    ).not.toThrow();
    expect(() =>
      assertDraftRelease(
        { ...draft, draft: false },
        draft.tag_name,
        source.head,
      ),
    ).toThrow(/已经发布/);
    expect(() => assertDraftRelease(draft, "v3.20.2-3", source.head)).toThrow(
      /Tag/,
    );
    expect(() =>
      assertDraftRelease(draft, draft.tag_name, "b".repeat(40)),
    ).toThrow(/源码提交/);
  });

  it("does not mix stale platforms or duplicate assets into a Windows-only release", () => {
    expect(() =>
      assertDraftAssets({ assets: [{ name: "setup.exe" }] }, ["setup.exe"]),
    ).not.toThrow();
    expect(() =>
      assertDraftAssets({ assets: [{ name: "linux.AppImage" }] }, [
        "setup.exe",
      ]),
    ).toThrow(/其它平台/);
    expect(() =>
      assertDraftAssets(
        { assets: [{ name: "setup.exe" }, { name: "setup.exe" }] },
        ["setup.exe"],
      ),
    ).toThrow(/重复/);
  });
});

function signedFixture(algorithm = "ED") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = Buffer.from("0102030405060708", "hex");
  const keyBytes = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const publicPacket = Buffer.concat([Buffer.from("Ed"), keyId, keyBytes]);
  const bytes = Buffer.from("Windows x64 installer");
  const message =
    algorithm === "ED"
      ? createHash("blake2b512").update(bytes).digest()
      : bytes;
  const signatureBytes = sign(null, message, privateKey);
  const packet = Buffer.concat([Buffer.from(algorithm), keyId, signatureBytes]);
  const comment = "timestamp:1700000000\tfile:setup.exe";
  const globalSignature = sign(
    null,
    Buffer.concat([signatureBytes, Buffer.from(comment)]),
    privateKey,
  );
  return {
    bytes,
    publicKey: Buffer.from(
      `untrusted comment: public key\n${publicPacket.toString("base64")}\n`,
    ).toString("base64"),
    signature: Buffer.from(
      `untrusted comment: signature\n${packet.toString("base64")}\ntrusted comment: ${comment}\n${globalSignature.toString("base64")}\n`,
    ).toString("base64"),
  };
}

describe("Tauri updater artifact signatures", () => {
  it.each(["Ed", "ED"])("verifies the %s minisign format", (algorithm) => {
    const fixture = signedFixture(algorithm);
    expect(() =>
      verifyUpdaterSignature(
        fixture.bytes,
        fixture.signature,
        fixture.publicKey,
      ),
    ).not.toThrow();
  });

  it("rejects modified installers and a different signing key", () => {
    const fixture = signedFixture();
    expect(() =>
      verifyUpdaterSignature(
        Buffer.from("modified installer"),
        fixture.signature,
        fixture.publicKey,
      ),
    ).toThrow(/安装包签名/);
    expect(() =>
      verifyUpdaterSignature(
        fixture.bytes,
        fixture.signature,
        signedFixture().publicKey,
      ),
    ).toThrow(/安装包签名/);
  });

  it("verifies the trusted comment rather than accepting a valid payload signature alone", () => {
    const fixture = signedFixture();
    const changed = Buffer.from(fixture.signature, "base64")
      .toString("utf8")
      .replace("file:setup.exe", "file:other.exe");
    expect(() =>
      verifyUpdaterSignature(
        fixture.bytes,
        Buffer.from(changed).toString("base64"),
        fixture.publicKey,
      ),
    ).toThrow(/可信注释校验/);
  });
});

const temporaryRoots = new Set();
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots) {
    const resolved = path.resolve(root);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("cc-switch-release-test-")
    ) {
      throw new Error(
        "Refusing to remove a path outside the test temporary directory",
      );
    }
    rmSync(resolved, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

function artifactFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "cc-switch-release-test-"));
  temporaryRoots.add(root);
  const signed = signedFixture();
  const info = {
    version: "3.20.2-2",
    tag: "v3.20.2-2",
    upstreamVersion: "3.20.1",
    prerelease: true,
    publicKey: signed.publicKey,
  };
  const files = [];
  for (const [directory, suffix] of [
    ["msi", "x64_en-US.msi"],
    ["nsis", "x64-setup.exe"],
  ]) {
    const folder = path.join(
      root,
      "src-tauri/target/x86_64-pc-windows-msvc/release/bundle",
      directory,
    );
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `CC Switch_${info.version}_${suffix}`);
    writeFileSync(file, signed.bytes);
    writeFileSync(`${file}.sig`, signed.signature);
    files.push(file);
  }
  return { root, info, files };
}

describe("Windows artifact collection", () => {
  it("collects and verifies both installers and normalizes upload names", () => {
    const fixture = artifactFixture();
    const collected = collectWindowsArtifacts(fixture.root, fixture.info);
    expect(collected.artifacts).toHaveLength(4);
    expect(Object.keys(collected.signatures)).toHaveLength(2);
    expect(
      collected.artifacts.every((artifact) => !artifact.name.includes(" ")),
    ).toBe(true);
  });

  it("does not reuse an installer left over from an older version", () => {
    const fixture = artifactFixture();
    renameSync(
      fixture.files[0],
      fixture.files[0].replace("3.20.2-2", "3.20.2-1"),
    );
    expect(() => collectWindowsArtifacts(fixture.root, fixture.info)).toThrow(
      /本次版本/,
    );
  });
});

function publishingFixture() {
  const fixture = artifactFixture();
  const head = "a".repeat(40);
  const built = collectWindowsArtifacts(fixture.root, fixture.info);
  const portableFile = path.join(fixture.root, "portable.zip");
  writeFileSync(portableFile, "portable zip");
  built.artifacts.push({
    name: "cc-switch-v3.20.2-2-x86_64-pc-windows-msvc-portable.zip",
    file: portableFile,
  });
  const state = {
    release: null,
    events: [],
    failUploadOnce: null,
    nextAssetId: 100,
  };
  const clone = (value) =>
    value == null ? value : JSON.parse(JSON.stringify(value));
  const base = "repos/owner/private-app";
  const github = {
    base,
    repository: "owner/private-app",
    tagCommit: vi.fn(() => head),
    findRelease: vi.fn(() => clone(state.release)),
    request: vi.fn((endpoint, options = {}) => {
      const method = options.method ?? "GET";
      if (endpoint.includes("/actions/workflows/"))
        return { workflow_runs: [] };
      if (endpoint === `${base}/releases` && method === "POST") {
        state.events.push("create");
        state.release = {
          ...options.body,
          id: 42,
          assets: [],
          html_url:
            "https://github.com/owner/private-app/releases/tag/v3.20.2-2",
        };
        return clone(state.release);
      }
      if (endpoint === `${base}/releases/42`) {
        if (method === "PATCH") {
          state.events.push("publish");
          Object.assign(state.release, options.body);
        }
        return clone(state.release);
      }
      if (endpoint.startsWith("https://uploads.github.com/")) {
        const name = new URL(endpoint).searchParams.get("name");
        if (name === state.failUploadOnce) {
          state.failUploadOnce = null;
          throw new Error("simulated upload failure");
        }
        state.events.push(`upload:${name}`);
        const bytes = readFileSync(options.file);
        const asset = {
          id: state.nextAssetId++,
          name,
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          content: bytes.toString("utf8"),
        };
        state.release.assets.push(asset);
        return clone(asset);
      }
      if (
        method === "DELETE" &&
        endpoint.startsWith(`${base}/releases/assets/`)
      ) {
        const id = Number(endpoint.split("/").at(-1));
        state.events.push(`delete:${id}`);
        state.release.assets = state.release.assets.filter(
          (asset) => asset.id !== id,
        );
        return null;
      }
      throw new Error(`Unexpected GitHub operation: ${method} ${endpoint}`);
    }),
  };
  const context = {
    ...fixture,
    head,
    dirty: "",
    tagCommit: head,
    release: null,
    github,
    readSource: () => ({ head, dirty: "" }),
  };
  vi.spyOn(console, "log").mockImplementation(() => {});
  return { context, state, build: vi.fn(() => built) };
}

describe("saved Windows build artifacts", () => {
  const recordPath = (context) =>
    path.join(
      context.root,
      "release",
      context.info.tag,
      "build-cache",
      "build.json",
    );

  it("keeps independent copies when the original build directory is overwritten", async () => {
    const fixture = publishingFixture();
    const saved = await prepareWindowsArtifacts(fixture.context, {
      build: fixture.build,
    });
    const installer = saved.artifacts.find(({ name }) => name.endsWith(".msi"));
    const originalBytes = readFileSync(installer.file);
    writeFileSync(fixture.context.files[0], "another build");
    // 新的调用方只有落盘记录，不依赖上一次 build 返回的对象。
    const unexpectedBuild = vi.fn(() => {
      throw new Error("must reuse the saved build");
    });
    const restored = await prepareWindowsArtifacts(
      { ...fixture.context },
      { build: unexpectedBuild },
    );
    expect(unexpectedBuild).not.toHaveBeenCalled();
    expect(
      readFileSync(
        restored.artifacts.find(({ name }) => name.endsWith(".msi")).file,
      ),
    ).toEqual(originalBytes);
  });

  it.each([
    ["commit", "b".repeat(40)],
    ["version", "3.20.2-1"],
    ["tag", "v3.20.2-1"],
    ["repository", "owner/another-repo"],
    ["target", "aarch64-pc-windows-msvc"],
    ["publicKey", "another key"],
  ])(
    "rebuilds instead of reusing a cache from a different %s",
    async (field, value) => {
      const fixture = publishingFixture();
      await prepareWindowsArtifacts(fixture.context, { build: fixture.build });
      const file = recordPath(fixture.context);
      const record = JSON.parse(readFileSync(file, "utf8"));
      record.identity[field] = value;
      writeFileSync(file, JSON.stringify(record));
      await prepareWindowsArtifacts(fixture.context, { build: fixture.build });
      expect(fixture.build).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    "missing installer",
    "changed portable",
    "truncated record",
    "path in record",
  ])(
    "rebuilds after a %s without uploading damaged artifacts",
    async (failure) => {
      const fixture = publishingFixture();
      const saved = await prepareWindowsArtifacts(fixture.context, {
        build: fixture.build,
      });
      const file = recordPath(fixture.context);
      if (failure === "missing installer") {
        const installer = saved.artifacts.find(({ name }) =>
          name.endsWith(".msi"),
        );
        renameSync(installer.file, `${installer.file}.missing`);
      } else if (failure === "changed portable") {
        writeFileSync(
          saved.artifacts.find(({ name }) => name.endsWith(".zip")).file,
          "damaged zip",
        );
      } else if (failure === "truncated record") {
        writeFileSync(file, '{"schema":');
      } else {
        const record = JSON.parse(readFileSync(file, "utf8"));
        record.artifacts[0].name = "../not-an-installer";
        writeFileSync(file, JSON.stringify(record));
      }
      await publishWindowsRelease(fixture.context, { build: fixture.build });
      expect(fixture.build).toHaveBeenCalledTimes(2);
      expect(fixture.state.release.draft).toBe(false);
      expect(
        fixture.state.release.assets.find(({ name }) => name.endsWith(".zip"))
          .content,
      ).toBe("portable zip");
    },
  );

  it("rechecks the installer signature even if a modified file matches the recorded hash", async () => {
    const fixture = publishingFixture();
    const saved = await prepareWindowsArtifacts(fixture.context, {
      build: fixture.build,
    });
    const installer = saved.artifacts.find(({ name }) => name.endsWith(".msi"));
    const bytes = Buffer.from("tampered installer");
    writeFileSync(installer.file, bytes);
    const file = recordPath(fixture.context);
    const record = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(
      record.artifacts.find(({ name }) => name === installer.name),
      {
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    );
    writeFileSync(file, JSON.stringify(record));
    await prepareWindowsArtifacts(fixture.context, { build: fixture.build });
    expect(fixture.build).toHaveBeenCalledTimes(2);
    expect(readFileSync(installer.file)).not.toEqual(bytes);
  });

  it("rebuilds on explicit request even when the saved artifacts are valid", async () => {
    const fixture = publishingFixture();
    await prepareWindowsArtifacts(fixture.context, { build: fixture.build });
    await publishWindowsRelease(fixture.context, {
      build: fixture.build,
      rebuild: true,
    });
    expect(fixture.build).toHaveBeenCalledTimes(2);
    expect(fixture.state.release.draft).toBe(false);
  });

  it("does not reuse valid artifacts while the working tree is dirty", async () => {
    const fixture = publishingFixture();
    await prepareWindowsArtifacts(fixture.context, { build: fixture.build });
    fixture.context.readSource = () => ({
      head: fixture.context.head,
      dirty: " M src/App.tsx",
    });
    await expect(
      publishWindowsRelease(fixture.context, { build: fixture.build }),
    ).rejects.toThrow(/未提交/);
    expect(fixture.build).toHaveBeenCalledTimes(1);
    expect(fixture.state.events).toEqual([]);
  });

  it("does not record a failed build or one whose source changed during compilation", async () => {
    const fixture = publishingFixture();
    fixture.build.mockRejectedValueOnce(new Error("compile failed"));
    await expect(
      prepareWindowsArtifacts(fixture.context, { build: fixture.build }),
    ).rejects.toThrow("compile failed");
    expect(() => readFileSync(recordPath(fixture.context))).toThrow();
    const build = vi.fn(async () => {
      const result = await fixture.build();
      fixture.context.readSource = () => ({
        head: fixture.context.head,
        dirty: " M src/App.tsx",
      });
      return result;
    });
    await expect(
      prepareWindowsArtifacts(fixture.context, { build }),
    ).rejects.toThrow(/未提交/);
    expect(() => readFileSync(recordPath(fixture.context))).toThrow();
  });
});

describe("complete draft publishing", () => {
  it("publishes only after all six Windows artifacts are present", async () => {
    const fixture = publishingFixture();
    await publishWindowsRelease(fixture.context, { build: fixture.build });
    expect(fixture.state.events[0]).toBe("create");
    expect(fixture.state.events.at(-1)).toBe("publish");
    expect(fixture.state.release.draft).toBe(false);
    expect(fixture.state.release.target_commitish).toBe(fixture.context.head);
    expect(fixture.state.release.assets).toHaveLength(6);
    const manifest = JSON.parse(
      fixture.state.release.assets.find((asset) => asset.name === "latest.json")
        .content,
    );
    expect(Object.keys(manifest.platforms).sort()).toEqual([
      "windows-x86_64",
      "windows-x86_64-msi",
      "windows-x86_64-nsis",
    ]);
    expect(manifest.platforms["windows-x86_64-nsis"].url).toContain(
      "/releases/download/v3.20.2-2/",
    );
  });

  it("keeps a failed upload as a draft and resumes without rebuilding or re-uploading identical assets", async () => {
    const fixture = publishingFixture();
    fixture.state.failUploadOnce = "CC.Switch_3.20.2-2_x64_en-US.msi.sig";
    await expect(
      publishWindowsRelease(fixture.context, { build: fixture.build }),
    ).rejects.toThrow("simulated upload failure");
    expect(fixture.state.release.draft).toBe(true);
    expect(fixture.state.events).not.toContain("publish");
    fixture.state.release.body = "Updated draft notes";
    await publishWindowsRelease(fixture.context, { build: fixture.build });
    expect(
      fixture.state.events.filter((event) => event === "create"),
    ).toHaveLength(1);
    expect(
      fixture.state.events.filter(
        (event) => event === "upload:CC.Switch_3.20.2-2_x64_en-US.msi",
      ),
    ).toHaveLength(1);
    expect(fixture.state.release.draft).toBe(false);
    expect(fixture.build).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(
        fixture.state.release.assets.find(({ name }) => name === "latest.json")
          .content,
      ).notes,
    ).toBe("Updated draft notes");
  });

  it("reuses a completed build when the tag query fails before the first upload", async () => {
    const fixture = publishingFixture();
    fixture.context.github.tagCommit.mockImplementationOnce(() => {
      throw new Error("TLS handshake timeout");
    });
    await expect(
      publishWindowsRelease(fixture.context, { build: fixture.build }),
    ).rejects.toThrow("TLS handshake timeout");
    expect(fixture.state.events).toEqual([]);
    await publishWindowsRelease(fixture.context, { build: fixture.build });
    expect(fixture.build).toHaveBeenCalledTimes(1);
    expect(fixture.state.release.draft).toBe(false);
  });

  it("does not upload when source changes while the local build is running", async () => {
    const fixture = publishingFixture();
    fixture.context.readSource = () => ({
      head: fixture.context.head,
      dirty: " M src/App.tsx",
    });
    await expect(
      publishWindowsRelease(fixture.context, { build: fixture.build }),
    ).rejects.toThrow(/未提交/);
    expect(fixture.state.events).toEqual([]);
  });

  it("does not upload when the remote version tag moves during the build", async () => {
    const fixture = publishingFixture();
    fixture.context.github.tagCommit.mockReturnValue("b".repeat(40));
    await expect(
      publishWindowsRelease(fixture.context, { build: fixture.build }),
    ).rejects.toThrow(/Tag 被移动/);
    expect(fixture.state.events).toEqual([]);
  });
});
