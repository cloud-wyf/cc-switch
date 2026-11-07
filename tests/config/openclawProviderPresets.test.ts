import { openclawProviderPresets } from "@/config/personalProviderPresets";
import { describe, expect, it } from "vitest";
import { rebaseOpenClawSuggestedDefaults } from "@/config/openclawProviderPresets";

describe("OpenClaw provider defaults", () => {
  it("uses separate namespaces for Kimi and its Coding Plan", () => {
    const payAsYouGo = openclawProviderPresets.find(
      (item) => item.name === "Kimi",
    );
    const codingPlan = openclawProviderPresets.find(
      (item) => item.name === "Kimi For Coding",
    );

    expect(payAsYouGo?.suggestedDefaults?.model?.primary).toMatch(/^kimi\//);
    expect(codingPlan?.suggestedDefaults?.model?.primary).toBe(
      "kimi-coding/kimi-for-coding",
    );
    expect(codingPlan?.suggestedDefaults?.modelCatalog).toHaveProperty(
      "kimi-coding/kimi-for-coding",
    );
  });

  it("rebases OpenClaw defaults to the submitted provider key", () => {
    const rebased = rebaseOpenClawSuggestedDefaults(
      {
        model: { primary: "deepseek/main", fallbacks: ["deepseek/backup"] },
        modelCatalog: {
          "deepseek/main": { alias: "Main" },
          "deepseek/backup": { alias: "Backup" },
        },
      },
      "my-deepseek",
    );

    expect(rebased.model?.primary).toBe("my-deepseek/main");
    expect(rebased.model?.fallbacks).toEqual(["my-deepseek/backup"]);
    expect(rebased.modelCatalog).toHaveProperty("my-deepseek/main");
    expect(rebased.modelCatalog).toHaveProperty("my-deepseek/backup");
    expect(rebased.modelCatalog).not.toHaveProperty("deepseek/main");
  });
});
