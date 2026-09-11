import { describe, expect, it } from "vitest";
import { generateUpdaterManifest } from "../../scripts/generate-updater-manifest.mjs";

const version = "3.20.2-1";
const repository = "owner/private-app";
const names = [
  `CC.Switch_${version}_x64_en-US.msi`,
  `CC.Switch_${version}_arm64_en-US.msi`,
  `CC.Switch_${version}_x64-setup.exe`,
  `CC.Switch_${version}_amd64.AppImage`,
  `CC.Switch_${version}_aarch64.AppImage`,
  `CC.Switch_${version}_amd64.deb`,
  `CC.Switch_${version}_arm64.deb`,
  `CC.Switch-${version}-1.x86_64.rpm`,
  `CC.Switch-${version}-1.aarch64.rpm`,
  "CC.Switch_universal.app.tar.gz",
];

function fixture() {
  const asset = (name) => ({
    name,
    browser_download_url: `https://github.com/${repository}/releases/download/v${version}/${name}`,
  });
  return {
    version,
    repository,
    release: {
      draft: true,
      tag_name: `v${version}`,
      body: "私有发布说明",
      assets: names.flatMap((name) => [asset(name), asset(`${name}.sig`)]),
    },
    signatures: Object.fromEntries(
      names.map((name) => [`${name}.sig`, `current-signature:${name}\n`]),
    ),
    pubDate: "2026-09-11T12:00:00Z",
  };
}

describe("complete updater manifest generation", () => {
  it("covers every architecture and installer format using current asset signatures", () => {
    const input = fixture();
    const manifest = generateUpdaterManifest(input);
    expect(Object.keys(manifest.platforms)).toHaveLength(17);
    for (const platform of [
      "windows-x86_64",
      "windows-aarch64",
      "linux-x86_64",
      "linux-aarch64",
      "darwin-x86_64",
      "darwin-aarch64",
    ]) {
      const entry = manifest.platforms[platform];
      expect(entry.url).toContain(`/releases/download/v${version}/`);
      expect(entry.signature).toBe(
        `current-signature:${entry.url.split("/").at(-1)}`,
      );
    }
    expect(manifest.platforms["windows-x86_64"].url).toMatch(/\.msi$/);
    expect(manifest.platforms["darwin-x86_64"]).toEqual(
      manifest.platforms["darwin-aarch64"],
    );
    expect(manifest.notes).toBe(input.release.body);
    expect(manifest.pub_date).toBe(input.pubDate);
  });

  it("rejects an incomplete architecture instead of publishing a partial manifest", () => {
    const input = fixture();
    input.release.assets = input.release.assets.filter(
      (asset) => !asset.name.endsWith("_aarch64.AppImage"),
    );
    expect(() => generateUpdaterManifest(input)).toThrow("linux-aarch64");
  });

  it("rejects missing or empty signatures", () => {
    const input = fixture();
    delete input.signatures[`${names[0]}.sig`];
    expect(() => generateUpdaterManifest(input)).toThrow("签名内容为空");
    input.signatures[`${names[0]}.sig`] = " \n";
    expect(() => generateUpdaterManifest(input)).toThrow("签名内容为空");
  });

  it("rejects ambiguous installer matches", () => {
    const input = fixture();
    input.release.assets.push({
      ...input.release.assets[0],
      name: `Other_${version}_x64_en-US.msi`,
    });
    expect(() => generateUpdaterManifest(input)).toThrow("有且仅有一个");
  });

  it("pins URLs to the release tag instead of propagating draft or latest aliases", () => {
    for (const url of [
      `https://github.com/${repository}/releases/download/untagged-123/${names[0]}`,
      `https://github.com/${repository}/releases/latest/download/${names[0]}`,
      `https://github.com/other/repo/releases/download/v${version}/${names[0]}`,
    ]) {
      const input = fixture();
      input.release.assets[0].browser_download_url = url;
      expect(
        generateUpdaterManifest(input).platforms["windows-x86_64"].url,
      ).toBe(
        `https://github.com/${repository}/releases/download/v${version}/${names[0]}`,
      );
    }
  });

  it("refuses an already published release or a mismatched tag", () => {
    const input = fixture();
    input.release.draft = false;
    expect(() => generateUpdaterManifest(input)).toThrow("尚未发布");
    input.release.draft = true;
    input.release.tag_name = "v3.20.2-2";
    expect(() => generateUpdaterManifest(input)).toThrow("Tag");
  });
});
