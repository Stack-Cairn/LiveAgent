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
    "gatewayWeb.connection.lost": "连接已断开，正在重新连接…",
    "gatewayWeb.connection.reconnected": "已重新连接",
    "gatewayWeb.connection.retryNow": "立即重试",
    "gatewayWeb.connection.reconnecting": "正在重新连接…",
    "gatewayWeb.connection.sendBlocked": "正在重新连接…草稿会保留，连接恢复后即可发送",
    "gatewayWeb.target.offlineWithAlternative": "{name} 已离线",
    "gatewayWeb.target.offline": "{name} 已离线。在那台电脑上打开 LiveAgent 后即可继续聊天。",
    "gatewayWeb.target.switchTo": "切换到 {name}",
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
    "gatewayWeb.connection.lost": "Connection lost. Reconnecting…",
    "gatewayWeb.connection.reconnected": "Reconnected",
    "gatewayWeb.connection.retryNow": "Retry now",
    "gatewayWeb.connection.reconnecting": "Reconnecting…",
    "gatewayWeb.connection.sendBlocked":
      "Reconnecting… Your draft is kept and can be sent once the connection is back",
    "gatewayWeb.target.offlineWithAlternative": "{name} is offline",
    "gatewayWeb.target.offline":
      "{name} is offline. Open LiveAgent on that computer to keep chatting.",
    "gatewayWeb.target.switchTo": "Switch to {name}",
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
