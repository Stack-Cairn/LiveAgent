/** WebUI-only shell messages: connection errors, admin page links and the browser path prompt. */
export const GATEWAY_WEB_TRANSLATIONS = {
  "zh-CN": {
    "gatewayWeb.gatewayNotConnected": "Gateway 尚未连接。",
    "gatewayWeb.noAgent": "没有可用的 Agent。",
    "gatewayWeb.sttSyncNeedsAgent": "桌面 Agent 未连接，无法同步 STT 配置",
    "gatewayWeb.backToChat": "返回聊天",
    "gatewayWeb.pathPrompt.cancel": "取消",
    "gatewayWeb.pathPrompt.confirm": "确认",
    "gatewayWeb.pathPrompt.workdirTitle": "选择工作目录",
    "gatewayWeb.pathPrompt.workdirDescription":
      "浏览器无法直接打开远程目录选择器。请输入桌面端 Agent 可访问的绝对工作目录路径。",
    "gatewayWeb.pathPrompt.workdirLabel": "工作目录路径",
    "gatewayWeb.pathPrompt.fileTitle": "选择配置文件",
    "gatewayWeb.pathPrompt.fileDescription":
      "浏览器无法直接打开远程文件选择器。请输入桌面端 Agent 可访问的配置文件绝对路径。",
    "gatewayWeb.pathPrompt.fileLabel": "配置文件路径",
  },
  "en-US": {
    "gatewayWeb.gatewayNotConnected": "The Gateway is not connected yet.",
    "gatewayWeb.noAgent": "No Agent is available.",
    "gatewayWeb.sttSyncNeedsAgent":
      "The desktop Agent is not connected, so the STT configuration cannot be synced",
    "gatewayWeb.backToChat": "Back to chat",
    "gatewayWeb.pathPrompt.cancel": "Cancel",
    "gatewayWeb.pathPrompt.confirm": "Confirm",
    "gatewayWeb.pathPrompt.workdirTitle": "Choose working directory",
    "gatewayWeb.pathPrompt.workdirDescription":
      "The browser cannot open a folder picker on the remote desktop. Enter an absolute working directory path the desktop Agent can access.",
    "gatewayWeb.pathPrompt.workdirLabel": "Working directory path",
    "gatewayWeb.pathPrompt.fileTitle": "Choose configuration file",
    "gatewayWeb.pathPrompt.fileDescription":
      "The browser cannot open a file picker on the remote desktop. Enter an absolute configuration file path the desktop Agent can access.",
    "gatewayWeb.pathPrompt.fileLabel": "Configuration file path",
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
