/** Git review diff view labels. */
export const DIFF_VIEW_TRANSLATIONS = {
  "zh-CN": {
    "diffView.copySelectedText": "复制选中文本",
    "diffView.horizontalScrollbar": "diff 横向滚动条",
  },
  "en-US": {
    "diffView.copySelectedText": "Copy selected text",
    "diffView.horizontalScrollbar": "Horizontal diff scrollbar",
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
