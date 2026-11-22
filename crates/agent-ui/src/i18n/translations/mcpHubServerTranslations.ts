/** MCP hub: server display names and the per-server tool badges. */
export const MCP_HUB_SERVER_TRANSLATIONS = {
  "zh-CN": {
    "mcpHub.serverDisplayName": "显示名称",
    "mcpHub.serverDisplayNamePlaceholder": "可选",
    "mcpHub.serverDisplayNameHint": "仅用于显示，不影响工具名和权限规则",
    "mcpHub.uiBadge": "界面",
    "mcpHub.uiToolsTitle": "{count} 个工具带有 MCP 应用界面",
    "mcpHub.appOnlyTools": "{count} 个仅限界面",
    "mcpHub.appOnlyToolsTitle": "这些工具只能由 MCP 应用界面调用，助手看不到它们",
  },
  "en-US": {
    "mcpHub.serverDisplayName": "Display Name",
    "mcpHub.serverDisplayNamePlaceholder": "Optional",
    "mcpHub.serverDisplayNameHint":
      "Only for display; tool names and permission rules are unchanged",
    "mcpHub.uiBadge": "UI",
    "mcpHub.uiToolsTitle": "{count} tools have an MCP App view",
    "mcpHub.appOnlyTools": "{count} view-only",
    "mcpHub.appOnlyToolsTitle":
      "Only MCP App views can call these tools; the assistant does not see them",
  },
} as const;
