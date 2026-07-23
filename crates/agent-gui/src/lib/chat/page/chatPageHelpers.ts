import type { Context } from "@earendil-works/pi-ai";
import { type ModelOption, toModelValue } from "../../providers/llm";
import type { AppSettings } from "../../settings";
import { createUuid } from "../../shared/id";
import type { ChatHistorySummary } from "../history/chatHistory";
import { getMessageText } from "../messages/uiMessages";

const FALLBACK_TITLE_MAX_CHARS = 48;
const TITLE_LOOKAHEAD_TIMEOUT_MS = 1_200;
const MODEL_GENERATING_STATUS_PATTERN = /^第\s*\d+\s*轮：模型生成中\.\.\.$/;

export const VIBING_STATUS = "Vibing...";

// Must match BRANCH_DEFAULT_TITLE in src-tauri/src/commands/history/chat_history/branch.rs.
export const BRANCH_CONVERSATION_DEFAULT_TITLE = "新分支";

export type ModelOptionGroup = {
  id: string;
  name: string;
  providerType: ModelOption["providerType"];
  opts: ModelOption[];
};

export function groupModelOptionsByProvider(modelOptions: readonly ModelOption[]) {
  const groups: ModelOptionGroup[] = [];
  const groupMap = new Map<string, ModelOptionGroup>();
  for (const option of modelOptions) {
    const existing = groupMap.get(option.providerId);
    if (existing) {
      existing.opts.push(option);
      continue;
    }
    const group: ModelOptionGroup = {
      id: option.providerId,
      name: option.providerName,
      providerType: option.providerType,
      opts: [option],
    };
    groupMap.set(option.providerId, group);
    groups.push(group);
  }
  return groups;
}

// 模型下拉里供应商分组的排列方式：type=按供应商类型聚簇，alpha=按供应商名称首字母排序
export type ProviderSortMode = "type" | "alpha";

const PROVIDER_SORT_MODE_STORAGE_KEY = "chatModelPickerProviderSort";

export function readStoredProviderSortMode(): ProviderSortMode {
  try {
    return localStorage.getItem(PROVIDER_SORT_MODE_STORAGE_KEY) === "alpha" ? "alpha" : "type";
  } catch {
    return "type";
  }
}

export function persistProviderSortMode(mode: ProviderSortMode): void {
  try {
    localStorage.setItem(PROVIDER_SORT_MODE_STORAGE_KEY, mode);
  } catch {
    // localStorage 不可用时仅保留会话内状态
  }
}

export function sortModelOptionGroups(
  groups: readonly ModelOptionGroup[],
  mode: ProviderSortMode,
): ModelOptionGroup[] {
  if (mode === "alpha") {
    return [...groups].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
    );
  }
  // 类型顺序取首次出现位置，同类型内保持设置页里的原有顺序（sort 稳定）
  const typeOrder = new Map<string, number>();
  for (const group of groups) {
    if (!typeOrder.has(group.providerType)) typeOrder.set(group.providerType, typeOrder.size);
  }
  return [...groups].sort(
    (a, b) => (typeOrder.get(a.providerType) ?? 0) - (typeOrder.get(b.providerType) ?? 0),
  );
}

export function buildModelOptions(
  settings: AppSettings,
  opts?: { floatSelectedFirst?: boolean },
): ModelOption[] {
  const options: ModelOption[] = [];
  for (const provider of settings.customProviders) {
    for (const model of provider.activeModels) {
      options.push({
        providerType: provider.type,
        providerId: provider.id,
        providerName: provider.name,
        model,
        value: toModelValue(provider.id, model),
        label: model,
      });
    }
  }
  if (!settings.selectedModel || opts?.floatSelectedFirst === false) return options;

  const selectedValue = toModelValue(
    settings.selectedModel.customProviderId,
    settings.selectedModel.model,
  );
  const selectedIndex = options.findIndex((option) => option.value === selectedValue);
  if (selectedIndex <= 0) return options;

  const [selectedOption] = options.splice(selectedIndex, 1);
  options.unshift(selectedOption);
  return options;
}

export function buildConversationTitlePrompt(content: string) {
  return `Based on the following content, generate a title within 10 words for this conversation and output it directly without any other content:${content}`;
}

export function normalizeConversationTitle(raw: string) {
  const singleLine = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[`"'""‘’]+|[`"'""‘’]+$/g, "")
    .trim();

  if (!singleLine) return "";

  const words = singleLine.split(" ").filter(Boolean);
  const limitedWords = words.length > 10 ? words.slice(0, 10).join(" ") : singleLine;
  return limitedWords.slice(0, 80).trim();
}

export function buildFallbackConversationTitle(content: string) {
  const singleLine = content.replace(/\s+/g, " ").trim();
  if (!singleLine) return "新对话";
  if (singleLine.length <= FALLBACK_TITLE_MAX_CHARS) return singleLine;
  return `${singleLine.slice(0, FALLBACK_TITLE_MAX_CHARS).trimEnd()}...`;
}

export function normalizeLiveToolStatus(status: string | null) {
  if (status && MODEL_GENERATING_STATUS_PATTERN.test(status)) return VIBING_STATUS;
  return status;
}

export function getFirstUserMessageText(context: Context) {
  for (const message of context.messages) {
    if (message.role !== "user") continue;
    const text = getMessageText(message).trim();
    if (text) return text;
  }
  return "";
}

export function waitForTitleLookahead<T>(promise: Promise<T>) {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      window.setTimeout(() => resolve(null), TITLE_LOOKAHEAD_TIMEOUT_MS);
    }),
  ]);
}

export function isAbortLikeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("已取消") || normalized.includes("abort") || normalized.includes("aborted")
  );
}

export function createPendingHistoryItem(params: {
  conversationId: string;
  // The localized pending title (t("chat.pendingTitle")) — callers own i18n.
  title: string;
  providerId: string;
  model: string;
  sessionId?: string;
  cwd?: string;
  createdAt: number;
  updatedAt?: number;
}) {
  const {
    conversationId,
    title,
    providerId,
    model,
    sessionId,
    cwd,
    createdAt,
    updatedAt = Date.now(),
  } = params;
  return {
    id: conversationId,
    title,
    providerId,
    model,
    sessionId,
    cwd,
    createdAt,
    updatedAt,
    isPending: true,
  } satisfies ChatHistorySummary;
}

export function createConversationIdentity() {
  const conversationId = createUuid();
  return {
    conversationId,
    sessionId: conversationId,
    createdAt: Date.now(),
  };
}
