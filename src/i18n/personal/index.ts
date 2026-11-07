import en from "./en.json";
import ja from "./ja.json";
import tr from "./tr.json";
import zh from "./zh.json";
import zhTW from "./zh-TW.json";

type TranslationObject = { [key: string]: string | TranslationObject };
const personalTranslations = { en, ja, tr, zh, "zh-TW": zhTW };

/** 自用文案优先，上游新增和未覆盖的文案继续继承；不修改原始资源。 */
export function mergePersonalTranslations(
  upstream: TranslationObject,
  overrides: TranslationObject,
): TranslationObject {
  const result = { ...upstream };
  for (const [key, value] of Object.entries(overrides)) {
    const original = result[key];
    result[key] =
      typeof value === "object" && typeof original === "object"
        ? mergePersonalTranslations(original, value)
        : value;
  }
  return result;
}

export function withPersonalTranslations(
  language: keyof typeof personalTranslations,
  upstream: TranslationObject,
): TranslationObject {
  return mergePersonalTranslations(upstream, personalTranslations[language]);
}
