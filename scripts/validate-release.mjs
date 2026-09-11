import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export function validateVersions(tag, versions) {
  const version = versions.package;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([1-9]\d*))?$/.exec(version);
  assert(
    match,
    "版本号必须是正式 SemVer 或下一补丁版本的数字预发布号，例如 3.20.2-1",
  );
  assert.equal(tag, `v${version}`, "发布 Tag 必须与应用版本一致");
  for (const [file, value] of Object.entries(versions)) {
    assert.equal(value, version, `${file} 的版本号不一致`);
  }
  const prerelease = Boolean(match[4]);
  const patch = Number(match[3]);
  assert(!prerelease || patch > 0, "自用预发布号必须对应上一补丁版本");
  const upstreamVersion = `${match[1]}.${match[2]}.${prerelease ? patch - 1 : patch}`;
  return { version, prerelease, upstreamVersion };
}

export function validateManifest(manifest, version, repository) {
  assert.equal(
    manifest.version?.replace(/^v/, ""),
    version,
    "更新清单版本号不一致",
  );
  for (const platform of [
    "windows-x86_64",
    "windows-aarch64",
    "linux-x86_64",
    "linux-aarch64",
    "darwin-x86_64",
    "darwin-aarch64",
  ]) {
    const entry = manifest.platforms?.[platform];
    assert(entry, `更新清单缺少平台 ${platform}`);
    assert(
      typeof entry.signature === "string" && entry.signature.trim(),
      `${platform} 缺少签名`,
    );
    const url = new URL(entry.url);
    assert(
      url.protocol === "https:" &&
        url.hostname === "github.com" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname.startsWith(
          `/${repository}/releases/download/v${version}/`,
        ),
      `${platform} 的更新包必须指向当前仓库的当前 Release`,
    );
  }
}

function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const read = (file) => readFileSync(path.join(root, file), "utf8");
  const packageJson = JSON.parse(read("package.json"));
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  const cargoPackage = read("src-tauri/Cargo.toml")
    .split("[package]")[1]
    ?.split(/^\[/m)[0];
  const lockPackage = read("src-tauri/Cargo.lock")
    .split("[[package]]")
    .find((section) => /^name\s*=\s*"cc-switch"\s*$/m.test(section));
  const tomlVersion = (section) =>
    section?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const info = validateVersions(
    process.env.RELEASE_TAG ?? `v${packageJson.version}`,
    {
      package: packageJson.version,
      tauri: tauri.version,
      cargo: tomlVersion(cargoPackage),
      lock: tomlVersion(lockPackage),
    },
  );
  assert(tauri.bundle.createUpdaterArtifacts, "必须启用签名更新产物");
  const manifestIndex = process.argv.indexOf("--manifest");
  if (manifestIndex !== -1) {
    const repository = process.env.GITHUB_REPOSITORY;
    assert(repository, "验证更新清单需要 GITHUB_REPOSITORY");
    validateManifest(
      JSON.parse(readFileSync(process.argv[manifestIndex + 1], "utf8")),
      info.version,
      repository,
    );
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${info.version}\nprerelease=${info.prerelease}\nupstream_version=${info.upstreamVersion}\n`,
    );
  }
  console.log(
    `版本检查通过：${info.version}，上游基线 ${info.upstreamVersion}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
