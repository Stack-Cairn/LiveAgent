/**
 * Messages for first-run onboarding and the diagnostics export.
 */
export const ONBOARDING_DIAGNOSTICS_TRANSLATIONS = {
  "zh-CN": {
    "onboarding.later": "稍后设置",
    "onboarding.model.testOk": "连接成功：服务返回 {count} 个模型。",
    "onboarding.workspace.trustUnavailable": "当前后端不支持文件夹信任。",
    "onboarding.reopen": "入门引导",
    "onboarding.reopenDesc": "重新打开首次使用引导：语言、模型服务、工作区和安全模式。",
    "diagnostics.export": "导出诊断信息",
    "diagnostics.exportDesc": "生成用于反馈问题的 zip 包，保存前可预览内容，敏感信息会被移除。",
    "settings.aboutHelp": "帮助与反馈",
  },
  "en-US": {
    "onboarding.later": "Set up later",
    "onboarding.model.testOk": "Connected: the service returned {count} models.",
    "onboarding.workspace.trustUnavailable": "This backend does not support folder trust.",
    "onboarding.reopen": "Getting started",
    "onboarding.reopenDesc":
      "Reopen the first-run guide: language, model provider, workspace and safety mode.",
    "diagnostics.export": "Export diagnostics",
    "diagnostics.exportDesc":
      "Builds a zip for bug reports. Preview the contents before saving; sensitive data is removed.",
    "settings.aboutHelp": "Help and feedback",
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
