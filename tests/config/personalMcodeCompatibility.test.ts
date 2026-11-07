import { describe, expect, it, vi } from "vitest";
import {
  mcodeProviderPresets,
  mcodeOnlyPiPresets,
} from "@/config/mcodeProviderPresets";
import { piProviderPresets } from "@/config/piProviderPresets";

const mcodePreset = (name: string) =>
  mcodeProviderPresets.find((preset) => preset.name === name);
const piPreset = (name: string) =>
  [...piProviderPresets, ...mcodeOnlyPiPresets].find(
    (preset) => preset.name === name,
  )!;

// 转换规则与生产名单分开测试：保留手动配置的 adaptive / dialect 能力覆盖。
vi.mock("@/config/piProviderPresets", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/config/piProviderPresets")>();
  const model = (id: string, compat: Record<string, unknown>) => ({
    id,
    name: id,
    input: ["text"] as ["text"],
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 8192,
    compat,
  });
  return {
    ...actual,
    piProviderPresets: [
      ...actual.piProviderPresets,
      {
        name: "Test adaptive",
        providerKey: "test-adaptive",
        websiteUrl: "https://adaptive.example",
        settingsConfig: {
          name: "Test adaptive",
          baseUrl: "https://adaptive.example/v1",
          api: "anthropic-messages",
          apiKey: "",
          models: [
            {
              ...model("claude-opus-5-5", { forceAdaptiveThinking: true }),
              thinkingLevelMap: { xhigh: "xhigh", max: "max" },
            },
          ],
        },
      },
      {
        name: "Test dialect",
        providerKey: "test-dialect",
        websiteUrl: "https://dialect.example",
        settingsConfig: {
          name: "Test dialect",
          baseUrl: "https://dialect.example/v1",
          api: "openai-completions",
          apiKey: "",
          models: [
            model("deepseek", {
              thinkingFormat: "deepseek",
              requiresReasoningContentOnAssistantMessages: true,
            }),
            model("qwen3.8-max", {
              thinkingFormat: "qwen",
              supportsDeveloperRole: false,
            }),
          ],
        },
      },
    ],
  };
});

describe("mcodeProviderPresets", () => {
  it("passes Pi's model compat through verbatim but never its thinkingLevelMap", () => {
    for (const preset of mcodeProviderPresets) {
      const piModels = piPreset(preset.name).settingsConfig.models;
      for (const [id, model] of Object.entries(preset.settingsConfig.models)) {
        const piModel = piModels.find((candidate) => candidate.id === id)!;
        expect(model.compat, `${preset.name}/${id}`).toEqual(piModel.compat);
        expect(model, `${preset.name}/${id}`).not.toHaveProperty(
          "thinkingLevelMap",
        );
      }
    }
  });

  it("gives adaptive-thinking Claude models effort options alongside their compat", () => {
    const pi = piPreset("Test adaptive");
    const mcode = mcodePreset("Test adaptive");
    expect(mcode).toBeDefined();
    expect(Object.keys(mcode!.settingsConfig.models)).toEqual(
      pi.settingsConfig.models.map((model) => model.id),
    );
    const opus = mcode!.settingsConfig.models["claude-opus-5-5"];
    expect(opus.compat).toEqual({ forceAdaptiveThinking: true });
    expect(opus.thinking).toEqual({
      effortOptions: ["low", "medium", "high", "xhigh", "max"],
    });
  });

  it("keeps dialect presets, relying on compat instead of effort options", () => {
    const deepseek = Object.values(
      mcodePreset("Test dialect")!.settingsConfig.models,
    );
    expect(deepseek[0].compat).toMatchObject({
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
    });
    expect(deepseek[0]).not.toHaveProperty("thinking");

    const qwen =
      mcodePreset("Test dialect")!.settingsConfig.models["qwen3.8-max"];
    expect(qwen.compat).toEqual({
      thinkingFormat: "qwen",
      supportsDeveloperRole: false,
    });
  });

  it("skips only the models whose compat MCode cannot express", () => {
    const models = Object.keys(mcodePreset("Kimi")!.settingsConfig.models);
    expect(models).toContain("kimi-k2.7-code");
    expect(models).not.toContain("kimi-k3");
    expect(
      piPreset("Kimi").settingsConfig.models.map((model) => model.id),
    ).toContain("kimi-k3");
  });

  it("excludes presets on APIs MCode does not support", () => {
    expect(mcodePreset("AWS Bedrock")).toBeUndefined();
  });
});
