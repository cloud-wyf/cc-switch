import {
  providerPresets,
  claudeDesktopProviderPresets,
  codexProviderPresets,
  geminiProviderPresets,
  grokBuildProviderPresets,
  hermesProviderPresets,
  openclawProviderPresets,
  opencodeProviderPresets,
  piProviderPresets,
  mcodeProviderPresets,
  kimiProviderPresets,
  ompProviderPresets,
  dshProviderPresets,
  universalProviderPresets,
} from "@/config/personalProviderPresets";
import { describe, expect, it } from "vitest";
import { codexProviderPresets as upstreamCodex } from "@/config/codexProviderPresets";
import { providerPresets as upstreamClaude } from "@/config/claudeProviderPresets";

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
  kimi: kimiProviderPresets,
  omp: ompProviderPresets,
  dsh: dshProviderPresets,
};

describe("个人版预设约束", () => {
  it("继承上游模型参数且不修改原始目录", () => {
    for (const preset of codexProviderPresets) {
      const source = upstreamCodex.find((item) => item.name === preset.name);
      expect(source, preset.name).toBeDefined();
      expect(preset.modelCatalog, preset.name).toEqual(source?.modelCatalog);
      expect(preset.config, preset.name).toBe(source?.config);
      expect(preset.auth, preset.name).toEqual(source?.auth);
    }
    const source = upstreamClaude.find((item) => item.name === "Kimi")!;
    const personal = providerPresets.find((item) => item.name === "Kimi")!;
    expect(source.websiteUrl).toContain("aff=");
    expect(personal.websiteUrl).toBe("https://platform.kimi.com");
    expect(personal.settingsConfig).toEqual(source.settingsConfig);
  });

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
      kimi: retained,
      omp: retained,
      dsh: retained,
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
