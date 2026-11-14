import {
  type CronSnapshot,
  feedCronSnapshot,
  feedHooksSnapshot,
  type HooksSnapshot,
  initAutomation,
} from "@liveagent/ui/lib/automation/index";
import { useCatalogLiveVersion } from "@liveagent/ui/lib/models/useThinkingLive";
import { setPreferredMonacoNlsLocale } from "@liveagent/ui/lib/monacoNls";
import {
  recordWebSearchFallbackState,
  webSearchFallbackStateFrom,
} from "@liveagent/ui/lib/providers/webSearchFallback";
import {
  applyGatewaySettingsSyncPayload,
  buildGatewaySettingsSyncUpdatePayload,
  type GatewaySettingsSyncUpdatePayload,
  type GatewaySettingsSyncVersion,
  redactSettingsForWebStorage,
} from "@liveagent/ui/lib/settings/sync";
import { applyFontFamilies } from "@liveagent/ui/lib/shared/fontFamily";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Locale, t } from "@/i18n/config";
import type { GatewayWebSocketClientLike } from "@/lib/gatewaySocket";
import { GatewaySettingsUpdateError } from "@/lib/gatewaySocketRpc";
import {
  type AppSettings,
  normalizeSettings,
  refreshCatalogDerivedModelLimits,
  resolveEffectiveTheme,
  subscribeToSystemThemePreference,
} from "@/lib/settings";
import { loadToken } from "@/lib/storage";
import { webSttSettingsService } from "@/lib/stt/webSttSettingsService";
import { loadWebSettings, persistWebSettings, type WebSettingsSaveState } from "@/lib/webSettings";

import { asErrorMessage } from "../chatEventUtils";
import { hasSettingsSyncChanged, resolveAppWorkspaceProjects } from "../historyUtils";
import {
  createSettingsSyncClientId,
  keepPendingFields,
  type PendingSettingsField,
  pendingFieldsForUpdate,
  readAppliedClientSeqs,
  readSettingsSyncVersion,
  SETTINGS_ECHO_ACK_TIMEOUT_MS,
  SETTINGS_ECHO_SETTLE_MS,
} from "./settingsEcho";

export { SETTINGS_ECHO_ACK_TIMEOUT_MS, SETTINGS_ECHO_SETTLE_MS };

export function getGatewaySettingsErrorMessage(error: unknown, fallback: string, locale: Locale) {
  if (error instanceof GatewaySettingsUpdateError && error.code === "settings_changed") {
    return t("app.settingsSshSettingsChanged", locale);
  }
  return asErrorMessage(error, fallback);
}

export function projectPromptSettingsUpdate(
  update: GatewaySettingsSyncUpdatePayload,
  prev: AppSettings,
  next: AppSettings,
) {
  if (!update.system) return;
  const projects: NonNullable<GatewaySettingsSyncUpdatePayload["projectPrompts"]> = {};
  const before = prev.system.workspaceResourceSettings;
  const after = next.system.workspaceResourceSettings;
  let resourceSelectionChanged = false;
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const selection = (entry: (typeof before)[string] | undefined) => ({
      mode: entry?.mode ?? "inherit",
      skillNames: entry?.skillNames ?? [],
      mcpServerIds: entry?.mcpServerIds ?? [],
    });
    if (JSON.stringify(selection(before[path])) !== JSON.stringify(selection(after[path]))) {
      resourceSelectionChanged = true;
    }
    const prompt = after[path]?.projectPrompt ?? "";
    const strategy = after[path]?.projectPromptStrategy ?? "append";
    if (
      prompt !== (before[path]?.projectPrompt ?? "") ||
      strategy !== (before[path]?.projectPromptStrategy ?? "append")
    ) {
      projects[path] = { prompt, strategy };
    }
  }
  if (Object.keys(projects).length) update.projectPrompts = projects;
  // Project layout belongs to this browser; unrelated system changes must still be validated.
  const sharedSystem = (system: AppSettings["system"]) => {
    const {
      workspaceProjects: _projects,
      workspaceResourceSettings: _resources,
      activeWorkspaceProjectId: _active,
      ...shared
    } = system;
    return shared;
  };
  if (
    JSON.stringify(sharedSystem(prev.system)) === JSON.stringify(sharedSystem(next.system)) &&
    !resourceSelectionChanged &&
    update.systemProxyPasswordUpdate === undefined
  ) {
    delete update.system;
  }
}

