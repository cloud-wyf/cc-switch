import { describe, expect, it } from "vitest";
import {
  opencodeProviderPresets,
  opencodeNpmPackages,
  OPENCODE_PRESET_MODEL_VARIANTS,
} from "@/config/opencodeProviderPresets";

describe("OpenCode provider configuration", () => {
  it("should include @ai-sdk/amazon-bedrock in npm packages", () => {
    const bedrockPkg = opencodeNpmPackages.find(
      (p) => p.value === "@ai-sdk/amazon-bedrock",
    );
    expect(bedrockPkg).toBeDefined();
    expect(bedrockPkg!.label).toBe("Amazon Bedrock");
  });

  it("should include Bedrock model variants", () => {
    const variants = OPENCODE_PRESET_MODEL_VARIANTS["@ai-sdk/amazon-bedrock"];
    expect(variants).toBeDefined();
    expect(variants.length).toBeGreaterThan(0);

    const opusModel = variants.find((v) =>
      v.id.includes("anthropic.claude-opus-5"),
    );
    expect(opusModel).toBeDefined();
  });

  it("Kimi For Coding preset should use Anthropic with the coding endpoint", () => {
    const kimiForCodingPreset = opencodeProviderPresets.find(
      (p) => p.name === "Kimi For Coding",
    );

    expect(kimiForCodingPreset).toBeDefined();
    expect(kimiForCodingPreset!.settingsConfig.npm).toBe("@ai-sdk/anthropic");
    expect(kimiForCodingPreset!.settingsConfig.options?.baseURL).toBe(
      "https://api.kimi.com/coding/v1",
    );
    expect(kimiForCodingPreset!.templateValues?.baseURL.defaultValue).toBe(
      "https://api.kimi.com/coding/v1",
    );
  });

  it("keeps Google OpenCode model ids unique", () => {
    const googleModels = OPENCODE_PRESET_MODEL_VARIANTS["@ai-sdk/google"];
    const ids = googleModels.map((model) => model.id);
    const geminiFlashModels = googleModels.filter(
      (model) => model.id === "gemini-3.6-flash",
    );

    expect(new Set(ids).size).toBe(ids.length);
    expect(geminiFlashModels).toHaveLength(1);
    expect(geminiFlashModels[0]).toMatchObject({
      name: "Gemini 3.6 Flash",
      variants: {
        minimal: expect.any(Object),
        low: expect.any(Object),
        medium: expect.any(Object),
        high: expect.any(Object),
      },
    });
  });
});
