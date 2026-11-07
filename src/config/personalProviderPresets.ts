/** 自用名单与链接规则；上游目录保持原样，模型和协议参数随上游更新。 */
import { providerPresets as upstreamClaude } from "./claudeProviderPresets";
import { claudeDesktopProviderPresets as upstreamDesktop } from "./claudeDesktopProviderPresets";
import { codexProviderPresets as upstreamCodex } from "./codexProviderPresets";
import { geminiProviderPresets as upstreamGemini } from "./geminiProviderPresets";
import { grokBuildProviderPresets as upstreamGrok } from "./grokBuildProviderPresets";
import { hermesProviderPresets as upstreamHermes } from "./hermesProviderPresets";
import { openclawProviderPresets as upstreamOpenClaw } from "./openclawProviderPresets";
import { opencodeProviderPresets as upstreamOpenCode } from "./opencodeProviderPresets";
import { piProviderPresets as upstreamPi } from "./piProviderPresets";
import { mcodeProviderPresets as upstreamMcode } from "./mcodeProviderPresets";
import { universalProviderPresets as upstreamUniversal } from "./universalProviderPresets";
import { kimiProviderPresets as upstreamKimi } from "./kimiProviderPresets";
import { ompProviderPresets as upstreamOmp } from "./ompProviderPresets";
import { dshProviderPresets as upstreamDsh } from "./dshProviderPresets";

const RETAINED = [
  "Kimi",
  "Kimi For Coding",
  "DeepSeek",
  "Zhipu GLM",
  "MiniMax",
] as const;

interface PersonalPreset {
  name: string;
  websiteUrl?: string;
  apiKeyUrl?: string;
  primePartner?: boolean;
  isPartner?: boolean;
  partnerPromotionKey?: string;
}

function cleanLink(value: string): string {
  const url = new URL(value);
  const originalQuery = url.search;
  for (const key of ["aff", "track_id", "invite", "ref"])
    url.searchParams.delete(key);
  if (url.search === originalQuery) return value;
  // 保留原链接的末尾斜杠，避免纯迁移改变表单默认值。
  const clean = url.toString();
  return url.pathname === "/" && !value.split("?")[0].endsWith("/")
    ? clean.replace(/\/$/, "")
    : clean;
}

function retain<T extends PersonalPreset>(
  upstream: readonly T[],
  names: readonly string[],
): T[] {
  return names.map((name) => {
    const source = upstream.find((preset) => preset.name === name);
    if (!source) throw new Error(`自用预设已被上游移除或重命名：${name}`);
    const preset = { ...source };
    delete preset.primePartner;
    delete preset.isPartner;
    if (name !== "Google Official") delete preset.partnerPromotionKey;
    if (preset.websiteUrl) preset.websiteUrl = cleanLink(preset.websiteUrl);
    if (preset.apiKeyUrl) preset.apiKeyUrl = cleanLink(preset.apiKeyUrl);
    if (name === "Zhipu GLM")
      preset.apiKeyUrl = "https://www.bigmodel.cn/claude-code";
    return preset;
  });
}

export const providerPresets = retain(upstreamClaude, [
  "Claude Official",
  ...RETAINED,
]);
export const claudeDesktopProviderPresets = retain(upstreamDesktop, [
  "Claude Desktop Official",
  ...RETAINED,
]);
export const codexProviderPresets = retain(upstreamCodex, [
  "OpenAI Official",
  ...RETAINED,
]);
export const geminiProviderPresets = retain(upstreamGemini, [
  "Google Official",
]);
export const grokBuildProviderPresets = retain(upstreamGrok, []);
export const hermesProviderPresets = retain(upstreamHermes, RETAINED);
export const openclawProviderPresets = retain(upstreamOpenClaw, RETAINED);
export const opencodeProviderPresets = retain(upstreamOpenCode, RETAINED);
export const piProviderPresets = retain(upstreamPi, RETAINED);
export const mcodeProviderPresets = retain(upstreamMcode, RETAINED);
export const kimiProviderPresets = retain(upstreamKimi, RETAINED);
export const ompProviderPresets = retain(upstreamOmp, RETAINED);
export const dshProviderPresets = retain(upstreamDsh, RETAINED);

const newApi = retain(upstreamUniversal, ["NewAPI"])[0];
export const universalProviderPresets = [
  newApi,
  {
    ...newApi,
    name: "自定义网关",
    providerType: "custom_gateway",
    websiteUrl: undefined,
    icon: "openai",
    iconColor: "#6366F1",
    description: "自定义配置的 API 网关",
    isCustomTemplate: true,
  },
];
