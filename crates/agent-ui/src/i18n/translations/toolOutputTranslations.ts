/** Long tool output in the transcript: the truncation note and its actions. */
export const TOOL_OUTPUT_TRANSLATIONS = {
  "zh-CN": {
    "chat.tool.output.truncated": "…仅显示前 {shown} 个字符，共 {total} 个",
    "chat.tool.output.copy": "复制输出",
    "chat.tool.output.copied": "已复制",
    "chat.tool.output.showAll": "显示全部输出",
    "chat.tool.output.showLess": "收起输出",
  },
  "en-US": {
    "chat.tool.output.truncated": "… Showing the first {shown} of {total} characters",
    "chat.tool.output.copy": "Copy output",
    "chat.tool.output.copied": "Copied",
    "chat.tool.output.showAll": "Show all output",
    "chat.tool.output.showLess": "Show less",
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
