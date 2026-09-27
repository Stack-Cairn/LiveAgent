import { backend } from "@liveagent/app/lib/planning/backend";
import { useSyncExternalStore } from "react";
import { localizePlanningError, translate } from "./i18n";
import type {
  PlanningBackend,
  PlanningMutation,
  PlanningMutationResult,
  PlanningQuery,
  PlanningSnapshot,
} from "./types";

export interface PlanningState {
  scope: string;
  snapshot: PlanningSnapshot | null;
  loading: boolean;
  error: string | null;
}
export class PlanningConflictError extends Error {
  constructor(public current: unknown) {
    super(translate("planner.conflict"));
  }
}
export function createPlanningStore(transport: PlanningBackend) {
  let state: PlanningState = {
    scope: transport.scope(),
    snapshot: null,
    loading: false,
    error: null,
  };
  let epoch = 0;
  let query: PlanningQuery = {};
  let listeners = new Set<() => void>();
  let unsubscribe: (() => void) | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const emit = (patch: Partial<PlanningState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const refresh = async (nextQuery = query) => {
    query = nextQuery;
    const requestEpoch = ++epoch;
    const scope = transport.scope();
    emit({
      scope,
      loading: true,
      error: null,
      ...(scope !== state.scope ? { snapshot: null } : {}),
    });
    try {
      const snapshot = await transport.call<PlanningSnapshot>("query", nextQuery);
      if (requestEpoch !== epoch || scope !== transport.scope()) return;
      if (state.snapshot && snapshot.seq < state.snapshot.seq) {
        emit({ loading: false });
        return;
      }
      emit({ snapshot, loading: false });
    } catch (error) {
      if (requestEpoch === epoch && scope === transport.scope())
        emit({ loading: false, error: localizePlanningError(error) });
    }
  };
  const invalidate = (seq?: number) => {
    if (
      transport.scope() === state.scope &&
      seq !== undefined &&
      seq <= (state.snapshot?.seq ?? -1)
    )
      return;
    if (transport.scope() !== state.scope) {
      ++epoch;
      emit({ scope: transport.scope(), snapshot: null, error: null });
    }
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, 50);
  };
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!unsubscribe) {
        unsubscribe = transport.subscribe(invalidate);
        void refresh();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          unsubscribe?.();
          unsubscribe = null;
          if (refreshTimer) clearTimeout(refreshTimer);
        }
      };
    },
    refresh,
    async mutate<T>(
      input: Omit<PlanningMutation, "requestId"> & { requestId?: string },
    ): Promise<T | null> {
      const scope = transport.scope();
      const request = { ...input, requestId: input.requestId ?? crypto.randomUUID() };
      let response: PlanningMutationResult<T>;
      try {
        try {
          response = await transport.call("mutate", request);
        } catch (error) {
          // 只重试同一请求；网络层超时是否已提交由 requestId 判定。后端校验错误（E:）重试无意义。
          if (scope !== transport.scope() || String(error).includes("E:")) throw error;
          response = await transport.call("mutate", request);
        }
      } catch (error) {
        throw new Error(localizePlanningError(error));
      }
      if (scope !== transport.scope()) throw new Error(translate("planner.scopeChanged"));
      await refresh();
      if (response.status === "conflict") throw new PlanningConflictError(response.item);
      return response.item;
    },
    /** Non-mutation backend actions (e.g. `subscription.*`), followed by a refresh. */
    async command<T>(action: string, input: unknown): Promise<T> {
      try {
        const result = await transport.call<T>(action, input);
        await refresh();
        return result;
      } catch (error) {
        throw new Error(localizePlanningError(error));
      }
    },
    dispose() {
      unsubscribe?.();
      unsubscribe = null;
      if (refreshTimer) clearTimeout(refreshTimer);
      ++epoch;
      listeners = new Set();
    },
  };
}
export const planningStore = createPlanningStore(backend);
export function usePlanning() {
  return useSyncExternalStore(
    planningStore.subscribe,
    planningStore.getState,
    planningStore.getState,
  );
}
