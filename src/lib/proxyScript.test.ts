import { describe, expect, it } from "vitest";
import { hasEnabledProxyScript, proxyScriptInactive } from "./proxyScript";

const meta = { localProxyScript: "export default (_r, next) => next();" };

describe("proxyScriptInactive", () => {
  it("flags an enabled script whose app is not routed through the proxy", () => {
    expect(proxyScriptInactive("codex", meta, false)).toBe(true);
    expect(proxyScriptInactive("codex", meta, true)).toBe(false);
  });

  it("ignores disabled, empty, or unsupported scripts", () => {
    expect(
      proxyScriptInactive(
        "codex",
        { ...meta, localProxyScriptEnabled: false },
        false,
      ),
    ).toBe(false);
    expect(
      proxyScriptInactive("codex", { localProxyScript: "  " }, false),
    ).toBe(false);
    expect(proxyScriptInactive("codex", undefined, false)).toBe(false);
    // Claude Desktop shows routing state in its own panel; the card badge is proxy-app only.
    expect(proxyScriptInactive("claude-desktop", meta, false)).toBe(false);
    expect(proxyScriptInactive("opencode", meta, false)).toBe(false);
  });

  it("treats a missing switch as enabled for legacy scripts", () => {
    expect(hasEnabledProxyScript(meta)).toBe(true);
    expect(
      hasEnabledProxyScript({ ...meta, localProxyScriptEnabled: false }),
    ).toBe(false);
  });
});
