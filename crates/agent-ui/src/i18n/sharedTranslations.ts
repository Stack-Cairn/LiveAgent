import { PLANNING_TRANSLATIONS } from "./planningTranslations";
import { TASK_TRANSLATIONS } from "./taskTranslations";
import { CHECKPOINT_REWIND_TRANSLATIONS } from "./translations/checkpointRewindTranslations";
import { CONFIRM_DIALOG_TRANSLATIONS } from "./translations/confirmDialogTranslations";
import { EN_US_COMMON_TRANSLATIONS } from "./translations/enUSCommon";
import { EN_US_SETTINGS_TRANSLATIONS } from "./translations/enUSSettings";
import { HOSTED_SEARCH_TRANSLATIONS } from "./translations/hostedSearchTranslations";
import { IMAGE_SETTINGS_TRANSLATIONS } from "./translations/imageSettingsTranslations";
import { ONBOARDING_DIAGNOSTICS_TRANSLATIONS } from "./translations/onboardingDiagnosticsTranslations";
import { SANDBOXED_UI_TRANSLATIONS } from "./translations/sandboxedUiTranslations";
import { STT_TRANSLATIONS } from "./translations/sttTranslations";
import { TEXT_FORMAT_TRANSLATIONS } from "./translations/textFormatTranslations";
import { ZH_CN_COMMON_TRANSLATIONS } from "./translations/zhCNCommon";
import { ZH_CN_SETTINGS_TRANSLATIONS } from "./translations/zhCNSettings";
import { WORKBENCH_TRANSLATIONS } from "./workbenchTranslations";

export const SHARED_TRANSLATIONS = {
  "zh-CN": {
    ...TASK_TRANSLATIONS["zh-CN"],
    ...PLANNING_TRANSLATIONS["zh-CN"],
    ...ZH_CN_COMMON_TRANSLATIONS,
    ...ZH_CN_SETTINGS_TRANSLATIONS,
    ...CONFIRM_DIALOG_TRANSLATIONS["zh-CN"],
    ...IMAGE_SETTINGS_TRANSLATIONS["zh-CN"],
    ...CHECKPOINT_REWIND_TRANSLATIONS["zh-CN"],
    ...HOSTED_SEARCH_TRANSLATIONS["zh-CN"],
    ...STT_TRANSLATIONS["zh-CN"],
    ...TEXT_FORMAT_TRANSLATIONS["zh-CN"],
    ...WORKBENCH_TRANSLATIONS["zh-CN"],
    ...SANDBOXED_UI_TRANSLATIONS["zh-CN"],
    ...ONBOARDING_DIAGNOSTICS_TRANSLATIONS["zh-CN"],
  },
  "en-US": {
    ...TASK_TRANSLATIONS["en-US"],
    ...PLANNING_TRANSLATIONS["en-US"],
    ...EN_US_COMMON_TRANSLATIONS,
    ...EN_US_SETTINGS_TRANSLATIONS,
    ...CONFIRM_DIALOG_TRANSLATIONS["en-US"],
    ...IMAGE_SETTINGS_TRANSLATIONS["en-US"],
    ...CHECKPOINT_REWIND_TRANSLATIONS["en-US"],
    ...HOSTED_SEARCH_TRANSLATIONS["en-US"],
    ...STT_TRANSLATIONS["en-US"],
    ...TEXT_FORMAT_TRANSLATIONS["en-US"],
    ...WORKBENCH_TRANSLATIONS["en-US"],
    ...SANDBOXED_UI_TRANSLATIONS["en-US"],
    ...ONBOARDING_DIAGNOSTICS_TRANSLATIONS["en-US"],
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
