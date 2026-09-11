import { describe, expect, it } from "vitest";
import {
  validateVersions,
  validateManifest,
} from "../../scripts/validate-release.mjs";

const versions = (version) => ({
  package: version,
  tauri: version,
  cargo: version,
  lock: version,
});
const repository = "owner/private-app";
const manifest = () => ({
  version: "3.20.2-1",
  platforms: Object.fromEntries(
    ["windows-x86_64", "windows-x86_64-msi", "windows-x86_64-nsis"].map(
      (platform) => [
        platform,
        {
          signature: "test-signature",
          url: `https://github.com/${repository}/releases/download/v3.20.2-1/CC.Switch_3.20.2-1_${platform.endsWith("nsis") ? "x64-setup.exe" : "x64_en-US.msi"}`,
        },
      ],
    ),
  ),
});

describe("private release validation", () => {
  it("records the previous upstream patch for self revisions", () => {
    expect(validateVersions("v3.20.2-1", versions("3.20.2-1"))).toEqual({
      version: "3.20.2-1",
      prerelease: true,
      upstreamVersion: "3.20.1",
    });
    expect(validateVersions("v3.20.2", versions("3.20.2"))).toEqual({
      version: "3.20.2",
      prerelease: false,
      upstreamVersion: "3.20.2",
    });
  });

  it("rejects inconsistent tags and version files", () => {
    expect(() => validateVersions("v3.20.2", versions("3.20.1"))).toThrow();
    expect(() =>
      validateVersions("v3.20.2-1", {
        ...versions("3.20.2-1"),
        lock: "3.20.1",
      }),
    ).toThrow(/lock/);
  });

  it.each(["3.20.1.1", "3.20.2-01", "3.20.0-1", "3.20.1+1"])(
    "rejects versions outside the project rule: %s",
    (version) => {
      expect(() =>
        validateVersions(`v${version}`, versions(version)),
      ).toThrow();
    },
  );

  it("accepts a complete manifest for the private release", () => {
    expect(() =>
      validateManifest(manifest(), "3.20.2-1", repository),
    ).not.toThrow();
  });

  it("rejects missing installer types and signatures before publishing", () => {
    const incomplete = manifest();
    delete incomplete.platforms["windows-x86_64-nsis"];
    expect(() => validateManifest(incomplete, "3.20.2-1", repository)).toThrow(
      /NSIS/,
    );
    const unsigned = manifest();
    unsigned.platforms["windows-x86_64"].signature = "";
    expect(() => validateManifest(unsigned, "3.20.2-1", repository)).toThrow(
      /签名/,
    );
  });

  it("rejects non-Windows platforms and an MSI/NSIS type mismatch", () => {
    const extra = manifest();
    extra.platforms["linux-x86_64"] = extra.platforms["windows-x86_64"];
    expect(() => validateManifest(extra, "3.20.2-1", repository)).toThrow(
      /只能/,
    );
    const mixed = manifest();
    mixed.platforms["windows-x86_64-nsis"] = mixed.platforms["windows-x86_64"];
    expect(() => validateManifest(mixed, "3.20.2-1", repository)).toThrow(
      /类型/,
    );
  });

  it("rejects links to another repository or another version", () => {
    const foreign = manifest();
    foreign.platforms["windows-x86_64"].url =
      "https://github.com/other/app/releases/download/v3.20.2-1/setup.exe";
    expect(() => validateManifest(foreign, "3.20.2-1", repository)).toThrow();
    expect(() => validateManifest(manifest(), "3.20.2", repository)).toThrow(
      /版本号/,
    );
  });
});
