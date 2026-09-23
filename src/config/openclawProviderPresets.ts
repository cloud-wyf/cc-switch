/**
 * OpenClaw provider presets configuration
 * OpenClaw uses models.providers structure with custom provider configs
 */
import type {
  ProviderCategory,
  OpenClawProviderConfig,
  OpenClawDefaultModel,
} from "../types";
import type { PresetTheme, TemplateValueConfig } from "./claudeProviderPresets";

/** Suggested default model configuration for a preset */
export interface OpenClawSuggestedDefaults {
  /** Default model config to apply (agents.defaults.model) */
  model?: OpenClawDefaultModel;
  /** Model catalog entries to add (agents.defaults.models) */
  modelCatalog?: Record<string, { alias?: string }>;
}

export interface OpenClawProviderPreset {
  name: string;
  nameKey?: string; // i18n key for localized display name
  websiteUrl: string;
  apiKeyUrl?: string;
  /** OpenClaw settings_config structure */
  settingsConfig: OpenClawProviderConfig;
  isOfficial?: boolean;
  isPartner?: boolean;
  partnerPromotionKey?: string;
  category?: ProviderCategory;
  /** Template variable definitions */
  templateValues?: Record<string, TemplateValueConfig>;
  /** Visual theme config */
  theme?: PresetTheme;
  /** Icon name */
  icon?: string;
  /** Icon color */
  iconColor?: string;
  /** Mark as custom template (for UI distinction) */
  isCustomTemplate?: boolean;
  /** Suggested default model configuration */
  suggestedDefaults?: OpenClawSuggestedDefaults;
}

function rebaseOpenClawModelRef(modelRef: string, providerKey: string): string {
  const slashIndex = modelRef.indexOf("/");
  return slashIndex === -1
    ? `${providerKey}/${modelRef}`
    : `${providerKey}${modelRef.slice(slashIndex)}`;
}

/**
 * OpenClaw default model refs are stored as "<provider-key>/<model-id>".
 * Presets carry stable built-in keys for display/tests, but the real key is
 * chosen in the add-provider form, so rewrite refs right before submission.
 */
export function rebaseOpenClawSuggestedDefaults(
  defaults: OpenClawSuggestedDefaults,
  providerKey: string,
): OpenClawSuggestedDefaults {
  const key = providerKey.trim();
  if (!key) return defaults;

  return {
    model: defaults.model
      ? {
          ...defaults.model,
          primary: rebaseOpenClawModelRef(defaults.model.primary, key),
          fallbacks: defaults.model.fallbacks?.map((modelRef) =>
            rebaseOpenClawModelRef(modelRef, key),
          ),
        }
      : undefined,
    modelCatalog: defaults.modelCatalog
      ? Object.fromEntries(
          Object.entries(defaults.modelCatalog).map(([modelRef, entry]) => [
            rebaseOpenClawModelRef(modelRef, key),
            entry,
          ]),
        )
      : undefined,
  };
}

/**
 * OpenClaw API protocol options
 * @see https://github.com/openclaw/openclaw/blob/main/docs/gateway/configuration.md
 */
