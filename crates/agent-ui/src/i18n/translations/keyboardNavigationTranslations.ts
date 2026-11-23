/** Core keyboard-navigation copy: skip links and roving-focus hints shown on every page. */
export const KEYBOARD_NAVIGATION_TRANSLATIONS = {
  "zh-CN": {
    "a11y.skipToComposer": "跳到输入框",
    "sidebar.rowKeyboardHint": "上下方向键切换会话，右方向键进入行内操作，Shift+F10 打开菜单",
  },
  "en-US": {
    "a11y.skipToComposer": "Skip to message composer",
    "sidebar.rowKeyboardHint":
      "Use the arrow keys to move between conversations, Right arrow for row actions, Shift+F10 for the menu",
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
