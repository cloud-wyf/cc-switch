/**
 * Codex 预设供应商配置模板
 */
import { ProviderCategory } from "../types";
import type {
  CodexApiFormat,
  CodexCatalogModel,
  CodexChatReasoning,
  PromptCacheRoutingMode,
} from "../types";
import type { PresetTheme } from "./claudeProviderPresets";
import type { PresetFamilyFields } from "./presetFamilies";

export interface CodexProviderPreset extends PresetFamilyFields {
  name: string;
  nameKey?: string; // i18n key for localized display name
  websiteUrl: string;
  // 第三方供应商可提供单独的获取 API Key 链接
  apiKeyUrl?: string;
  auth: Record<string, any>; // 将写入 ~/.codex/auth.json
  config: string; // 将写入 ~/.codex/config.toml（TOML 字符串）
  isOfficial?: boolean; // 标识是否为官方预设
  isPartner?: boolean; // 标识是否为商业合作伙伴
  primePartner?: boolean; // 旧版的置顶合作伙伴标记；v7 起界面不再读取，新预设不写
  partnerPromotionKey?: string; // 合作伙伴促销信息的 i18n key
  category?: ProviderCategory; // 新增：分类
  isCustomTemplate?: boolean; // 标识是否为自定义模板
  // 新增：请求地址候选列表（用于地址管理/测速）
  endpointCandidates?: string[];
  // 新增：视觉主题配置
  theme?: PresetTheme;
  // 图标配置
  icon?: string; // 图标名称
  iconColor?: string; // 图标颜色
  // Codex API 格式
  apiFormat?: CodexApiFormat;
  // 仅用于区分预设来源；ChatGPT/Codex 与 xAI/Grok 的认证流程彼此独立。
  providerType?: "codex_oauth" | "xai_oauth";
  // OAuth 预设：隐藏 API Key 输入，保存前要求已登录托管账号
  requiresOAuth?: boolean;
  // Codex Chat 本地路由模式下的模型目录
  modelCatalog?: CodexCatalogModel[];
  // Codex Responses -> Chat Completions reasoning capability defaults
  codexChatReasoning?: CodexChatReasoning;
  // Session-based prompt-cache routing override for Chat Completions upstreams
  promptCacheRouting?: PromptCacheRoutingMode;
}

/**
 * 生成第三方供应商的 auth.json
 */
export function generateThirdPartyAuth(apiKey: string): Record<string, any> {
  return {
    OPENAI_API_KEY: apiKey || "",
  };
}

/**
 * 生成第三方供应商的 config.toml
 */
export function generateThirdPartyConfig(
  providerName: string,
  baseUrl: string,
  modelName = "gpt-5.6-sol",
  options?: {
    // 托管 OAuth 预设（requiresOAuth 卡）必须传 false：这类卡无静态 key，
    // requires_openai_auth = true 会被后端 keyless 安全闸拒绝切换
    // （provider.codex.config.official_auth_fallback）。
    requiresOpenAiAuth?: boolean;
  },
): string {
  const tomlString = (value: string) => JSON.stringify(value);
  const requiresOpenAiAuth = options?.requiresOpenAiAuth ?? true;

  return `model_provider = "custom"
model = ${tomlString(modelName)}
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.custom]
name = ${tomlString(providerName)}
base_url = ${tomlString(baseUrl)}
wire_api = "responses"
requires_openai_auth = ${requiresOpenAiAuth}`;
}

function modelCatalog(
  models: Array<
    | string
    | {
        model: string;
        displayName?: string;
        contextWindow?: number;
        // Native Responses (direct) overrides for the generated
        // model-catalogs.json. Omitted input modalities are inferred by the
        // backend: confirmed text-only models stay text-only; everything else
        // defaults to text+image.
        supportsParallelToolCalls?: boolean;
        inputModalities?: string[];
        // Vendor's OFFICIAL base_instructions; omit to inherit the neutral
        // template default. Required by Codex, so the backend always emits one.
        baseInstructions?: string;
        // Reasoning efforts the vendor's endpoint actually accepts (subset of
        // none/minimal/low/medium/high/xhigh/max/ultra). Omit to keep the
        // template's conservative none/high default. Pre-filled from official
        // vendor docs; users can still edit per provider in the form.
        reasoningLevels?: string[];
        defaultReasoningLevel?: string;
      }
  >,
): CodexCatalogModel[] {
  return models.map((entry) =>
    typeof entry === "string"
      ? { model: entry }
      : {
          model: entry.model,
          displayName: entry.displayName,
          contextWindow: entry.contextWindow,
          supportsParallelToolCalls: entry.supportsParallelToolCalls,
          inputModalities: entry.inputModalities,
          baseInstructions: entry.baseInstructions,
          reasoningLevels: entry.reasoningLevels,
          defaultReasoningLevel: entry.defaultReasoningLevel,
        },
  );
}

