import { createKBrainClient } from "../kbrain/client";
import { getKBrainSessionId } from "../kbrain/mapping";
import { getConfiguredKBrainConnection } from "../kbrain/runtimeConnection";
import {
  applyChildEvent,
  CHILD_EVENT_PREFIX,
  childToolFromEvent,
  isTerminalSubagentStatus,
  mergeSubagent,
  subagentEventTaskId,
  subagentFromEvent,
} from "../kbrain/subagentEvents";
import type {
  KBrainEvent,
  KBrainMessage,
  KBrainSubagent,
  KBrainSubagentList,
  KBrainSubagentTranscript,
} from "../kbrain/types";
import {
  CLOSED_SUBAGENT_PANE,
  closeSubagentPane,
  closeSubagentTab,
  openSubagentTab,
  type SubagentPaneState,
  showSubagentDirectory,
} from "./kbrainPane";

/**
 * K-brain subagents per conversation, fed by the turn's event stream, the
 * /subagents list after a reload, and one follow stream per subagent that keeps
 * running after the turn that started it. Snapshots are immutable so React reads
 * them with useSyncExternalStore.
 */

export type SubagentTranscriptState = {
  messages: readonly KBrainMessage[];
  status: "loading" | "ready" | "error";
  error?: string;
};

export type SubagentEntry = {
  subagent: KBrainSubagent;
  /** The highest event seq applied to this subagent. */
  lastSeq: number;
  /** The child tool it started last, shown on the card while it runs. */
  latestTool?: { name: string; arguments: string };
  /** Child tool calls seen live, until the backend reports its own count. */
  liveToolCount: number;
  transcript?: SubagentTranscriptState;
};

export type ConversationSubagents = {
  conversationId: string;
  sessionId: string;
  entries: Readonly<Record<string, SubagentEntry>>;
  /** Ids in the order the subagents started. */
  order: readonly string[];
  pane: SubagentPaneState;
  /** The backend has no /subagents endpoints (older K-brain). */
  unsupported: boolean;
};

type SubagentClient = Pick<
  ReturnType<typeof createKBrainClient>,
  "listSubagents" | "getSubagentTranscript" | "cancelSubagent" | "subscribeSubagent"
>;

type Resources = {
  follows: Map<string, AbortController>;
  /** Child events that arrived while the transcript was loading. */
  pending: Map<string, KBrainEvent[]>;
  turnActive: boolean;
  listLoad?: Promise<void>;
};

let clientFactory: () => SubagentClient = () => createKBrainClient();
let sessionResolver: (conversationId: string) => string | undefined = (conversationId) =>
  getKBrainSessionId(conversationId, getConfiguredKBrainConnection()?.baseUrl);

const conversations = new Map<string, ConversationSubagents>();
const resources = new Map<string, Resources>();
const toolCallIndex = new Map<string, { conversationId: string; id: string }>();
const listeners = new Set<() => void>();
let version = 0;

const EMPTY: Readonly<Record<string, SubagentEntry>> = Object.freeze({});

/** Tests swap the backend client and the conversation-to-session mapping. */
export function configureKBrainSubagentStore(options: {
  client?: () => SubagentClient;
  resolveSession?: (conversationId: string) => string | undefined;
}) {
  if (options.client) clientFactory = options.client;
  if (options.resolveSession) sessionResolver = options.resolveSession;
}

export function resetKBrainSubagentStore() {
  for (const resource of resources.values()) {
    for (const controller of resource.follows.values()) controller.abort();
  }
  conversations.clear();
  resources.clear();
  toolCallIndex.clear();
  emit();
}

