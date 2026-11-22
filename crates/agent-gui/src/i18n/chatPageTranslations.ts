/** Desktop chat page status messages. */
export const CHAT_PAGE_TRANSLATIONS = {
  "zh-CN": {
    "chat.hydrating": "正在加载会话，请稍候...",
    "chat.hydrationFailed": "当前会话加载失败，请重新打开会话...",
    "chat.checkpointRewindUnsupported":
      "K-brain 模式尚不支持文件检查点回退；文件修改由后端工具执行。",
  },
  "en-US": {
    "chat.hydrating": "Loading the conversation, please wait...",
    "chat.hydrationFailed": "This conversation failed to load. Please reopen it...",
    "chat.checkpointRewindUnsupported":
      "File checkpoint rewind is not supported in K-brain mode; file changes are executed by backend tools.",
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
