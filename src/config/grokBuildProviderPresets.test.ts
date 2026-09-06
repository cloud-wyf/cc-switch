import { describe, expect, it } from "vitest";
import { grokBuildOfficialPreset } from "./grokBuildProviderPresets";

describe("grokBuildProviderPresets", () => {
  it("keeps the official preset as an empty-config seed entry", () => {
    expect(grokBuildOfficialPreset.category).toBe("official");
    expect(grokBuildOfficialPreset.isOfficial).toBe(true);
    expect(grokBuildOfficialPreset.config).toBe("");
    expect(grokBuildOfficialPreset.auth).toEqual({});
  });
});
