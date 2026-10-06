import type { GeminiProviderPreset } from "@/config/geminiProviderPresets";
import type { GrokBuildProviderPreset } from "@/config/grokBuildProviderPresets";

// 自用名单之外的通用表单能力使用独立测试预设，不向生产名单添加供应商。
export const geminiPresetFixture: GeminiProviderPreset = {
  name: "Example Gemini",
  websiteUrl: "https://gemini.example",
  category: "third_party",
  settingsConfig: {
    env: {
      GEMINI_API_KEY: "",
      GOOGLE_GEMINI_BASE_URL: "https://gemini.example/v1beta",
    },
  },
};

export const grokPresetFixture: GrokBuildProviderPreset = {
  name: "Example Grok",
  websiteUrl: "https://grok.example",
  apiKeyUrl: "https://grok.example/keys",
  category: "third_party",
  auth: { OPENAI_API_KEY: "" },
  config:
    'model_provider = "example"\nmodel = "grok-4.5"\n[model_providers.example]\nname = "Example Grok"\nbase_url = "https://grok.example/v1"\nwire_api = "responses"\n',
};
