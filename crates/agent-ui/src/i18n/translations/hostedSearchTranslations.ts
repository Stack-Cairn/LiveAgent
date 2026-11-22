/** Provider-hosted web search activity shown in the assistant transcript. */
export const HOSTED_SEARCH_TRANSLATIONS = {
  "zh-CN": {
    "chat.hostedSearch.searching": "正在联网搜索",
    "chat.hostedSearch.failed": "联网搜索失败",
    "chat.hostedSearch.activity": "联网搜索过程",
    "chat.hostedSearch.completed": "联网搜索完成",
    "chat.hostedSearch.completedWithSources": "联网搜索完成 · {count} 个来源",
    "chat.hostedSearch.searched.one": "已搜索 {count} 次",
    "chat.hostedSearch.searched.other": "已搜索 {count} 次",
    "chat.hostedSearch.sourcesSuffix": " · {count} 个来源",
    "chat.hostedSearch.failedCount.one": "{count} 次搜索失败",
    "chat.hostedSearch.failedCount.other": "{count} 次搜索失败",
    "chat.hostedSearch.showMore": "查看其余 {count} 个来源",
  },
  "en-US": {
    "chat.hostedSearch.searching": "Searching the web",
    "chat.hostedSearch.failed": "Web search failed",
    "chat.hostedSearch.activity": "Web search activity",
    "chat.hostedSearch.completed": "Search complete",
    "chat.hostedSearch.completedWithSources": "Search complete · {count} sources",
    "chat.hostedSearch.searched.one": "Searched {count} time",
    "chat.hostedSearch.searched.other": "Searched {count} times",
    "chat.hostedSearch.sourcesSuffix": " · {count} sources",
    "chat.hostedSearch.failedCount.one": "{count} search failed",
    "chat.hostedSearch.failedCount.other": "{count} searches failed",
    "chat.hostedSearch.showMore": "Show {count} more sources",
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
