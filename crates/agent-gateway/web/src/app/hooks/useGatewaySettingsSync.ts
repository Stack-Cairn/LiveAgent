import { useCallback, useEffect, useRef, useState } from "react";

import {
  type CronSnapshot,
  feedCronSnapshot,
  feedHooksSnapshot,
  type HooksSnapshot,
  initAutomation,
} from "@/lib/automation";
import type { GatewayWebSocketClientLike } from "@/lib/gatewaySocket";
import { setPreferredMonacoNlsLocale } from "@/lib/monacoNls";
import {
  type AppSettings,
  normalizeSettings,
  resolveEffectiveTheme,
  subscribeToSystemThemePreference,
} from "@/lib/settings";
import {
  applyGatewaySettingsSyncPayload,
  buildGatewaySettingsSyncUpdatePayload,
  type GatewaySettingsSyncPayload,
  redactSettingsForWebStorage,
} from "@/lib/settings/sync";
import { loadToken } from "@/lib/storage";
import { loadWebSettings, persistWebSettings, type WebSettingsSaveState } from "@/lib/webSettings";

import { asErrorMessage } from "../chatEventUtils";
import { hasSettingsSyncChanged, resolveAppWorkspaceProjects } from "../historyUtils";

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

  useEffect(() => {
    if (settings.theme !== "system") return;
    return subscribeToSystemThemePreference(() => {
      setSystemThemeVersion((version) => version + 1);
    });
  }, [settings.theme]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolveEffectiveTheme(settings.theme) === "dark");
  }, [settings.theme, systemThemeVersion]);

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
              message: asErrorMessage(error, fallback),
            });
          }
        });
    },
    [api],
  );

  const applyGatewaySettings = useCallback(
    (payload: GatewaySettingsSyncPayload) => {
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
      queueSettingsSave(prev, next, "同步桌面端设置失败。", false);
    },
    [queueSettingsSave],
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
      queueSettingsSave(prev, rawNext, "保存 WebUI 设置失败。", true);
    },
    [queueSettingsSave],
  );

  useEffect(() => {
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
    const unsubscribe = api.subscribeSettings((payload) => {
      if (cancelled) {
        return;
      }
      applyGatewaySettings(payload);
      setSettingsSyncError(null);
    });

    void api
      .getSettings()
      .then((payload) => {
        if (!cancelled) {
          applyGatewaySettings(payload);
          setSettingsSyncReady(true);
          setSettingsSyncError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSettingsSyncError(asErrorMessage(error, "同步桌面端设置失败"));
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
