import { describe, expect, it } from "vitest";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import {
  extractCodexBaseUrl,
  extractCodexModelName,
  extractCodexWireApi,
} from "@/utils/providerConfigUtils";

describe("Codex native Responses provider presets", () => {
  it("drops prompt cache routing once Kimi Coding is direct-connect", () => {
    // promptCacheRouting 只被 Responses→Chat 转换层消费（forwarder 在转换后
    // 重注入 prompt_cache_key）。原生直连由 Codex 自己发 prompt_cache_key，
    // 留着这面旗只会让人误以为该卡仍需路由接管。
    const preset = codexProviderPresets.find(
      (item) => item.name === "Kimi For Coding",
    );

    expect(preset?.apiFormat).toBe("openai_responses");
    expect(preset?.promptCacheRouting).toBeUndefined();
  });

  it("uses native Responses API for migrated CN providers without local route mapping", () => {
    const nativeResponsesPresets = new Map<
      string,
      { baseUrl?: string; contextWindows: Record<string, number> }
    >([
      // DeepSeek 官方 Codex 文档确认 deepseek-v4-flash 原生 Responses；
      // catalog 由后端按 deepseek.com host 镜像官方 models.json 生成
      [
        "DeepSeek",
        {
          contextWindows: {
            "deepseek-v4-flash": 1048576,
            "deepseek-v4-pro": 1048576,
          },
        },
      ],
      ["MiniMax", { contextWindows: { "MiniMax-M3": 1000000 } }],
      // 智谱三端点分立（Anthropic /api/anthropic、Chat /api/coding/paas/v4、
      // Responses /api/v1），官方明示错误端点无法使用 Coding Plan 套餐额度——
      // 原生 Responses 预设必须锁在 /api/v1（#6944；docs.bigmodel.cn/cn/coding-plan/
      // tool/codex 自带 models.json，2026-09-04 核对：glm-5.3 + glm-5-turbo）
      [
        "Zhipu GLM",
        {
          baseUrl: "https://open.bigmodel.cn/api/v1",
          contextWindows: { "glm-5.3": 1048576, "glm-5-turbo": 204800 },
        },
      ],
      // Kimi 两份官方 Codex 接入文档均要求 wire_api = "responses"，并明写服务
      // 端原生实现 Responses API、无需本地路由或协议转换（platform.kimi.com/
      // docs/guide/codex-kimi.md 与 kimi.com/code/docs/third-party-tools/
      // codex.html，2026-09-09 真 Key 探针复核）
      [
        "Kimi",
        {
          baseUrl: "https://api.moonshot.cn/v1",
          contextWindows: { "kimi-k3": 1048576, "kimi-k2.7-code": 262144 },
        },
      ],
      [
        "Kimi For Coding",
        {
          baseUrl: "https://api.kimi.com/coding/v1",
          contextWindows: {
            "kimi-for-coding": 262144,
            "kimi-for-coding-highspeed": 262144,
            k3: 1048576,
            "k3-256k": 262144,
          },
        },
      ],
    ]);

    for (const [name, expected] of nativeResponsesPresets) {
      const preset = codexProviderPresets.find((item) => item.name === name);

      expect(preset, `${name} preset`).toBeDefined();
      expect(preset?.apiFormat).toBe("openai_responses");
      expect(extractCodexWireApi(preset?.config)).toBe("responses");
      if (expected.baseUrl) {
        // 直连预设的 base_url 必须是厂商的 Responses 端点本身（不是同站的
        // Chat 端点）；endpointCandidates 与主地址同路径档
        expect(extractCodexBaseUrl(preset?.config)).toBe(expected.baseUrl);
        expect(preset?.endpointCandidates).toContain(expected.baseUrl);
        expect(extractCodexModelName(preset?.config)).toBe(
          preset?.modelCatalog?.[0]?.model,
        );
      }
      // 原生 Responses 预设现在带 modelCatalog：cc-switch 直连时据此生成
      // ~/.codex 的 model-catalogs.json（shell_command 编辑、不发 freeform
      // apply_patch）。带 catalog 不再强制开“本地路由映射”——前端已按
      // apiFormat 解耦（openai_responses 默认不开接管）。
      expect((preset?.modelCatalog ?? []).length).toBeGreaterThan(0);
      expect(
        Object.fromEntries(
          (preset?.modelCatalog ?? []).map((model) => [
            model.model,
            model.contextWindow,
          ]),
        ),
      ).toEqual(expected.contextWindows);
      // 原生（直连）不走 Chat 转换，因此不需要 codexChatReasoning。
      expect(preset?.codexChatReasoning).toBeUndefined();
    }
  });
});
