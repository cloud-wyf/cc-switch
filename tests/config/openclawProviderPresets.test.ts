import { describe, expect, it } from "vitest";
import {
  openclawProviderPresets,
  rebaseOpenClawSuggestedDefaults,
} from "@/config/openclawProviderPresets";

describe("OpenClaw provider defaults", () => {
  it("uses separate namespaces for Kimi and its Coding Plan", () => {
    const payAsYouGo = openclawProviderPresets.find(
      (item) => item.name === "Kimi",
    );
    const codingPlan = openclawProviderPresets.find(
      (item) => item.name === "Kimi For Coding",
    );

    expect(payAsYouGo?.suggestedDefaults?.model?.primary).toBe(
      "kimi/kimi-k2.7-code",
    );
    expect(codingPlan?.suggestedDefaults?.model?.primary).toBe(
      "kimi-coding/kimi-for-coding",
    );
    expect(codingPlan?.suggestedDefaults?.modelCatalog).toHaveProperty(
      "kimi-coding/kimi-for-coding",
    );
  });

  it("rebases OpenClaw defaults to the submitted provider key", () => {
    const preset = openclawProviderPresets.find(
      (item) => item.name === "DeepSeek",
    );

    expect(preset?.suggestedDefaults).toBeDefined();

    const rebased = rebaseOpenClawSuggestedDefaults(
      preset!.suggestedDefaults!,
      "my-deepseek",
    );

    expect(rebased.model?.primary).toBe("my-deepseek/deepseek-v4-flash");
    expect(rebased.model?.fallbacks).toEqual(["my-deepseek/deepseek-v4-pro"]);
    expect(rebased.modelCatalog).toHaveProperty(
      "my-deepseek/deepseek-v4-flash",
    );
    expect(rebased.modelCatalog).toHaveProperty("my-deepseek/deepseek-v4-pro");
    expect(rebased.modelCatalog).not.toHaveProperty(
      "deepseek/deepseek-v4-flash",
    );
  });
});
