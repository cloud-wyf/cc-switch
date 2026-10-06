import { describe, expect, it } from "vitest";
import {
  getPiModelCatalogReference,
  piModelCatalog,
} from "@/config/piModelCatalog";
import { piProviderPresets } from "@/config/piProviderPresets";

describe("Pi provider presets", () => {
  it("uses distinct managed keys instead of shadowing Pi-native providers", () => {
    const keys = piProviderPresets.map((preset) => preset.providerKey);

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => key.startsWith("cc-switch-"))).toBe(true);
  });

  it("only supplies configuration defaults, never a second gateway decision", () => {
    for (const preset of piProviderPresets) {
      expect("allowGateway" in preset).toBe(false);
      expect(preset.settingsConfig.baseUrl).toMatch(/^https?:\/\//);
      expect(preset.settingsConfig.api).not.toBe("");
      expect(preset.settingsConfig.apiKey).toBe("");
      expect(preset.settingsConfig.models.length).toBeGreaterThan(0);
      const modelIds = preset.settingsConfig.models.map((model) => model.id);
      expect(new Set(modelIds).size).toBe(modelIds.length);
      for (const model of preset.settingsConfig.models) {
        expect(model.id).not.toBe("");
        expect(model.name).not.toBe("");
        expect(typeof model.reasoning).toBe("boolean");
        expect(model.input.length).toBeGreaterThan(0);
        expect(model.input.every((input) => ["text", "image"].includes(input)));
        expect(model.contextWindow).toBeGreaterThan(0);
        expect(model.maxTokens).toBeGreaterThan(0);
        const reference = getPiModelCatalogReference(model);
        if (!reference) {
          throw new Error(`${preset.name}/${model.id} has no catalog profile`);
        }
        expect(piModelCatalog).toHaveProperty(reference.catalogKey);
        expect(JSON.parse(JSON.stringify(model))).not.toHaveProperty(
          "catalogKey",
        );
      }
    }
  });

  it("uses Anthropic roots that produce Pi request paths", () => {
    const requestUrls = Object.fromEntries(
      piProviderPresets
        .filter((preset) => preset.settingsConfig.api === "anthropic-messages")
        .map((preset) => {
          const base = new URL(preset.settingsConfig.baseUrl);
          const basePath = base.pathname.replace(/\/+$/, "");
          base.pathname = `${basePath}/v1/messages`;
          return [preset.name, base.toString()];
        }),
    );

    expect(requestUrls).toMatchObject({
      "Kimi For Coding": "https://api.kimi.com/coding/v1/messages",
    });
  });

  it("stores Pi-native API formats in its own catalog", () => {
    expect(
      Object.fromEntries(
        piProviderPresets.map((preset) => [
          preset.name,
          preset.settingsConfig.api,
        ]),
      ),
    ).toMatchObject({
      Kimi: "openai-completions",
      "Kimi For Coding": "anthropic-messages",
      DeepSeek: "openai-completions",
      "Zhipu GLM": "openai-completions",
      MiniMax: "openai-completions",
    });
  });

  // #7859: 官方 V4.1 Flash 识图，V4 Pro 仍是纯文本
  it("declares image input for official DeepSeek V4.1 Flash only", () => {
    const models =
      piProviderPresets.find((preset) => preset.name === "DeepSeek")
        ?.settingsConfig.models ?? [];
    const input = (id: string) =>
      models.find((model) => model.id === id)?.input;

    expect(input("deepseek-flash")).toEqual(["text", "image"]);
    expect(input("deepseek-v4-pro")).toEqual(["text"]);
  });

  it("keeps provider-specific OpenAI compatibility metadata", () => {
    const preset = (name: string) => {
      const found = piProviderPresets.find((item) => item.name === name);
      if (!found) throw new Error(`Missing Pi preset: ${name}`);
      return found;
    };
    const model = (presetName: string, id: string) => {
      const found = preset(presetName).settingsConfig.models.find(
        (item) => item.id === id,
      );
      if (!found) throw new Error(`Missing Pi model: ${presetName}/${id}`);
      return found;
    };

    expect(model("Kimi", "kimi-k3").compat).toEqual({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
      thinkingFormat: "openai",
      requiresReasoningContentOnAssistantMessages: true,
      deferredToolsMode: "kimi",
    });
  });
});
