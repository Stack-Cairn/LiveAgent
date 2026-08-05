// Desktop-only hook execution service. One module-level chain serializes all
// hook executions app-wide (preserving cross-run ordering), while each
// conversation run owns a cancellable scope: aborting the run drops its
// queued hooks and kills its in-flight script via the Rust scope registry.

import { invoke } from "@tauri-apps/api/core";

import { createUuid } from "../shared/id";
import type { HookDef, HookEvent, HookType } from "./types";

export type HookRunWarning = {
  hookName: string;
  hookType: HookType;
  event: HookEvent;
  message: string;
};

export type HookRunScope = {
  dispatch: (event: HookEvent) => void;
  /** Stop accepting new events; already-queued hooks drain in the background. */
  close: () => void;
  /** Drop queued hooks and cancel the in-flight execution (conversation abort). */
  cancel: () => void;
};

type HookHttpRunResponse = {
  ok: boolean;
  results: Array<{
    id: string;
    ok: boolean;
    status?: number;
    durationMs: number;
    error?: string;
  }>;
};

/** Per-scope cap on queued dispatch batches; overflow drops with one warning. */
const MAX_QUEUED_DISPATCHES = 16;

let executionChain: Promise<void> = Promise.resolve();

function asErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const text = String(error ?? "").trim();
  return text || fallback;
}

async function runHook(
  hook: HookDef,
  event: HookEvent,
  scopeId: string,
  conversationId: string,
  workdir?: string,
) {
  if (hook.type === "command") {
    const script = hook.script?.trim() ?? "";
    if (!script) return;
    await invoke("hook_run_script", {
      workdir: workdir?.trim() || null,
      script,
      timeout_ms: hook.timeoutMs ?? null,
      scope_id: scopeId,
      context: {
        LIVEAGENT_HOOK_EVENT: event,
        LIVEAGENT_HOOK_NAME: hook.name,
        LIVEAGENT_CONVERSATION_ID: conversationId,
        LIVEAGENT_WORKDIR: workdir?.trim() ?? "",
      },
    });
    return;
  }

  const requests = hook.requests ?? [];
  if (requests.length === 0) return;
  const response = await invoke<HookHttpRunResponse>("hook_run_http_requests", {
    requests,
    scope_id: scopeId,
  });
  if (!response.ok) {
    const failures = response.results
      .filter((result) => !result.ok)
      .map((result) => result.error ?? `request ${result.id} failed`)
      .join("; ");
    throw new Error(failures || "Hook HTTP request failed");
  }
}

export function createHookRunScope(params: {
  hooks: HookDef[];
  conversationId: string;
  workdir?: string;
  onWarning?: (warning: HookRunWarning) => void;
}): HookRunScope {
  const scopeId = createUuid();
  const hooksByEvent = new Map<HookEvent, HookDef[]>();
  for (const hook of params.hooks) {
    if (!hook.enabled) continue;
    const list = hooksByEvent.get(hook.event) ?? [];
    list.push(hook);
    hooksByEvent.set(hook.event, list);
  }

  let accepting = true;
  let cancelled = false;
  let queuedDispatches = 0;
  let overflowWarned = false;

  const dispatch = (event: HookEvent) => {
    if (!accepting) return;
    const hooks = hooksByEvent.get(event);
    if (!hooks || hooks.length === 0) return;

    if (queuedDispatches >= MAX_QUEUED_DISPATCHES) {
      if (!overflowWarned) {
        overflowWarned = true;
        params.onWarning?.({
          hookName: hooks[0].name,
          hookType: hooks[0].type,
          event,
          message: `Hook queue overflow: more than ${MAX_QUEUED_DISPATCHES} pending dispatches; dropping further events for this run.`,
        });
      }
      return;
    }

    queuedDispatches += 1;
    executionChain = executionChain
      .then(async () => {
        queuedDispatches -= 1;
        if (cancelled) return;
        for (const hook of hooks) {
          if (cancelled) return;
          try {
            await runHook(hook, event, scopeId, params.conversationId, params.workdir);
          } catch (error) {
            params.onWarning?.({
              hookName: hook.name,
              hookType: hook.type,
              event,
              message: asErrorMessage(error, "Hook 执行失败"),
            });
          }
        }
      })
      .catch(() => undefined);
  };

  return {
    dispatch,
    close: () => {
      accepting = false;
    },
    cancel: () => {
      if (cancelled) return;
      accepting = false;
      cancelled = true;
      void invoke("hook_cancel_scope", { scope_id: scopeId }).catch(() => undefined);
    },
  };
}
