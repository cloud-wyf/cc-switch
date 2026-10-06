/**
 * Hermes Agent provider presets configuration
 * Hermes uses custom_providers array in config.yaml
 */
import type { ProviderCategory } from "../types";
import type { PresetTheme, TemplateValueConfig } from "./claudeProviderPresets";
import type { PresetFamilyFields } from "./presetFamilies";

/**
 * Marker field and source values that `hermes_config.rs::get_providers`
 * injects onto each settings payload. Kept in sync with the Rust constants
 * `PROVIDER_SOURCE_FIELD` / `PROVIDER_SOURCE_CUSTOM_LIST` / `PROVIDER_SOURCE_DICT`.
 */
export const HERMES_PROVIDER_SOURCE_FIELD = "_cc_source";
export const HERMES_PROVIDER_SOURCE_CUSTOM_LIST = "custom_providers";
export const HERMES_PROVIDER_SOURCE_DICT = "providers_dict";

/**
 * True when the provider was sourced from Hermes' v12+ `providers:` dict —
 * CC Switch renders those read-only and routes edits to Hermes Web UI.
 */
export function isHermesReadOnlyProvider(settingsConfig: unknown): boolean {
  if (!settingsConfig || typeof settingsConfig !== "object") {
    return false;
  }
  const marker = (settingsConfig as Record<string, unknown>)[
    HERMES_PROVIDER_SOURCE_FIELD
  ];
  return marker === HERMES_PROVIDER_SOURCE_DICT;
}

/**
 * A model entry under a Hermes custom_provider.
 *
 * Serialized to YAML as a dict keyed by `id`:
 *
 * ```yaml
 * models:
 *   anthropic/claude-opus-5:
 *     context_length: 200000
 * ```
 *
 * Hermes' `_VALID_CUSTOM_PROVIDER_FIELDS` (hermes_cli/config.py) does not include
 * `max_tokens` at the per-model level — writing it produces an "unknown field"
 * warning on Hermes startup. Max tokens is a per-request parameter, not a
 * provider-level config.
 */
export interface HermesModel {
  /** Model ID — becomes the YAML key and the value written to top-level model.default. */
  id: string;
  /** Optional display label (UI only, not serialized to YAML). */
  name?: string;
  /** Override the auto-detected context window. */
  context_length?: number;
}

/**
 * Top-level `model:` defaults suggested by a preset.
 *
 * Written to the YAML `model:` section when the user switches to this provider.
 * Per-model `context_length` lives on the individual `HermesModel` entries and
 * flows through `custom_providers[].models`, not this object.
 */
export interface HermesSuggestedDefaults {
  model: {
    /** Model ID for `model.default`. Typically equals `models[0].id`. */
    default: string;
    /** Value for `model.provider`. Omit to use the custom_provider name. */
    provider?: string;
  };
}

/** Hermes custom_provider protocol mode. Always written explicitly. */
export type HermesApiMode =
  | "chat_completions"
  | "anthropic_messages"
  | "codex_responses"
  | "bedrock_converse";

/** Default mode used when a provider has no stored value yet. */
export const HERMES_DEFAULT_API_MODE: HermesApiMode = "chat_completions";

/** Dropdown options for the API Mode selector. `labelKey` is looked up in i18n. */
export const hermesApiModes: Array<{
  value: HermesApiMode;
  labelKey: string;
}> = [
  { value: "chat_completions", labelKey: "hermes.form.apiModeChatCompletions" },
  {
    value: "anthropic_messages",
    labelKey: "hermes.form.apiModeAnthropicMessages",
  },
  { value: "codex_responses", labelKey: "hermes.form.apiModeCodexResponses" },
  {
    value: "bedrock_converse",
    labelKey: "hermes.form.apiModeBedrockConverse",
  },
];

export interface HermesProviderPreset extends PresetFamilyFields {
  name: string;
  nameKey?: string;
  websiteUrl: string;
  apiKeyUrl?: string;
  settingsConfig: HermesProviderSettingsConfig;
  isOfficial?: boolean;
  isPartner?: boolean;
  primePartner?: boolean; // 旧版的置顶合作伙伴标记；v7 起界面不再读取，新预设不写
  partnerPromotionKey?: string;
  category?: ProviderCategory;
  templateValues?: Record<string, TemplateValueConfig>;
  theme?: PresetTheme;
  icon?: string;
  iconColor?: string;
  isCustomTemplate?: boolean;
  /** Optional top-level `model:` defaults written on switch. */
  suggestedDefaults?: HermesSuggestedDefaults;
}

