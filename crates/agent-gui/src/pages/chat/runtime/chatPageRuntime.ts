import type { AssistantMessage } from "@earendil-works/pi-ai";
import { HOOK_EVENT_TRANSLATION_KEYS } from "@liveagent/ui/lib/automation/index";
import type { HookRunWarning } from "../../../lib/automation/hookRunner";
import type { CompactionStatus } from "../../../lib/chat/compaction/types";
import type { ConversationViewState } from "../../../lib/chat/conversation/conversationState";
import type { ConversationPersistenceCursor } from "../../../lib/chat/history/chatHistory";
import { normalizeErrorMessage } from "../../../lib/providers/llm";
import type { AppSettings, SelectedModel } from "../../../lib/settings";

export const MAX_IDLE_CONVERSATION_RUNTIME_CACHE_ENTRIES = 12;

export type ConversationRuntimeEntry = {
  state: ConversationViewState;
  compactionStatus: CompactionStatus;
  isSending: boolean;
  errorMessage: string | null;
  hookWarning: string | null;
  sessionId: string;
  createdAt: number;
  workdir?: string;
  selectedModel?: SelectedModel;
};

export function resolveEffectiveConversationWorkdir(params: {
  isAgentMode: boolean;
  workdirOverride?: string;
  gatewayWorkdirOverride?: string;
  persistedWorkdir?: string;
  runtimeWorkdir?: string;
  globalWorkdir: string;
}) {
  const explicitWorkdir = params.workdirOverride ?? params.gatewayWorkdirOverride;
  if (explicitWorkdir !== undefined) {
    return explicitWorkdir.trim();
  }
  if (!params.isAgentMode) {
    return "";
  }
  return (
    params.persistedWorkdir?.trim() || params.runtimeWorkdir?.trim() || params.globalWorkdir.trim()
  );
}

export function syncMovedConversationRuntimeWorkdir(params: {
  conversationId: string;
  cwd: string;
  runtimeCache: ReadonlyMap<string, ConversationRuntimeEntry>;
  isConversationRunning: (conversationId: string) => boolean;
  updateConversationRuntimeEntry: (
    conversationId: string,
    updater: (prev: ConversationRuntimeEntry) => ConversationRuntimeEntry,
  ) => unknown;
}) {
  const conversationId = params.conversationId.trim();
  const cwd = params.cwd.trim();
  const runtimeEntry = params.runtimeCache.get(conversationId);
  if (
    !conversationId ||
    !cwd ||
    !runtimeEntry ||
    runtimeEntry.isSending ||
    params.isConversationRunning(conversationId)
  ) {
    return false;
  }
  params.updateConversationRuntimeEntry(conversationId, (prev) => ({
    ...prev,
    workdir: cwd,
  }));
  return true;
}

export function createConversationRuntimeEntry(params: {
  state: ConversationViewState;
  sessionId: string;
  createdAt: number;
  compactionStatus?: CompactionStatus;
  isSending?: boolean;
  errorMessage?: string | null;
  hookWarning?: string | null;
  workdir?: string;
  selectedModel?: SelectedModel;
}): ConversationRuntimeEntry {
  const {
    state,
    sessionId,
    createdAt,
    compactionStatus = { phase: "idle" },
    isSending = false,
    errorMessage = null,
    hookWarning = null,
    workdir,
    selectedModel,
  } = params;
  return {
    state,
    compactionStatus,
    isSending,
    errorMessage,
    hookWarning,
    sessionId,
    createdAt,
    workdir: workdir?.trim() || undefined,
    selectedModel,
  };
}

function createEmptyAssistantUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export function setConversationRuntimeCacheEntry(
  cache: Map<string, ConversationRuntimeEntry>,
  conversationId: string,
  entry: ConversationRuntimeEntry,
) {
  const key = conversationId.trim();
  if (!key) return;
  const observableCache = cache as Map<string, ConversationRuntimeEntry> & {
    setRuntimeEntry?: (conversationId: string, entry: ConversationRuntimeEntry) => void;
  };
  if (observableCache.setRuntimeEntry) {
    observableCache.setRuntimeEntry(key, entry);
    return;
  }
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, entry);
}