export function subscribeKBrainSubagents(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getKBrainSubagentsVersion() {
  return version;
}

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

function resourcesFor(conversationId: string): Resources {
  let resource = resources.get(conversationId);
  if (!resource) {
    resource = { follows: new Map(), pending: new Map(), turnActive: false };
    resources.set(conversationId, resource);
  }
  return resource;
}

function conversationFor(conversationId: string, sessionId?: string): ConversationSubagents {
  const existing = conversations.get(conversationId);
  if (existing) {
    // A new chat has no K-brain session until its first turn; look again until it does.
    const resolved = sessionId || (existing.sessionId ? "" : sessionResolver(conversationId));
    if (resolved && existing.sessionId !== resolved) {
      const next = { ...existing, sessionId: resolved };
      conversations.set(conversationId, next);
      return next;
    }
    return existing;
  }
  const created: ConversationSubagents = {
    conversationId,
    sessionId: sessionId ?? sessionResolver(conversationId) ?? "",
    entries: EMPTY,
    order: [],
    pane: CLOSED_SUBAGENT_PANE,
    unsupported: false,
  };
  conversations.set(conversationId, created);
  return created;
}

function update(
  conversationId: string,
  change: (state: ConversationSubagents) => ConversationSubagents,
  sessionId?: string,
) {
  const previous = conversationFor(conversationId, sessionId);
  const next = change(previous);
  if (next === previous) return;
  conversations.set(conversationId, next);
  emit();
}

function withEntry(
  state: ConversationSubagents,
  id: string,
  change: (entry: SubagentEntry | undefined) => SubagentEntry | undefined,
): ConversationSubagents {
  const previous = state.entries[id];
  const next = change(previous);
  if (!next || next === previous) return state;
  if (next.subagent.parent_tool_call_id) {
    toolCallIndex.set(next.subagent.parent_tool_call_id, {
      conversationId: state.conversationId,
      id,
    });
  }
  return {
    ...state,
    entries: { ...state.entries, [id]: next },
    order: previous ? state.order : [...state.order, id],
  };
}

function applyEvent(entry: SubagentEntry, event: KBrainEvent): SubagentEntry {
  const next: SubagentEntry = { ...entry, lastSeq: Math.max(entry.lastSeq, event.seq) };
  const subagent = subagentFromEvent(event);
  if (subagent) next.subagent = mergeSubagent(entry.subagent, subagent);
  const tool = childToolFromEvent(event);
  if (tool) {
    next.latestTool = { name: tool.name, arguments: tool.arguments };
    next.liveToolCount = entry.liveToolCount + 1;
  }
  if (entry.transcript?.status === "ready" && event.type.startsWith(CHILD_EVENT_PREFIX)) {
    next.transcript = {
      ...entry.transcript,
      messages: applyChildEvent(entry.transcript.messages, event, next.subagent.model),
    };
  }
  return next;
}

/**
 * Takes one `subagent.*` or `trajectory.child.*` event from any stream. Events at
 * or below a subagent's last applied seq are duplicates (the turn stream and a
 * follow stream can both deliver them) and are dropped.
 */
export function ingestKBrainSubagentEvent(
  conversationId: string,
  sessionId: string,
  event: KBrainEvent,
) {
  const id = subagentEventTaskId(event);
  if (!id) return;
  const resource = resourcesFor(conversationId);
  update(
    conversationId,
    (state) =>
      withEntry(state, id, (entry) => {
        if (entry && event.seq <= entry.lastSeq) return entry;
        if (!entry) {
          // Child output before its start event cannot be placed; the list or
          // transcript fetch fills it in.
          const subagent = subagentFromEvent(event);
          if (!subagent) return undefined;
          return applyEvent({ subagent, lastSeq: 0, liveToolCount: 0 }, event);
        }
        if (entry.transcript?.status === "loading" && event.type.startsWith(CHILD_EVENT_PREFIX)) {
          const pending = resource.pending.get(id) ?? [];
          pending.push(event);
          resource.pending.set(id, pending);
        }
        return applyEvent(entry, event);
      }),
    sessionId,
  );
  const entry = conversations.get(conversationId)?.entries[id];
  if (entry && isTerminalSubagentStatus(entry.subagent.status)) {
    resource.follows.get(id)?.abort();
    resource.follows.delete(id);
  } else if (entry && !resource.turnActive) {
    followSubagent(conversationId, id);
  }
}

/** The turn stream delivers subagent events while a turn runs. */
export function noteKBrainSubagentTurnStarted(conversationId: string) {
  resourcesFor(conversationId).turnActive = true;
}

/** Subagents still running once the turn ends are followed on their own streams. */
export function noteKBrainSubagentTurnEnded(conversationId: string) {
  const resource = resourcesFor(conversationId);
  resource.turnActive = false;
  const state = conversations.get(conversationId);
  if (!state) return;
  for (const id of state.order) {
    const entry = state.entries[id];
    if (entry && !isTerminalSubagentStatus(entry.subagent.status)) {
      followSubagent(conversationId, id);
    }
  }
}

function followSubagent(conversationId: string, id: string) {
  const resource = resourcesFor(conversationId);
  if (resource.follows.has(id)) return;
  const state = conversations.get(conversationId);
  const entry = state?.entries[id];
  if (!state?.sessionId || !entry || state.unsupported) return;
  const controller = new AbortController();
  resource.follows.set(id, controller);
  const sessionId = state.sessionId;
  void clientFactory()
    .subscribeSubagent(
      sessionId,
      id,
      entry.lastSeq,
      { onEvent: (event) => ingestKBrainSubagentEvent(conversationId, sessionId, event) },
      controller.signal,
    )
    .catch(() => undefined)
    .finally(() => {
      if (resource.follows.get(id) === controller) resource.follows.delete(id);
    });
}

function mergeListed(entry: SubagentEntry | undefined, listed: KBrainSubagent, listSeq: number) {
  if (!entry) return { subagent: listed, lastSeq: listSeq, liveToolCount: 0 };
  // A list taken before the latest event this client applied is older than it.
  if (listSeq < entry.lastSeq) return entry;
  return { ...entry, subagent: mergeSubagent(entry.subagent, listed), lastSeq: listSeq };
}

/**
 * Loads the conversation's subagents from the backend (after a reload, or when
 * the directory opens) and follows those still running.
 */
export function loadKBrainSubagents(conversationId: string): Promise<void> {
  const resource = resourcesFor(conversationId);
  if (resource.listLoad) return resource.listLoad;
  const state = conversationFor(conversationId);
  if (!state.sessionId || state.unsupported) return Promise.resolve();
  const sessionId = state.sessionId;
  const load = clientFactory()
    .listSubagents(sessionId)
    .then((list: KBrainSubagentList) => {
      const listSeq = list.last_seq ?? 0;
      update(conversationId, (current) => {
        let next = current;
        for (const subagent of list.subagents ?? []) {
          if (!subagent?.id) continue;
          next = withEntry(next, subagent.id, (entry) => mergeListed(entry, subagent, listSeq));
        }
        return next;
      });
      if (!resource.turnActive) noteKBrainSubagentTurnEnded(conversationId);
    })
    .catch((error: unknown) => {
      if (isMissingRoute(error)) {
        update(conversationId, (current) => ({ ...current, unsupported: true }));
      }
    })
    .finally(() => {
      resource.listLoad = undefined;
    });
  resource.listLoad = load;
  return load;
}

function isMissingRoute(error: unknown) {
  const status = (error as { status?: unknown })?.status;
  return status === 404 || status === 405;
}

/** Loads a subagent's transcript so far; later child events extend it. */
export function loadKBrainSubagentTranscript(conversationId: string, id: string): Promise<void> {
  const state = conversations.get(conversationId);
  const entry = state?.entries[id];
  if (!state?.sessionId || !entry) return Promise.resolve();
  if (entry.transcript && entry.transcript.status !== "error") return Promise.resolve();
  const resource = resourcesFor(conversationId);
  resource.pending.set(id, []);
  update(conversationId, (current) =>
    withEntry(current, id, (value) =>
      value ? { ...value, transcript: { messages: [], status: "loading" } } : value,
    ),
  );
  return clientFactory()
    .getSubagentTranscript(state.sessionId, id)
    .then((loaded: KBrainSubagentTranscript) => {
      const baseSeq = loaded.last_seq ?? 0;
      const pending = resource.pending.get(id) ?? [];
      resource.pending.delete(id);
      update(conversationId, (current) =>
        withEntry(current, id, (value) => {
          if (!value) return value;
          let messages: readonly KBrainMessage[] = loaded.messages ?? [];
          const subagent = mergeSubagent(value.subagent, loaded.subagent);
          for (const event of pending) {
            if (event.seq > baseSeq) messages = applyChildEvent(messages, event, subagent.model);
          }
          return {
            ...value,
            subagent: baseSeq >= value.lastSeq ? subagent : value.subagent,
            lastSeq: Math.max(value.lastSeq, baseSeq),
            transcript: { messages, status: "ready" },
          };
        }),
      );
      const current = conversations.get(conversationId)?.entries[id];
      if (loaded.live && current && !isTerminalSubagentStatus(current.subagent.status)) {
        if (!resource.turnActive) followSubagent(conversationId, id);
      }
    })
    .catch((error: unknown) => {
      resource.pending.delete(id);
      update(conversationId, (current) =>
        withEntry(current, id, (value) =>
          value
            ? {
                ...value,
                transcript: {
                  messages: [],
                  status: "error",
                  error: error instanceof Error ? error.message : String(error),
                },
              }
            : value,
        ),
      );
    });
}

export function stopKBrainSubagent(conversationId: string, id: string): Promise<void> {
  const state = conversations.get(conversationId);
  if (!state?.sessionId) return Promise.resolve();
  return clientFactory().cancelSubagent(state.sessionId, id);
}

export function openKBrainSubagent(conversationId: string, id: string) {
  update(conversationId, (state) => ({ ...state, pane: openSubagentTab(state.pane, id) }));
  void loadKBrainSubagentTranscript(conversationId, id);
}

export function closeKBrainSubagentTab(conversationId: string, id: string) {
  update(conversationId, (state) => ({ ...state, pane: closeSubagentTab(state.pane, id) }));
}

export function showKBrainSubagentDirectory(conversationId: string) {
  update(conversationId, (state) => ({ ...state, pane: showSubagentDirectory(state.pane) }));
  void loadKBrainSubagents(conversationId);
}

export function closeKBrainSubagentPane(conversationId: string) {
  update(conversationId, (state) => ({ ...state, pane: closeSubagentPane(state.pane) }));
}

export function getKBrainConversationSubagents(
  conversationId: string,
): ConversationSubagents | undefined {
  return conversations.get(conversationId);
}

/** The subagent the parent's `subagent` tool call started, when the backend linked them. */
export function getKBrainSubagentForToolCall(
  toolCallId: string,
): { conversationId: string; entry: SubagentEntry } | undefined {
  const link = toolCallIndex.get(toolCallId);
  if (!link) return undefined;
  const entry = conversations.get(link.conversationId)?.entries[link.id];
  return entry ? { conversationId: link.conversationId, entry } : undefined;
}

export function countRunningKBrainSubagents(state: ConversationSubagents | undefined) {
  if (!state) return 0;
  let running = 0;
  for (const id of state.order) {
    const entry = state.entries[id];
    if (entry && !isTerminalSubagentStatus(entry.subagent.status)) running += 1;
  }
  return running;
}

/** Forgets a conversation (deleted chat); its follow streams stop. */
export function forgetKBrainSubagents(conversationId: string) {
  const resource = resources.get(conversationId);
  for (const controller of resource?.follows.values() ?? []) controller.abort();
  resources.delete(conversationId);
  for (const [toolCallId, link] of toolCallIndex) {
    if (link.conversationId === conversationId) toolCallIndex.delete(toolCallId);
  }
  if (conversations.delete(conversationId)) emit();
}
