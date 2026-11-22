/** Locale-specific punctuation and small composition patterns (separators, inline name/id pairs). */
export const TEXT_FORMAT_TRANSLATIONS = {
  "zh-CN": {
    "format.groupSeparator": " ｜ ",
    "format.listSeparator": "、",
    "format.deleteQuestionEnd": "？",
    "settings.cuaDriver.stepAriaLabel": "{step}，{state}",
    "settings.legacyProviderEntry": "{name}（{id}）",
  },
  "en-US": {
    "format.groupSeparator": " | ",
    "format.listSeparator": ", ",
    "format.deleteQuestionEnd": "? ",
    "settings.cuaDriver.stepAriaLabel": "{step}, {state}",
    "settings.legacyProviderEntry": "{name} ({id})",
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