export const openclawApiProtocols = [
  { value: "openai-completions", label: "OpenAI Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "google-generative-ai", label: "Google Generative AI" },
  { value: "bedrock-converse-stream", label: "AWS Bedrock" },
] as const;

/**
 * OpenClaw provider presets list
 */
export const openclawProviderPresets: OpenClawProviderPreset[] = [
  {
    name: "Kimi",
    websiteUrl: "https://platform.kimi.com",
    apiKeyUrl: "https://platform.kimi.com/console/api-keys",
    settingsConfig: {
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "",
      api: "openai-completions",
      models: [
        {
          id: "kimi-k2.7-code",
          name: "Kimi K2.7 Code",
          contextWindow: 262144,
          cost: { input: 0.95, output: 4, cacheRead: 0.19 },
        },
        {
          id: "kimi-k3",
          name: "Kimi K3",
          contextWindow: 1048576,
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
        },
      ],
    },
    category: "cn_official",
    icon: "kimi",
    iconColor: "#6366F1",
    templateValues: {
      baseUrl: {
        label: "Base URL",
        placeholder: "https://api.moonshot.cn/v1",
        defaultValue: "https://api.moonshot.cn/v1",
        editorValue: "",
      },
      apiKey: {
        label: "API Key",
        placeholder: "sk-...",
        editorValue: "",
      },
    },
    suggestedDefaults: {
      model: { primary: "kimi/kimi-k2.7-code" },
      modelCatalog: { "kimi/kimi-k2.7-code": { alias: "Kimi" } },
    },
  },
  {
    name: "Kimi For Coding",
    websiteUrl: "https://www.kimi.com/code/",
    apiKeyUrl: "https://platform.kimi.com/console/api-keys",
    settingsConfig: {
      baseUrl: "https://api.kimi.com/coding/v1",
      apiKey: "",
      api: "openai-completions",
      models: [
        {
          id: "kimi-for-coding",
          name: "Kimi For Coding",
          contextWindow: 131072,
          cost: { input: 0.95, output: 4, cacheRead: 0.19 },
        },
      ],
    },
    category: "cn_official",
    icon: "kimi",
    iconColor: "#6366F1",
    templateValues: {
      baseUrl: {
        label: "Base URL",
        placeholder: "https://api.kimi.com/coding/v1",
        defaultValue: "https://api.kimi.com/coding/v1",
        editorValue: "",
      },
      apiKey: {
        label: "API Key",
        placeholder: "sk-...",
        editorValue: "",
      },
    },
    suggestedDefaults: {
      model: { primary: "kimi-coding/kimi-for-coding" },
      modelCatalog: { "kimi-coding/kimi-for-coding": { alias: "Kimi" } },
    },
  },
  {
    name: "DeepSeek",
    websiteUrl: "https://platform.deepseek.com",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    settingsConfig: {
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "",
      api: "openai-completions",
      models: [
        {
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          contextWindow: 1000000,
          cost: { input: 0.435, output: 0.87, cacheRead: 0.003625 },
        },
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          contextWindow: 1000000,
          cost: { input: 0.14, output: 0.28 },
        },
      ],
    },
    category: "cn_official",
    icon: "deepseek",
    iconColor: "#1E88E5",
    templateValues: {
      apiKey: {
        label: "API Key",
        placeholder: "sk-...",
        editorValue: "",
      },
    },
    suggestedDefaults: {
      model: {
        primary: "deepseek/deepseek-v4-flash",
        fallbacks: ["deepseek/deepseek-v4-pro"],
      },
      modelCatalog: {
        "deepseek/deepseek-v4-flash": { alias: "Flash" },
        "deepseek/deepseek-v4-pro": { alias: "Pro" },
      },
    },
  },
  {
    name: "Zhipu GLM",
    websiteUrl: "https://open.bigmodel.cn",
    apiKeyUrl: "https://www.bigmodel.cn/claude-code",
    settingsConfig: {
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      apiKey: "",
      api: "openai-completions",
      models: [
        {
          id: "glm-5.1",
          name: "GLM-5.1",
          contextWindow: 128000,
          cost: { input: 1.4, output: 4.4, cacheRead: 0.26 },
        },
      ],
    },
    category: "cn_official",
    icon: "zhipu",
    iconColor: "#0F62FE",
    templateValues: {
      baseUrl: {
        label: "Base URL",
        placeholder: "https://open.bigmodel.cn/api/coding/paas/v4",
        defaultValue: "https://open.bigmodel.cn/api/coding/paas/v4",
        editorValue: "",
      },
      apiKey: {
        label: "API Key",
        placeholder: "",
        editorValue: "",
      },
    },
    suggestedDefaults: {
      model: { primary: "zhipu/glm-5.1" },
      modelCatalog: { "zhipu/glm-5.1": { alias: "GLM" } },
    },
  },
  {
    name: "MiniMax",
    websiteUrl: "https://platform.minimax.cn",
    apiKeyUrl: "https://platform.minimax.cn/subscribe/token-plan",
    settingsConfig: {
      baseUrl: "https://api.minimax.cn/v1",
      apiKey: "",
      api: "openai-completions",
      models: [
        {
          id: "MiniMax-M3",
          name: "MiniMax M3",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1000000,
          maxTokens: 131072,
        },
      ],
    },
    category: "cn_official",
    theme: {
      backgroundColor: "#f64551",
      textColor: "#FFFFFF",
    },
    icon: "minimax",
    iconColor: "#FF6B6B",
    templateValues: {
      apiKey: {
        label: "API Key",
        placeholder: "",
        editorValue: "",
      },
    },
    suggestedDefaults: {
      model: { primary: "minimax/MiniMax-M3" },
      modelCatalog: { "minimax/MiniMax-M3": { alias: "MiniMax" } },
    },
  },
];
