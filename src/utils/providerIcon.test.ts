import { describe, expect, it } from "vitest";
import { getIcon, getIconMetadata, hasIcon } from "../icons/extracted";
import { resolveProviderIcon } from "./providerIcon";

describe("resolveProviderIcon", () => {
  it("clears the legacy automatic Grok Build icon", () => {
    expect(resolveProviderIcon("grokbuild", "grok", "")).toBeUndefined();
    expect(resolveProviderIcon("grokbuild", "grok")).toBeUndefined();
  });

  it("preserves a Grok icon explicitly selected by the user", () => {
    expect(resolveProviderIcon("grokbuild", "grok", "currentColor")).toBe(
      "grok",
    );
  });

  it("does not reinterpret another app's provider icon", () => {
    expect(resolveProviderIcon("codex", "grok", "")).toBe("grok");
  });

  it("normalizes an empty icon to the initials fallback", () => {
    expect(resolveProviderIcon("grokbuild", "  ", "")).toBeUndefined();
  });
});

describe("provider icon registry", () => {
  it("registers the JieKou AI brand icon", () => {
    expect(getIcon("jiekou")).toContain("<title>JieKou AI</title>");
    expect(getIconMetadata("jiekou")).toMatchObject({
      displayName: "JieKou AI",
      defaultColor: "#000000",
    });
  });

  it("registers the PPIO brand icon", () => {
    expect(getIcon("ppio")).toContain("<title>PPIO</title>");
    expect(getIconMetadata("ppio")).toMatchObject({
      displayName: "PPIO",
      defaultColor: "#2874FF",
    });
  });

  it("registers the SubRouter provider icon", () => {
    expect(hasIcon("subrouter")).toBe(true);
  });
});
