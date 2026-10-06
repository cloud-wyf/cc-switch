import { describe, expect, it } from "vitest";
import { providerPresets } from "@/config/claudeProviderPresets";
import { claudeDesktopProviderPresets } from "@/config/claudeDesktopProviderPresets";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { geminiProviderPresets } from "@/config/geminiProviderPresets";
import { grokBuildProviderPresets } from "@/config/grokBuildProviderPresets";
import { hermesProviderPresets } from "@/config/hermesProviderPresets";
import { openclawProviderPresets } from "@/config/openclawProviderPresets";
import { opencodeProviderPresets } from "@/config/opencodeProviderPresets";
import { piProviderPresets } from "@/config/piProviderPresets";
import { mcodeProviderPresets } from "@/config/mcodeProviderPresets";
import { universalProviderPresets } from "@/config/universalProviderPresets";

const retained = [
  "Kimi",
  "Kimi For Coding",
  "DeepSeek",
  "Zhipu GLM",
  "MiniMax",
];
const catalogs = {
  claude: providerPresets,
  desktop: claudeDesktopProviderPresets,
  codex: codexProviderPresets,
  gemini: geminiProviderPresets,
  grok: grokBuildProviderPresets,
  hermes: hermesProviderPresets,
  openclaw: openclawProviderPresets,
  opencode: opencodeProviderPresets,
  pi: piProviderPresets,
  mcode: mcodeProviderPresets,
};

describe("个人版预设约束", () => {
  it("升级后保留原有名单和统一供应商入口", () => {
    const expected = {
      claude: ["Claude Official", ...retained],
      desktop: ["Claude Desktop Official", ...retained],
      codex: ["OpenAI Official", ...retained],
      gemini: ["Google Official"],
      grok: [],
      hermes: retained,
      openclaw: retained,
      opencode: retained,
      pi: retained,
      mcode: retained,
    };
    for (const [app, presets] of Object.entries(catalogs)) {
      expect(
        presets.map((preset) => preset.name),
        app,
      ).toEqual(expected[app as keyof typeof expected]);
    }
    expect(universalProviderPresets.map((preset) => preset.name)).toEqual([
      "NewAPI",
      "自定义网关",
    ]);
  });

  it("保留官方网站和兼容字段，但不恢复推广链接", () => {
    for (const presets of Object.values(catalogs)) {
      for (const preset of presets) {
        for (const url of [preset.websiteUrl, preset.apiKeyUrl]) {
          if (url) expect(url).not.toMatch(/[?&](aff|track_id|invite|ref)=/);
        }
        expect(preset.partnerPromotionKey).toBe(
          preset.name === "Google Official" ? "google-official" : undefined,
        );
      }
    }
  });
});
