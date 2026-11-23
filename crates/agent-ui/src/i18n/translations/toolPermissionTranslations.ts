/** Tool calls the user or a policy refused, as the transcript reports them. */
export const TOOL_PERMISSION_TRANSLATIONS = {
  "zh-CN": {
    "chat.tool.denied": "已拒绝",
  },
  "en-US": {
    "chat.tool.denied": "Denied",
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