export function pruneIdleConversationRuntimeCaches(params: {
  runtimeCache: Map<string, ConversationRuntimeEntry>;
  persistenceCursors: Map<string, ConversationPersistenceCursor>;
  keepConversationIds?: Iterable<string | undefined | null>;
  maxIdleEntries?: number;
  isConversationRunning?: (conversationId: string) => boolean;
  onPruneConversation?: (conversationId: string) => void;
}) {
  const {
    runtimeCache,
    persistenceCursors,
    keepConversationIds = [],
    maxIdleEntries = MAX_IDLE_CONVERSATION_RUNTIME_CACHE_ENTRIES,
    isConversationRunning,
    onPruneConversation,
  } = params;
  const keepIds = new Set<string>();
  for (const rawId of keepConversationIds) {
    const id = rawId?.trim();
    if (id) keepIds.add(id);
  }
  const idleLimit = Math.max(0, Math.floor(maxIdleEntries));
  const prunedIds: string[] = [];

  const isProtected = (conversationId: string, entry?: ConversationRuntimeEntry) =>
    keepIds.has(conversationId) ||
    Boolean(entry?.isSending) ||
    Boolean(isConversationRunning?.(conversationId));

  const idleRuntimeIds: string[] = [];
  for (const [conversationId, entry] of runtimeCache.entries()) {
    const key = conversationId.trim();
    if (!key) continue;
    if (isProtected(key, entry)) continue;
    idleRuntimeIds.push(key);
  }

  const runtimePruneCount = Math.max(0, idleRuntimeIds.length - idleLimit);
  for (const conversationId of idleRuntimeIds.slice(0, runtimePruneCount)) {
    runtimeCache.delete(conversationId);
    persistenceCursors.delete(conversationId);
    onPruneConversation?.(conversationId);
    prunedIds.push(conversationId);
  }

  for (const conversationId of Array.from(persistenceCursors.keys())) {
    const key = conversationId.trim();
    if (!key || runtimeCache.has(key) || isProtected(key)) continue;
    persistenceCursors.delete(key);
    onPruneConversation?.(key);
    prunedIds.push(key);
  }

  return prunedIds;
}

export function buildErrorAssistantMessage(params: {
  model: {
    api: AssistantMessage["api"];
    provider: AssistantMessage["provider"];
    id: string;
  };
  errorMessage: string;
  timestamp?: number;
}): AssistantMessage {
  const errorMessage = normalizeErrorMessage(params.errorMessage, "Request failed");
  const displayText =
    errorMessage === "Request failed" ||
    errorMessage.startsWith("Request failed:") ||
    errorMessage.startsWith("Request failed：")
      ? errorMessage
      : `Request failed: ${errorMessage}`;
  return {
    role: "assistant",
    content: [{ type: "text", text: displayText }],
    api: params.model.api,
    provider: params.model.provider,
    model: params.model.id,
    usage: createEmptyAssistantUsage(),
    stopReason: "error",
    errorMessage,
    timestamp: params.timestamp ?? Date.now(),
  };
}

export function buildPartialAssistantMessage(params: {
  model: {
    api: AssistantMessage["api"];
    provider: AssistantMessage["provider"];
    id: string;
  };
  text: string;
  timestamp?: number;
  stopReason?: AssistantMessage["stopReason"];
}): AssistantMessage | null {
  const content = params.text.trim();
  if (!content) return null;
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: params.model.api,
    provider: params.model.provider,
    model: params.model.id,
    usage: createEmptyAssistantUsage(),
    stopReason: params.stopReason ?? "aborted",
    timestamp: params.timestamp ?? Date.now(),
  };
}

export function appendSystemPrompt(base: string | undefined, suffix: string) {
  const head = (base || "").trim();
  const tail = (suffix || "").trim();
  if (!tail) return head;
  if (!head) return tail;
  return `${head}\n\n${tail}`;
}

export function formatHookWarningMessage(
  locale: AppSettings["locale"],
  t: (key: string) => string,
  warning: HookRunWarning,
) {
  const eventLabel = t(HOOK_EVENT_TRANSLATION_KEYS[warning.event]);
  return locale === "en-US"
    ? `Hook "${warning.hookName}" failed during ${eventLabel}: ${warning.message}`
    : `Hook「${warning.hookName}」在 ${eventLabel} 执行失败：${warning.message}`;
}
