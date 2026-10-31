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
  applyGatewaySettingsSyncPayload,
  buildGatewaySettingsSyncUpdatePayload,
  type GatewaySettingsSyncUpdatePayload,
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

      settingsSaveChainRef.current = settingsSaveChainRef.current
        .catch(() => undefined)
        .then(() => {
          persistWebSettings(redactedNext);
        })
        .then(async () => {
          if (gatewayUpdate && Object.keys(gatewayUpdate).length > 0) {
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
          if (syncGateway && api) {
            void api
              .getSettings()
              .then((payload) => {
                const current = settingsRef.current;
                const refreshed = redactSettingsForWebStorage(
                  resolveAppWorkspaceProjects(applyGatewaySettingsSyncPayload(current, payload)),
                );
                settingsRef.current = refreshed;
                persistWebSettings(refreshed);
                setSettingsState(refreshed);
              })
              .catch(() => undefined);
          }
          if (settingsSaveSequenceRef.current === saveSequence) {
            setSettingsSaveState({
              status: "error",
              message: getGatewaySettingsErrorMessage(error, fallback, settingsRef.current.locale),
            });
          }
        });
    },
    [api],
  );

  const applyGatewaySettings = useCallback((payload: GatewaySettingsSyncUpdatePayload) => {
    if (Object.hasOwn(payload, "projectPrompts")) backendPromptResourcesRef.current = true;
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
    const prev = settingsRef.current;
    const rawNext = resolveAppWorkspaceProjects(applyGatewaySettingsSyncPayload(prev, payload));
    const next = redactSettingsForWebStorage(rawNext);
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
    };
  }, [api, activeAgentId, applyGatewaySettings, token]);

  return {
    settings,
    setSettings,
    settingsSyncReady,
    settingsSyncError,
    settingsSaveState,
  };
}
