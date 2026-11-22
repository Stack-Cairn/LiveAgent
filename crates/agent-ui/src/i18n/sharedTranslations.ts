import { PLANNING_TRANSLATIONS } from "./planningTranslations";
import { TASK_TRANSLATIONS } from "./taskTranslations";
import { CONFIRM_DIALOG_TRANSLATIONS } from "./translations/confirmDialogTranslations";
import { EN_US_COMMON_TRANSLATIONS } from "./translations/enUSCommon";
import { EN_US_SETTINGS_TRANSLATIONS } from "./translations/enUSSettings";
import { ZH_CN_COMMON_TRANSLATIONS } from "./translations/zhCNCommon";
import { ZH_CN_SETTINGS_TRANSLATIONS } from "./translations/zhCNSettings";

export const SHARED_TRANSLATIONS = {
  "zh-CN": {
    ...TASK_TRANSLATIONS["zh-CN"],
    ...PLANNING_TRANSLATIONS["zh-CN"],
    ...ZH_CN_COMMON_TRANSLATIONS,
    ...ZH_CN_SETTINGS_TRANSLATIONS,
    ...CONFIRM_DIALOG_TRANSLATIONS["zh-CN"],
  },
  "en-US": {
    ...TASK_TRANSLATIONS["en-US"],
    ...PLANNING_TRANSLATIONS["en-US"],
    ...EN_US_COMMON_TRANSLATIONS,
    ...EN_US_SETTINGS_TRANSLATIONS,
    ...CONFIRM_DIALOG_TRANSLATIONS["en-US"],
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
