// Organizer service: scheduling only. The run itself executes in the core
// engine (crates/core/src/memory/organizer/run.ts) — this file arms the wake
// timer, claims a due run, hands it to the engine, and advances the schedule
// when the engine reports a terminal state.
//
// Scheduling stays here on purpose: `organizerNextRunAt` lives in app settings,
// which the frontend owns and writes. The engine only executes.
//
// Scheduling is a single one-shot timer armed from organizerNextRunAt — nothing
// is armed while the organizer is disabled, and there is no mount-time forced
// claim: Run Now (poke) is the only entry then.

import { backendFetch, subscribeEvents } from "../../backend/client";
import { type AppSettings, computeNextMemoryOrganizerRunAt } from "../../settings";
import { type MemoryOrganizeRun, memoryOrganizeDueClaim } from "../api";
import { ORGANIZER_MAX_WAKE_DELAY_MS } from "../config";

type SetSettings = (updater: (prev: AppSettings) => AppSettings) => void;

type OrganizerServiceDeps = {
  getSettings: () => AppSettings;
  setSettings: SetSettings;
};

function advanceScheduledOrganizer(run: MemoryOrganizeRun, setSettings: SetSettings) {
  if (run.trigger !== "scheduled") return;
  const now = Date.now();
  setSettings((prev) => {
    const organizerEnabled =
      prev.memory.organizerEnabled && prev.memory.organizerSchedule.frequency !== "none";
    const nextRunAt = organizerEnabled
      ? computeNextMemoryOrganizerRunAt(prev.memory.organizerSchedule, now + 1_000)
      : undefined;
    return {
      ...prev,
      memory: {
        ...prev.memory,
        organizerEnabled,
        organizerLastRunAt: now,
        organizerNextRunAt: nextRunAt,
      },
    };
  });
}

/**
 * 把一次已 claim 的 run 交给引擎，等它的终态。
 *
 * `memory_organize_run` 是 202 受理即返回（一次整理可能跑几分钟），真正的
 * 终态从 `memory_organize_ended` 事件来。等待表必须在提交**之前**装好，
 * 否则空库的秒回终态会赶在订阅前到达，这一轮就永远等不到。
 */
function runOnEngine(run: MemoryOrganizeRun): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve();
    };
    const unsubscribe = subscribeEvents((message) => {
      if (message.event !== "memory_organize_ended") return;
      const payload = message.payload as { run_id?: string } | null;
      if (payload?.run_id !== run.runId) return;
      finish();
    });
    void backendFetch("memory_organize_run", { run }).catch((error) => {
      console.error("memory organizer engine call failed", error);
      finish();
    });
  });
}

export type MemoryOrganizerService = {
  /** Re-arm the wake timer from current settings (call on settings change). */
  configure: () => void;
  /** Run Now / external trigger: claim and execute immediately. */
  poke: () => void;
  dispose: () => void;
};

export function createMemoryOrganizerService(deps: OrganizerServiceDeps): MemoryOrganizerService {
  let disposed = false;
  let running = false;
  let wakeTimeout: ReturnType<typeof setTimeout> | null = null;

  function clearWake() {
    if (wakeTimeout === null) return;
    clearTimeout(wakeTimeout);
    wakeTimeout = null;
  }

  function scheduledDelayMs(): number | null {
    const current = deps.getSettings();
    if (!current.memory.organizerEnabled || current.memory.organizerSchedule.frequency === "none") {
      return null;
    }
    const dueAt = current.memory.organizerNextRunAt;
    if (typeof dueAt !== "number" || !Number.isFinite(dueAt) || dueAt <= 0) {
      return null;
    }
    return Math.max(0, dueAt - Date.now());
  }

  function scheduleNextWake() {
    clearWake();
    if (disposed) return;
    const delay = scheduledDelayMs();
    if (delay === null) return;
    wakeTimeout = setTimeout(() => void tick(false), Math.min(delay, ORGANIZER_MAX_WAKE_DELAY_MS));
  }

  async function tick(forceClaim: boolean) {
    if (disposed || running) return;
    const current = deps.getSettings();
    const model = current.memory.organizerModel;
    const delay = scheduledDelayMs();
    // Forced pokes (Run Now) always try to claim; otherwise only a due
    // schedule does. A disabled organizer never claims on its own.
    const shouldClaim =
      forceClaim ||
      delay === 0 ||
      (delay === null && current.memory.organizerEnabled && Boolean(model));
    if (!shouldClaim) {
      scheduleNextWake();
      return;
    }
    running = true;
    try {
      const claim = await memoryOrganizeDueClaim({
        enabled: current.memory.organizerEnabled,
        dueAt: current.memory.organizerNextRunAt,
        now: Date.now(),
        model,
        scope: current.memory.organizerScope,
        mode: current.memory.organizerMode,
      });
      if (claim.run) {
        if (claim.run.status !== "skipped") {
          await runOnEngine(claim.run);
        }
        advanceScheduledOrganizer(claim.run, deps.setSettings);
      }
    } catch (error) {
      console.error("memory organizer service failed", error);
    } finally {
      running = false;
      scheduleNextWake();
    }
  }

  return {
    configure() {
      // Settings changed: re-arm the timer; claim only if already due.
      void tick(false);
    },
    poke() {
      void tick(true);
    },
    dispose() {
      disposed = true;
      clearWake();
    },
  };
}

// ---------------------------------------------------------------------------
// Module singleton so UI surfaces (Run Now button) can poke without prop
// drilling. The hook installs/uninstalls the instance.
// ---------------------------------------------------------------------------

let activeService: MemoryOrganizerService | null = null;

export function installMemoryOrganizerService(service: MemoryOrganizerService | null) {
  activeService = service;
}

/** Run Now entry. Returns false when no organizer runs in this frontend (the
 *  gateway web build ships a platform stub that always returns false). */
export function pokeMemoryOrganizer(): boolean {
  if (!activeService) return false;
  activeService.poke();
  return true;
}
