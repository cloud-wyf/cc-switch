import { describe, expect, it } from "vitest";
import { generateThirdPartyConfig } from "./codexProviderPresets";

describe("Codex third-party configuration authentication", () => {
  // 托管 OAuth 卡无静态 key：requires_openai_auth = true 会被后端 keyless
  // 安全闸拒绝切换（provider.codex.config.official_auth_fallback）。后端
  // 写入层对存量卡会强制归一为 false，预设从源头就不能再带 true。
  it("managed OAuth configurations disable the auth.json fallback", () => {
    expect(
      generateThirdPartyConfig("acme", "https://api.acme.dev/v1", "m1", {
        requiresOpenAiAuth: false,
      }),
    ).toContain("requires_openai_auth = false");
  });

  it("key-based third-party template keeps the fallback flag by default", () => {
    expect(
      generateThirdPartyConfig("acme", "https://api.acme.dev/v1", "m1"),
    ).toContain("requires_openai_auth = true");
  });
});
