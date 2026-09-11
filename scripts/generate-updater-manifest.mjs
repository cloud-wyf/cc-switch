import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateManifest, windowsInstallers } from "./validate-release.mjs";

export function generateUpdaterManifest({
  version,
  repository,
  release,
  signatures,
  pubDate = new Date().toISOString(),
}) {
  assert.equal(release.draft, true, "只能为尚未发布的草稿生成更新清单");
  assert.equal(release.tag_name, `v${version}`, "草稿 Tag 与应用版本不一致");
  const platforms = {};
  const prefix = `https://github.com/${repository}/releases/download/v${version}/`;

  // 云端和本地共用同一套 Windows x64 安装包与签名映射。
  for (const { suffix, platforms: targets } of windowsInstallers(version)) {
    const assets = release.assets.filter((asset) =>
      asset.name.endsWith(suffix),
    );
    assert.equal(assets.length, 1, `${targets[0]} 必须有且仅有一个安装包`);
    const asset = assets[0];
    const signatureName = `${asset.name}.sig`;
    assert(
      release.assets.some((item) => item.name === signatureName),
      `${asset.name} 缺少签名附件`,
    );
    const signature = signatures[signatureName]?.trim();
    assert(signature, `${asset.name} 的签名内容为空`);
    // 草稿附件使用 untagged 临时地址，清单必须显式指向发布后的版本 Tag。
    const url = `${prefix}${encodeURIComponent(asset.name)}`;
    for (const target of targets) {
      platforms[target] = { url, signature };
    }
  }

  const manifest = {
    version,
    notes: release.body ?? "",
    pub_date: pubDate,
    platforms,
  };
  validateManifest(manifest, version, repository);
  return manifest;
}

function main() {
  const [releasePath, signaturesDirectory, outputPath] = process.argv.slice(2);
  assert(
    releasePath && signaturesDirectory && outputPath,
    "用法：node generate-updater-manifest.mjs release.json signatures-directory latest.json",
  );
  const repository = process.env.GITHUB_REPOSITORY;
  assert(repository, "需要设置 GITHUB_REPOSITORY");
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  const release = JSON.parse(readFileSync(releasePath, "utf8"));
  const signatures = Object.fromEntries(
    release.assets
      .filter((asset) => asset.name.endsWith(".sig"))
      .map((asset) => [
        asset.name,
        readFileSync(path.join(signaturesDirectory, asset.name), "utf8"),
      ]),
  );
  const manifest = generateUpdaterManifest({
    version,
    repository,
    release,
    signatures,
  });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `更新清单已生成：${version}，${Object.keys(manifest.platforms).length} 个平台和安装格式条目`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
