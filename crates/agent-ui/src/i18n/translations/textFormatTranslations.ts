/** Locale-specific punctuation and small composition patterns (separators, inline name/id pairs). */
export const TEXT_FORMAT_TRANSLATIONS = {
  "zh-CN": {
    "format.groupSeparator": " ｜ ",
    "format.deleteQuestionEnd": "？",
    "settings.cuaDriver.stepAriaLabel": "{step}，{state}",
  },
  "en-US": {
    "format.groupSeparator": " | ",
    "format.deleteQuestionEnd": "? ",
    "settings.cuaDriver.stepAriaLabel": "{step}, {state}",
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