export const codexProviderPresets: CodexProviderPreset[] = [
  {
    name: "OpenAI Official",
    websiteUrl: "https://chatgpt.com/codex",
    isOfficial: true,
    category: "official",
    providerType: "codex_oauth",
    auth: {},
    config: ``,
    theme: {
      icon: "codex",
      backgroundColor: "#1F2937", // gray-800
      textColor: "#FFFFFF",
    },
    icon: "openai",
    iconColor: "#00A67E",
  },
  {
    name: "Kimi",
    family: "kimi",
    planKey: "payg",
    regionKey: "cn",

    websiteUrl: "https://platform.kimi.com",
    apiKeyUrl: "https://platform.kimi.com/console/api-keys",
    auth: generateThirdPartyAuth(""),
    config: generateThirdPartyConfig(
      "kimi",
      "https://api.moonshot.cn/v1",
      "kimi-k3",
    ),
    endpointCandidates: ["https://api.moonshot.cn/v1"],
    // 原生 Responses 直连（不需要本地路由接管）：官方 Codex 接入文档
    //（platform.kimi.com/docs/guide/codex-kimi.md，直接以 CC Switch 为例）
    // 给出 base_url = https://api.moonshot.cn/v1 + wire_api = "responses"，
    // 并明写开放平台「原生支持 Codex 使用的 Responses API，无需协议转换或本
    // 地代理」；接口参考 platform.kimi.com/docs/api/responses.md（POST
    // /v1/responses、reasoning.effort 枚举 low/high/max、tool_choice 仅
    // auto、支持 prompt_cache_key，usage 带 cached_tokens）。2026-09-09 真
    // Key 探针：Codex 0.153.4 的全量请求形态（include
    // reasoning.encrypted_content + reasoning.summary + text.verbosity）与
    // 流式事件序列均 200；kimi-k2.7-code 亦 200——文档只列 kimi-k3，属未文
    // 档化能力，厂商若收回从 catalog 删行即可。存量 openai_chat 卡片的
    // thinking/reasoning_effort 注入来自卡片自身 meta.codexChatReasoning
    //（预设已不再携带），那条路径的 Kimi 400 仍首查该注入
    apiFormat: "openai_responses",
    modelCatalog: modelCatalog([
      // 首行 = 默认模型（catalog[0] 须与 config.toml 的 model 一致）：
      // kimi-k3 是官方 Codex 文档与 Responses OpenAPI 唯一列出的模型
      //（Jason 2026-09-10 拍板，推翻 07-17「k3 排在 k2.7-code 之后」的旧序）。
      // 档位照抄官方参数文档（2026-08-15 盘点，2026-09-09 复核）：k3 不可关
      // 思考、reasoning.effort 三档官方默认 max；k2.7-code 始终思考、官方标注
      // 不支持 reasoning_effort → 单档 high（防模板假差异档，LongCat 先例）。
      // 两模型都关不掉思考，none 一律不列。k3 不声明 default：native 模板
      // 默认 high ∈ 子集 → 后端保留 high，与本预设 config.toml 顶层
      // model_reasoning_effort = "high"（实际下发值）一致；catalog 默认只
      // 标记 Codex /model 选择器，声明 max 会展示一个实际不下发的默认值。
      // supportsParallelToolCalls 两行填 true：Kimi Code 官方 catalog 对同一
      // K3 明写 true，且探针里两端点都把 parallel_tool_calls 回显为 true；
      // 不填会让 Codex ≤0.148 用户从 ProxyChat 模板的 true 退化成 native
      // 模板的 false（0.153.4 起该字段已不存在，填了无害）
      {
        model: "kimi-k3",
        displayName: "Kimi K3",
        contextWindow: 1048576,
        supportsParallelToolCalls: true,
        reasoningLevels: ["low", "high", "max"],
      },
      {
        model: "kimi-k2.7-code",
        displayName: "Kimi K2.7 Code",
        contextWindow: 262144,
        supportsParallelToolCalls: true,
        reasoningLevels: ["high"],
      },
    ]),
    category: "cn_official",

    icon: "kimi",
    iconColor: "#6366F1",
  },
  {
    name: "Kimi For Coding",
    family: "kimi",
    planKey: "coding",
    regionKey: "cn",

    websiteUrl: "https://www.kimi.com/code/",
    apiKeyUrl: "https://www.kimi.com/code/",
    auth: generateThirdPartyAuth(""),
    config: generateThirdPartyConfig(
      "kimi_coding",
      "https://api.kimi.com/coding/v1",
      "kimi-for-coding",
    ),
    endpointCandidates: ["https://api.kimi.com/coding/v1"],
    // 原生 Responses 直连（不需要本地路由接管）：官方 Codex 接入文档
    //（kimi.com/code/docs/third-party-tools/codex.html，以 CC Switch 为例）
    // 给出 base_url = https://api.kimi.com/coding/v1 且 wire_api「必须填
    // responses」，并明写「Kimi Code 服务端原生支持 OpenAI Responses API
    //（流式/非流式、reasoning、function calling 均可用），无需任何本地路由
    // 或协议转换工具」。2026-09-09 真 Key 探针：四个模型在 Codex 全量请求
    // 形态下均 200，reasoning item 带真实 encrypted_content；同
    // prompt_cache_key 的二次请求命中 cached_tokens——直连时
    // prompt_cache_key 由 Codex 自己发，不再需要转换层的 promptCacheRouting
    // 重注入
    apiFormat: "openai_responses",
    modelCatalog: modelCatalog([
      // 官方 Codex 指南（2026-09-15）：kimi-for-coding 已升级 K2.8 Preview，
      // 最高 1M 上下文、low/high/max。高速版仍为 256K，独立保留其档位。
      // k3 的 1M 权限取决于会员档位，k3-256k 固定 256K。
      {
        model: "kimi-for-coding",
        displayName: "Kimi For Coding (K2.8 Preview)",
        contextWindow: 1048576,
        supportsParallelToolCalls: true,
        inputModalities: ["text", "image"],
        reasoningLevels: ["low", "high", "max"],
        defaultReasoningLevel: "high",
      },
      {
        model: "kimi-for-coding-highspeed",
        displayName: "Kimi For Coding HighSpeed",
        contextWindow: 262144,
        supportsParallelToolCalls: true,
        reasoningLevels: ["high"],
      },
      {
        model: "k3",
        displayName: "Kimi K3",
        contextWindow: 1048576,
        supportsParallelToolCalls: true,
        reasoningLevels: ["low", "high", "max"],
        defaultReasoningLevel: "high",
      },
      {
        model: "k3-256k",
        displayName: "Kimi K3 256K",
        contextWindow: 262144,
        supportsParallelToolCalls: true,
        reasoningLevels: ["low", "high", "max"],
        defaultReasoningLevel: "high",
      },
    ]),
    category: "cn_official",
    icon: "kimi",
    iconColor: "#6366F1",
  },
  {
    name: "DeepSeek",
    websiteUrl: "https://platform.deepseek.com",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    auth: generateThirdPartyAuth(""),
    config: generateThirdPartyConfig(
      "deepseek",
      "https://api.deepseek.com",
      "deepseek-flash",
    ),
    endpointCandidates: ["https://api.deepseek.com"],
    // DeepSeek 官方 Codex 文档（api-docs.deepseek.com → agent_integrations/codex）：
    // 当前官方推荐 deepseek-flash（V4.1 Flash）；旧 v4-flash 别名继续由后端兼容。
    // deepseek-flash 原生 Responses（wire_api=responses 对自家 base_url），无需路由接管转换。
    // 后端按 deepseek.com host 直接镜像官方 models.json（freeform apply_patch +
    // GPT-5 harness + low/high/max 思考档，需 codex >= 0.144.0），这里只保留行清单与展示名。
    // 档位照抄官方 catalog（low/high/max 默认 high，2026-08-15 复核 flash/pro
    // 逐字节一致）：per-row 值会覆盖官方镜像，DeepSeek 官方目录变更时须同步这里
    // （Jason 2026-08-15 拍板：表单可见性优先于快照过时风险，"未设置"误导性更大）
    apiFormat: "openai_responses",
    modelCatalog: modelCatalog([
      {
        model: "deepseek-flash",
        displayName: "DeepSeek V4.1 Flash",
        inputModalities: ["text", "image"],
        contextWindow: 1048576,
        reasoningLevels: ["low", "high", "max"],
      },
      // pro 已于 2026-08 开通 Responses/Codex 集成（官方 catalog 条目与 flash 仅差 priority）
      {
        model: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        inputModalities: ["text"],
        contextWindow: 1048576,
        reasoningLevels: ["low", "high", "max"],
      },
    ]),
    category: "cn_official",
    icon: "deepseek",
    iconColor: "#1E88E5",
  },
  {
    name: "Zhipu GLM",
    family: "zhipu",
    regionKey: "cn",
    websiteUrl: "https://open.bigmodel.cn",
    apiKeyUrl: "https://www.bigmodel.cn/claude-code",
    auth: generateThirdPartyAuth(""),
    // 智谱三端点分立（docs.bigmodel.cn/cn/coding-plan/tool/others）：Anthropic
    // /api/anthropic、OpenAI Chat /api/coding/paas/v4、OpenAI Responses /api/v1，
    // 并明示「错误配置端点将导致无法使用 GLM Coding Plan 套餐额度」。Codex 直连
    // 发的是 Responses wire，base_url 必须是 /api/v1；Chat 端点上的 /responses
    // 是严格旧网关（拒 type=custom 工具 → #6944 的 400）
    config: generateThirdPartyConfig(
      "zhipu_glm",
      "https://open.bigmodel.cn/api/v1",
      "glm-5.3",
    ),
    endpointCandidates: ["https://open.bigmodel.cn/api/v1"],
    // 官方 Codex 接入页（docs.bigmodel.cn/cn/coding-plan/tool/codex，2026-09-04
    // 核对）：wire_api=responses 对自家 /api/v1，与 MiMo/MiniMax 同为原生直连
    // → NativeResponses profile（shell_command 编辑、不发 freeform apply_patch；
    // 官方目录虽声明 freeform，无真机验证前按保守口径，不引入 400 风险）
    apiFormat: "openai_responses",
    // 档位/上下文/模态照抄官方 models.json：glm-5.3 low/high/max 默认 max；
    // glm-5-turbo 官方档位为空、默认 max——cc-switch 表达不了空档位（回落会得到
    // 模板 none/high，none 在原生直连下没有转换层兜底、会原样发给严格网关），
    // 按官方默认收成单档 max。两模型为纯文本、并行工具调用 true。
    // glm-5.3-flash 例外：官方 Codex models.json 尚未收录（2026-09-26 核对），
    // 依据是模型页 docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash——原生
    // 多模态、1M 上下文、「文本参数与 GLM-5.3 保持一致」、GLM Coding Plan 已全量
    // 开放；档位与并行工具调用据此对齐 glm-5.3。预设自带这一行，用户就不必把
    // glm-5.3 行改名成 flash（改名会连带继承该行隐藏的 ["text"] 声明，Codex
    // 因此拦截图片，见 #7688）。
    modelCatalog: modelCatalog([
      {
        model: "glm-5.3",
        displayName: "GLM-5.3",
        contextWindow: 1048576,
        inputModalities: ["text"],
        supportsParallelToolCalls: true,
        reasoningLevels: ["low", "high", "max"],
        defaultReasoningLevel: "max",
      },
      {
        model: "glm-5.3-flash",
        displayName: "GLM-5.3-Flash",
        contextWindow: 1048576,
        inputModalities: ["text", "image"],
        supportsParallelToolCalls: true,
        reasoningLevels: ["low", "high", "max"],
        defaultReasoningLevel: "max",
      },
      {
        model: "glm-5-turbo",
        displayName: "GLM-5-Turbo",
        contextWindow: 204800,
        inputModalities: ["text"],
        supportsParallelToolCalls: true,
        reasoningLevels: ["max"],
      },
    ]),
    category: "cn_official",
    icon: "zhipu",
    iconColor: "#0F62FE",
  },
  {
    name: "MiniMax",
    family: "minimax",
    regionKey: "cn",
    websiteUrl: "https://platform.minimax.cn",
    apiKeyUrl: "https://platform.minimax.cn/subscribe/token-plan",
    auth: generateThirdPartyAuth(""),
    config: generateThirdPartyConfig(
      "minimax",
      "https://api.minimax.cn/v1",
      "MiniMax-M3",
    ),
    endpointCandidates: ["https://api.minimax.cn/v1"],
    // MiniMax 官方 API 参考已列 /v1/responses 为正式端点（CN/intl 双区，POST /v1/responses），原生 Responses，无需路由接管转换
    apiFormat: "openai_responses",
    // 官方 Codex catalog（platform.minimax.cn/docs/token-plan/codex）：
    // shell_command 编辑、并行工具、文本+图像，不声明 freeform apply_patch。
    // 档位照抄官方 catalog：none/high（M3 的 effort 是思考开关，minimal/low/medium
    // 端点接受但与 high 行为完全等价，不给假差异档）。与模板默认一致故 Codex 侧
    // 零行为变化，显式声明只为表单可见（"未设置"误导性更大，Jason 2026-08-15 拍板）
    modelCatalog: modelCatalog([
      {
        model: "MiniMax-M3",
        displayName: "MiniMax-M3",
        contextWindow: 1000000,
        reasoningLevels: ["none", "high"],
        supportsParallelToolCalls: true,
        inputModalities: ["text", "image"],
        baseInstructions:
          "You are Codex, a coding agent based on MiniMax-M3. You and the user share the same workspace and collaborate to achieve the user's goals.",
      },
    ]),
    category: "cn_official",
    theme: {
      backgroundColor: "#f64551",
      textColor: "#FFFFFF",
    },
    icon: "minimax",
    iconColor: "#FF6B6B",
  },
];