export interface HermesProviderSettingsConfig {
  name: string;
  base_url?: string;
  api_key?: string;
  api_mode?: HermesApiMode;
  /** UI-side ordered list; serialized to YAML as a dict keyed by id. */
  models?: HermesModel[];
  /** Delay in seconds between consecutive requests to this provider. */
  rate_limit_delay?: number;
  [key: string]: unknown;
}

export const hermesProviderPresets: HermesProviderPreset[] = [
  {
    name: "Kimi",
    family: "kimi",
    planKey: "payg",
    regionKey: "cn",

    websiteUrl: "https://platform.kimi.com",
    settingsConfig: {
      name: "kimi",
      base_url: "https://api.moonshot.cn/v1",
      api_key: "",
      api_mode: "chat_completions",
      models: [
        { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
        { id: "kimi-k3", name: "Kimi K3", context_length: 1048576 },
        {
          id: "kimi-k2.7-code-highspeed",
          name: "Kimi K2.7 Code HighSpeed",
          context_length: 262144,
        },
        { id: "kimi-k2.6", name: "Kimi K2.6", context_length: 262144 },
      ],
    },
    category: "cn_official",

    icon: "kimi",
    iconColor: "#6366F1",
    suggestedDefaults: {
      model: { default: "kimi-k2.7-code", provider: "kimi" },
    },
  },
  {
    name: "Kimi For Coding",
    family: "kimi",
    planKey: "coding",
    regionKey: "cn",

    websiteUrl: "https://www.kimi.com/code/",
    settingsConfig: {
      name: "kimi_coding",
      base_url: "https://api.kimi.com/coding/",
      api_key: "",
      api_mode: "anthropic_messages",
      models: [{ id: "kimi-for-coding", name: "Kimi For Coding" }],
    },
    category: "cn_official",
    icon: "kimi",
    iconColor: "#6366F1",
    suggestedDefaults: {
      model: { default: "kimi-for-coding", provider: "kimi_coding" },
    },
  },
  {
    name: "DeepSeek",
    nameKey: "providerForm.presets.deepseek",
    websiteUrl: "https://platform.deepseek.com",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    settingsConfig: {
      name: "deepseek",
      base_url: "https://api.deepseek.com",
      api_key: "",
      api_mode: "chat_completions",
      models: [
        {
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          context_length: 1000000,
        },
        {
          id: "deepseek-flash",
          name: "DeepSeek V4.1 Flash",
          context_length: 1000000,
        },
      ],
    },
    category: "cn_official",
    icon: "deepseek",
    iconColor: "#4D6BFE",
    suggestedDefaults: {
      model: { default: "deepseek-flash", provider: "deepseek" },
    },
  },
  {
    name: "Zhipu GLM",
    family: "zhipu",
    regionKey: "cn",
    websiteUrl: "https://open.bigmodel.cn",
    apiKeyUrl: "https://www.bigmodel.cn/claude-code",
    settingsConfig: {
      name: "zhipu_glm",
      base_url: "https://open.bigmodel.cn/api/coding/paas/v4",
      api_key: "",
      api_mode: "chat_completions",
      models: [
        { id: "glm-5.3", name: "GLM-5.3" },
        { id: "glm-5.3-flash", name: "GLM-5.3-Flash", context_length: 1048576 },
      ],
    },
    category: "cn_official",
    icon: "zhipu",
    iconColor: "#0F62FE",
    suggestedDefaults: {
      model: { default: "glm-5.3", provider: "zhipu_glm" },
    },
  },
  {
    name: "MiniMax",
    family: "minimax",
    regionKey: "cn",
    websiteUrl: "https://platform.minimax.cn",
    apiKeyUrl: "https://platform.minimax.cn/subscribe/token-plan",
    settingsConfig: {
      name: "minimax",
      base_url: "https://api.minimax.cn/v1",
      api_key: "",
      api_mode: "chat_completions",
      models: [{ id: "MiniMax-M3", name: "MiniMax M3" }],
    },
    category: "cn_official",
    theme: { backgroundColor: "#f64551", textColor: "#FFFFFF" },
    icon: "minimax",
    iconColor: "#FF6B6B",
    suggestedDefaults: {
      model: { default: "MiniMax-M3", provider: "minimax" },
    },
  },
];
