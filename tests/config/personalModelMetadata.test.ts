import { describe, expect, it } from "vitest";
import { resolveModelMetadata } from "@/lib/modelMetadata";
import type { ModelsDevResponse } from "@/lib/modelsDev";

describe("自用模型参数补全", () => {
  it("keeps a configured endpoint's own window over the vendor default", () => {
    // 自定义端点的已核实窗口优先于原厂的默认窗口，不依赖生产预设名单。
    const modelsDev: ModelsDevResponse = {
      zhipuai: {
        api: "https://open.bigmodel.cn/api/paas/v4",
        models: { "glm-5.2": { limit: { context: 1000000 } } },
      },
      openrouter: {
        models: {
          "z-ai/glm-5.2": { canonical_model_id: "zhipuai/glm-5.2" },
        },
      },
    };
    expect(
      resolveModelMetadata("glm-5.2", {
        baseUrl: "https://gateway.example/v1",
        presets: [
          {
            baseUrl: "https://gateway.example/v1",
            models: new Map([["glm-5.2", { contextWindow: 500000 }]]),
          },
        ],
        modelsDev,
      })?.contextWindow,
    ).toBe(500000);
  });
});