export function useGatewaySettingsSync(params: {
  token: string;
  api: GatewayWebSocketClientLike | null;
  activeAgentId: string;
}) {
  const { token, api, activeAgentId } = params;
  const [settings, setSettingsState] = useState<AppSettings>(() => loadWebSettings(loadToken()));
  const [settingsSyncReady, setSettingsSyncReady] = useState(() => token.trim() === "");
  const [settingsSyncError, setSettingsSyncError] = useState<string | null>(null);
  const [settingsSaveState, setSettingsSaveState] = useState<WebSettingsSaveState>({
    status: "saved",
  });
  const settingsSaveSequenceRef = useRef(0);
  const settingsSaveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const backendPromptResourcesRef = useRef(false);
  // Mirrors `settings` so setSettings/applyGatewaySettings can read the latest value
  // synchronously without passing a (side-effecting) function into setSettingsState —
  // React 18 StrictMode double-invokes functional state updaters in development,
  // which would otherwise run those side effects (and any non-idempotent work like
  // crypto.randomUUID() inside caller updaters) twice per call.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // Echo guard: fields this tab saved but the desktop has not confirmed yet keep
  // their local value. A field is released once the desktop acknowledges its seq
  // (appliedClientSeqs) or any later seq. Updates sent without a marker (older
  // desktop, K-brain relay, or before ack support was detected) can never be
  // acknowledged: their pushes are held and replayed once the save chain has been
  // quiet for a while.
  const syncClientIdRef = useRef<string | null>(null);
  syncClientIdRef.current ??= createSettingsSyncClientId();
  const syncSeqRef = useRef(0);
  const ackedSeqRef = useRef(0);
  const syncVersionRef = useRef<GatewaySettingsSyncVersion | null>(null);
  const echoAckSupportedRef = useRef(false);
  const pendingFieldsRef = useRef(
    new Map<PendingSettingsField, { seq: number; marked: boolean }>(),
  );
  const heldPushesRef = useRef<GatewaySettingsSyncUpdatePayload[]>([]);
  const savesInFlightRef = useRef(0);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [systemThemeVersion, setSystemThemeVersion] = useState(0);

  // Monaco reads NLS globals while the lazy editor module imports monaco-editor.
  setPreferredMonacoNlsLocale(settings.locale);

  // 运行期模型目录到达后，按生效目录重解析 catalog/fallback 来源的限额（只改内存，
  // 不触发保存；与桌面端同一规则）。版本 0 = 仅内置快照，加载时已按它解析过。
  const catalogLiveVersion = useCatalogLiveVersion();
  useEffect(() => {
    if (catalogLiveVersion === 0) return;
    const refreshed = refreshCatalogDerivedModelLimits(settingsRef.current);
    if (refreshed === settingsRef.current) return;
    settingsRef.current = refreshed;
    setSettingsState(refreshed);
  }, [catalogLiveVersion]);

  useEffect(() => {
    if (settings.theme !== "system") return;
    return subscribeToSystemThemePreference(() => {
      setSystemThemeVersion((version) => version + 1);
    });
  }, [settings.theme]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: system theme notifications intentionally invalidate the computed theme
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolveEffectiveTheme(settings.theme) === "dark");
  }, [settings.theme, systemThemeVersion]);

  useEffect(() => {
    applyFontFamilies({
      interfaceFontFamily: settings.customSettings.interfaceFontFamily,
      chatFontFamily: settings.customSettings.chatFontFamily,
      codeFontFamily: settings.customSettings.codeFontFamily,
    });
  }, [
    settings.customSettings.interfaceFontFamily,
    settings.customSettings.chatFontFamily,
    settings.customSettings.codeFontFamily,
  ]);

  useEffect(() => {
    setSettingsState((prev) =>
      resolveAppWorkspaceProjects(
        normalizeSettings({
          ...prev,
          remote: {
            ...prev.remote,
            gatewayUrl: window.location.origin,
            token: token.trim(),
            enabled: token.trim() !== "" || prev.remote.enabled,
          },
        }),
      ),
    );
  }, [token]);

  const commitSyncedSettings = useCallback((rawNext: AppSettings) => {
    const prev = settingsRef.current;
    const next = redactSettingsForWebStorage(resolveAppWorkspaceProjects(rawNext));
    if (!hasSettingsSyncChanged(prev, next)) {
      return;
    }
    settingsRef.current = next;
    setSettingsState(next);
    // Gateway/desktop pushes are hydration, not user edits. Persist the
    // already-redacted browser cache directly so opening Settings never
    // flashes “saving” or sends the hydrated value back to the desktop.
    try {
      persistWebSettings(next);
    } catch (error) {
      setSettingsSaveState({
        status: "error",
        message: asErrorMessage(error, "缓存桌面端设置失败。"),
      });
    }
  }, []);

  const clearEchoTimers = useCallback(() => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
    settleTimerRef.current = null;
    ackTimerRef.current = null;
  }, []);

  // Each agent is its own desktop with its own ack table, and a reconnect may land
  // on a restarted desktop: forget everything learned about the previous one.
  const resetEchoGuard = useCallback(() => {
    clearEchoTimers();
    pendingFieldsRef.current.clear();
    heldPushesRef.current = [];
    echoAckSupportedRef.current = false;
    ackedSeqRef.current = 0;
    syncVersionRef.current = null;
  }, [clearEchoTimers]);

  const hasUnmarkedPending = useCallback(() => {
    for (const entry of pendingFieldsRef.current.values()) if (!entry.marked) return true;
    return false;
  }, []);

  // The desktop handles one tab's updates in order, so acknowledging seq N also
  // settles every earlier update from this tab, with or without a marker.
  const releasePendingThrough = useCallback(
    (seq: number) => {
      for (const [field, entry] of pendingFieldsRef.current) {
        if (entry.seq <= seq) pendingFieldsRef.current.delete(field);
      }
      if (!hasUnmarkedPending()) {
        if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
        heldPushesRef.current = [];
      }
      if (pendingFieldsRef.current.size === 0) clearEchoTimers();
    },
    [clearEchoTimers, hasUnmarkedPending],
  );

  const settleHeldPushes = useCallback(() => {
    settleTimerRef.current = null;
    if (savesInFlightRef.current > 0) return;
    const held = heldPushesRef.current;
    heldPushesRef.current = [];
    for (const [field, entry] of pendingFieldsRef.current) {
      if (!entry.marked) pendingFieldsRef.current.delete(field);
    }
    if (held.length === 0) return;
    const current = settingsRef.current;
    let rawNext = current;
    for (const payload of held) rawNext = applyGatewaySettingsSyncPayload(rawNext, payload);
    commitSyncedSettings(keepPendingFields(rawNext, current, pendingFieldsRef.current));
  }, [commitSyncedSettings]);

  const scheduleEchoSettle = useCallback(() => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
    if (savesInFlightRef.current > 0 || !hasUnmarkedPending()) return;
    settleTimerRef.current = setTimeout(settleHeldPushes, SETTINGS_ECHO_SETTLE_MS);
  }, [hasUnmarkedPending, settleHeldPushes]);

  const applyGatewaySettings = useCallback(
    (payload: GatewaySettingsSyncUpdatePayload) => {
      if (Object.hasOwn(payload, "projectPrompts")) backendPromptResourcesRef.current = true;
      // The web search fallback rides along on settings.get answers from desktops whose
      // K-brain has it; the composer and the send path gate web search on it.
      if (Object.hasOwn(payload, "kbrainWebSearch")) {
        recordWebSearchFallbackState(
          webSearchFallbackStateFrom({ webSearch: payload.kbrainWebSearch }),
        );
      }
      // Automation snapshots ride along on the settings-sync channel but are
      // desktop-owned state with their own revision — feed them straight into
      // the automation store instead of the settings state.
      const automation = payload as {
        automationCron?: CronSnapshot;
        automationHooks?: HooksSnapshot;
      };
      if (automation.automationCron) {
        feedCronSnapshot(automation.automationCron);
      }
      if (automation.automationHooks) {
        feedHooksSnapshot(automation.automationHooks);
      }
      const version = readSettingsSyncVersion(payload);
      if (version) {
        const seen = syncVersionRef.current;
        if (seen?.epoch === version.epoch) {
          // Read from an older cache than a snapshot already applied: all of it is stale.
          if (version.generation < seen.generation) return;
        } else if (seen) {
          // A restarted desktop never saw this tab's pending updates and will never
          // acknowledge them; its snapshot is the truth now.
          resetEchoGuard();
        }
        syncVersionRef.current = version;
      }
      const acks = readAppliedClientSeqs(payload);
      if (acks) {
        echoAckSupportedRef.current = true;
        const ack = syncClientIdRef.current ? acks[syncClientIdRef.current] : undefined;
        if (ack && typeof ack.seq === "number" && ack.seq > ackedSeqRef.current) {
          ackedSeqRef.current = ack.seq;
          releasePendingThrough(ack.seq);
          if (typeof ack.error === "string" && ack.error.trim()) {
            setSettingsSaveState({ status: "error", message: ack.error });
          }
        }
      }
      const prev = settingsRef.current;
      const pending = pendingFieldsRef.current;
      const rawNext = keepPendingFields(
        applyGatewaySettingsSyncPayload(prev, payload),
        prev,
        pending,
      );
      if (hasUnmarkedPending()) {
        heldPushesRef.current.push(payload);
        scheduleEchoSettle();
      }
      commitSyncedSettings(rawNext);
    },
    [
      commitSyncedSettings,
      hasUnmarkedPending,
      releasePendingThrough,
      resetEchoGuard,
      scheduleEchoSettle,
    ],
  );

  const calibrateFromGateway = useCallback(() => {
    if (!api) return;
    void api
      .getSettings()
      .then((payload) => applyGatewaySettings(payload))
      .catch(() => undefined);
  }, [api, applyGatewaySettings]);

  const queueSettingsSave = useCallback(
    (prev: AppSettings, next: AppSettings, fallback: string, syncGateway: boolean) => {
      const saveSequence = ++settingsSaveSequenceRef.current;
      setSettingsSaveState({ status: "saving" });
      const redactedNext = redactSettingsForWebStorage(next);
      const gatewayUpdate =
        syncGateway && api
          ? buildGatewaySettingsSyncUpdatePayload(prev, next, {
              includeProviderApiKeyUpdates: true,
            })
          : null;
      if (gatewayUpdate?.system && backendPromptResourcesRef.current) {
        projectPromptSettingsUpdate(gatewayUpdate, prev, next);
      }
      const sendsGatewayUpdate = gatewayUpdate !== null && Object.keys(gatewayUpdate).length > 0;
      const syncSeq = sendsGatewayUpdate ? ++syncSeqRef.current : 0;
      if (gatewayUpdate && sendsGatewayUpdate) {
        // Only desktops that already report appliedClientSeqs understand the
        // marker; older desktops and the K-brain relay reject unknown fields.
        const marked = echoAckSupportedRef.current && syncClientIdRef.current !== null;
        for (const field of pendingFieldsForUpdate(gatewayUpdate)) {
          pendingFieldsRef.current.set(field, { seq: syncSeq, marked });
        }
        if (marked && syncClientIdRef.current) {
          gatewayUpdate.syncClient = { id: syncClientIdRef.current, seq: syncSeq };
          if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
          ackTimerRef.current = setTimeout(() => {
            ackTimerRef.current = null;
            if (pendingFieldsRef.current.size === 0) return;
            pendingFieldsRef.current.clear();
            calibrateFromGateway();
          }, SETTINGS_ECHO_ACK_TIMEOUT_MS);
        }
        savesInFlightRef.current += 1;
        if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }

      settingsSaveChainRef.current = settingsSaveChainRef.current
        .catch(() => undefined)
        .then(() => {
          persistWebSettings(redactedNext);
        })
        .then(async () => {
          if (gatewayUpdate && sendsGatewayUpdate) {
            await api?.updateSettings(gatewayUpdate);
          }
        })
        .then(() => {
          if (settingsSaveSequenceRef.current === saveSequence) {
            setSettingsSaveState({ status: "saved" });
          }
        })
        .catch((error) => {
          console.error("Failed to persist gateway settings", error);
          if (syncSeq > 0) releasePendingThrough(syncSeq);
          if (syncGateway && api) calibrateFromGateway();
          if (settingsSaveSequenceRef.current === saveSequence) {
            setSettingsSaveState({
              status: "error",
              message: getGatewaySettingsErrorMessage(error, fallback, settingsRef.current.locale),
            });
          }
        })
        .finally(() => {
          if (syncSeq === 0) return;
          savesInFlightRef.current -= 1;
          scheduleEchoSettle();
        });
    },
    [api, calibrateFromGateway, releasePendingThrough, scheduleEchoSettle],
  );

  const setSettings = useCallback(
    (updater: (prev: AppSettings) => AppSettings) => {
      const prev = settingsRef.current;
      const updated = updater(prev);
      if (updated === prev) return;
      const rawNext = resolveAppWorkspaceProjects(normalizeSettings(updated));
      const next = redactSettingsForWebStorage(rawNext);
      settingsRef.current = next;
      setSettingsState(next);
      queueSettingsSave(prev, rawNext, t("app.webSettingsSaveFailed", next.locale), true);
    },
    [queueSettingsSave],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: switching the active agent intentionally starts a fresh settings synchronization
  useEffect(() => {
    backendPromptResourcesRef.current = false;
    resetEchoGuard();
    if (!api) {
      setSettingsSyncReady(token.trim() === "");
      setSettingsSyncError(null);
      return;
    }

    let cancelled = false;
    setSettingsSyncReady(false);
    setSettingsSyncError(null);
    // Best-effort: the desktop may be offline; the settings-sync push
    // populates the store once it connects.
    void initAutomation().catch(() => undefined);
    const liveSyncEpochRef = { current: 0 };
    const applySyncedSettings = (payload: GatewaySettingsSyncUpdatePayload) => {
      if (cancelled) {
        return;
      }
      liveSyncEpochRef.current += 1;
      applyGatewaySettings(payload);
      setSettingsSyncError(null);
    };
    const unsubscribe = api.subscribeSettings(applySyncedSettings);
    // Acks cannot be trusted across a dropped socket (the desktop may have
    // restarted and lost its ack table): drop pending fields, recalibrate.
    let connectionLost = false;
    const unsubscribeConnection = api.subscribeConnection((connected) => {
      if (!connected) {
        connectionLost = true;
        return;
      }
      if (!connectionLost || cancelled) return;
      connectionLost = false;
      resetEchoGuard();
      void api
        .getSettings()
        .then((payload) => {
          if (!cancelled) applySyncedSettings(payload);
        })
        .catch(() => undefined);
    });

    void api
      .getSettings()
      .then(async (payload) => {
        if (!cancelled) {
          // A live WS push that arrived while GET was in flight is newer.
          if (liveSyncEpochRef.current === 0) {
            applySyncedSettings(payload);
          }
          // The Gateway STT store is the WebUI runtime authority for whether
          // redacted credentials are configured. A cached desktop snapshot may
          // contain an older configured=false value even though Gateway still
          // has the credentials, so hydrate this once before the app is ready.
          // Skip the HTTP result if a newer settings push landed during fetch.
          try {
            const sttEpoch = liveSyncEpochRef.current;
            const stt = await webSttSettingsService.get();
            if (!cancelled && liveSyncEpochRef.current === sttEpoch) {
              applyGatewaySettings({ stt });
            }
          } catch {
            // General settings sync remains usable when STT is unavailable.
          }
        }
        if (!cancelled) {
          setSettingsSyncReady(true);
          setSettingsSyncError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSettingsSyncError(
            asErrorMessage(error, t("app.desktopSettingsSyncFailed", settingsRef.current.locale)),
          );
          setSettingsSyncReady(true);
        }
      });

    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeConnection();
      clearEchoTimers();
    };
  }, [api, activeAgentId, applyGatewaySettings, clearEchoTimers, resetEchoGuard, token]);

  return {
    settings,
    setSettings,
    settingsSyncReady,
    settingsSyncError,
    settingsSaveState,
  };
}
