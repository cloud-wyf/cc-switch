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

describe("OpenCode preset reasoning flags", () => {
  // OpenCode 只给 reasoning 为真的模型生成思考档位；CC Switch 写的供应商 key
  // 对不上 models.dev，不写就一个档位都没有。
  const models = opencodeProviderPresets.flatMap((preset) =>
    Object.entries(preset.settingsConfig.models ?? {}).map(([id, model]) => ({
      preset: preset.name,
      id,
      model,
    })),
  );

  it("marks Claude, GPT and DeepSeek V4 models as reasoning", () => {
    const expected = models.filter(({ id }) =>
      /claude-|gpt-[56]|deepseek-v4/.test(id),
    );
    expect(expected.length).toBeGreaterThan(0);
    for (const { preset, id, model } of expected) {
      expect(model.reasoning, `${preset} / ${id}`).toBe(true);
    }
  });

  it("never claims reasoning on a model whose thinking is turned off", () => {
    for (const { preset, id, model } of models) {
      const thinking = (model.options as { thinking?: { type?: string } })
        ?.thinking;
      if (thinking?.type === "disabled") {
        expect(model.reasoning, `${preset} / ${id}`).not.toBe(true);
      }
    }
  });
});

describe("OpenCode preset model limits", () => {
  // 预设走 V1 格式（npm），OpenCode 要求 limit 同时带 context 和 output，
  // 缺一个整份 opencode.json 报 Configuration is invalid，所有供应商一起不可用。
  it("declares both context and output whenever a limit is set", () => {
    for (const preset of opencodeProviderPresets) {
      for (const [id, model] of Object.entries(
        preset.settingsConfig.models ?? {},
      )) {
        if (model.limit === undefined) continue;
        expect(model.limit.context, `${preset.name} / ${id}`).toBeTypeOf(
          "number",
        );
        expect(model.limit.output, `${preset.name} / ${id}`).toBeTypeOf(
          "number",
        );
      }
    }
  });
});
