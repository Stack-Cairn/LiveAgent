import { TASK_TRANSLATIONS } from "./taskTranslations";
import { EN_US_COMMON_TRANSLATIONS } from "./translations/enUSCommon";
import { EN_US_SETTINGS_TRANSLATIONS } from "./translations/enUSSettings";
import { ZH_CN_COMMON_TRANSLATIONS } from "./translations/zhCNCommon";
import { ZH_CN_SETTINGS_TRANSLATIONS } from "./translations/zhCNSettings";

export const SHARED_TRANSLATIONS = {
  "zh-CN": {
    ...TASK_TRANSLATIONS["zh-CN"],
    ...ZH_CN_COMMON_TRANSLATIONS,
    ...ZH_CN_SETTINGS_TRANSLATIONS,
  },
  "en-US": {
    ...TASK_TRANSLATIONS["en-US"],
    ...EN_US_COMMON_TRANSLATIONS,
    ...EN_US_SETTINGS_TRANSLATIONS,
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
