/** Long tool output in the transcript: the truncation note and its actions. */
export const TOOL_OUTPUT_TRANSLATIONS = {
  "zh-CN": {
    "chat.tool.output.truncated": "…仅显示前 {shown} 个字符，共 {total} 个",
  },
  "en-US": {
    "chat.tool.output.truncated": "… Showing the first {shown} of {total} characters",
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
