import { describe, expect, it } from "vitest";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import {
  extractCodexBaseUrl,
  extractCodexModelName,
  extractCodexWireApi,
} from "@/utils/providerConfigUtils";

const expectedChatPresets = new Map<
  string,
  { baseUrl: string; contextWindows: Record<string, number> }
>([
  [
    "Kimi",
    {
      baseUrl: "https://api.moonshot.cn/v1",
      contextWindows: { "kimi-k2.7-code": 262144, "kimi-k3": 1048576 },
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

describe("Codex Chat provider presets", () => {
  it("enables session-based prompt cache routing for Kimi Coding", () => {
    const preset = codexProviderPresets.find(
      (item) => item.name === "Kimi For Coding",
    );

    expect(preset?.promptCacheRouting).toBe("enabled");
  });

  it("marks migrated Chat Completions presets for local routing", () => {
    for (const [name, expected] of expectedChatPresets) {
      const preset = codexProviderPresets.find((item) => item.name === name);

      expect(preset, `${name} preset`).toBeDefined();
      expect(preset?.apiFormat).toBe("openai_chat");
      expect(extractCodexBaseUrl(preset?.config)).toBe(expected.baseUrl);
      expect(extractCodexWireApi(preset?.config)).toBe("responses");
      expect(preset?.endpointCandidates).toContain(expected.baseUrl);
      expect(preset?.modelCatalog?.length).toBeGreaterThan(0);
      expect(extractCodexModelName(preset?.config)).toBe(
        preset?.modelCatalog?.[0]?.model,
      );
      expect(
        Object.fromEntries(
          (preset?.modelCatalog ?? []).map((model) => [
            model.model,
            model.contextWindow,
          ]),
        ),
      ).toEqual(expected.contextWindows);
    }
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
      ["MiniMax en", { contextWindows: { "MiniMax-M3": 1000000 } }],
      // 智谱三端点分立（Anthropic /api/anthropic、Chat /api/coding/paas/v4、
      // Responses /api/v1），官方明示错误端点无法使用 Coding Plan 套餐额度——
      // 原生 Responses 预设必须锁在 /api/v1（#6944；docs.bigmodel.cn/cn/coding-plan/
      // tool/codex 与 docs.z.ai/devpack/tool/codex 自带 models.json，2026-09-04 核对：
      // 国内站 glm-5.3 + glm-5-turbo，国际站仅 glm-5.3）
      [
        "Zhipu GLM",
        {
          baseUrl: "https://open.bigmodel.cn/api/v1",
          contextWindows: { "glm-5.3": 1048576, "glm-5-turbo": 204800 },
        },
      ],
      [
        "Zhipu GLM en",
        {
          baseUrl: "https://api.z.ai/api/v1",
          contextWindows: { "glm-5.3": 1048576 },
        },
      ],
    ]);

    for (const [name, expected] of nativeResponsesPresets) {
      const preset = codexProviderPresets.find((item) => item.name === name);

      expect(preset, `${name} preset`).toBeDefined();
      expect(preset?.apiFormat).toBe("openai_responses");
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
