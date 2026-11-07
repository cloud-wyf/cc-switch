import { describe, expect, it } from "vitest";
import {
  mergePersonalTranslations,
  withPersonalTranslations,
} from "@/i18n/personal";

describe("自用翻译覆盖", () => {
  it("覆盖自用字段并继承上游新增字段，不修改输入", () => {
    const upstream = { nav: { appsGroup: "应用", newPage: "上游新页面" } };
    const result = mergePersonalTranslations(upstream, {
      nav: { appsGroup: "客户端", extensionsGroup: "扩展" },
    });
    expect(result).toEqual({
      nav: {
        appsGroup: "客户端",
        newPage: "上游新页面",
        extensionsGroup: "扩展",
      },
    });
    expect(upstream.nav.appsGroup).toBe("应用");
  });

  it("保留原有未提交侧栏文案和脚本、日志文案", () => {
    const merged = withPersonalTranslations("zh", {});
    expect(merged.nav).toMatchObject({
      appsGroup: "客户端",
      extensionsGroup: "扩展",
      accountsGroup: "账号与监控",
    });
    expect(merged.providerCard).toMatchObject({
      section: { current: "当前", providers: "供应商（{{count}}）" },
    });
    expect(merged).toHaveProperty("proxy.eventLog");
  });
});
