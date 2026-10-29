import type { Context } from "@liveagent/app/lib/agentTypes";
import { invoke } from "@liveagent/app/shims/tauriCore";
import { listen } from "@liveagent/app/shims/tauriEvent";
import { AppErrorBoundary } from "@liveagent/ui/components/AppErrorBoundary";
import { Pin } from "@liveagent/ui/components/IconSet";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { Toaster } from "@liveagent/ui/components/ui/toaster";
import { LocaleContext, t as translate, useLocaleContextValue } from "@liveagent/ui/i18n/index";
import { loadThinkingLiveSupplement } from "@liveagent/ui/lib/models/thinkingLive";
import {
  configureResourceHostCapabilities,
  kbrainResourceHostCapabilities,
  type ResourceHostCapabilities,
} from "@liveagent/ui/lib/resourceHost";
import {
  applyGatewaySettingsSyncPayload,
  buildGatewaySettingsSyncPayload,
  type GatewaySettingsSyncPayload,
} from "@liveagent/ui/lib/settings/sync";
import { useSettingsOverlay } from "@liveagent/ui/lib/settings/useSettingsOverlay";
import { applyFontFamilies } from "@liveagent/ui/lib/shared/fontFamily";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useDesktopImageStudioHost } from "./agent-ui-adapters/imageStudio";
import { settingsHostAdapter } from "./agent-ui-adapters/kbrainSettings";
import { kbrainSkillsAdapter } from "./agent-ui-adapters/kbrainSkills";
import { AppBootShell } from "./components/app/AppBootShell";
import { useNativeInputContextMenu } from "./components/input-context-menu/NativeInputContextMenu";
import { useMacOsAppHeaderHeight } from "./components/MacOsTitleBarSpacer";
import { ReleaseAnnouncementDialog } from "./components/ReleaseAnnouncementDialog";
import { WindowsSettingsHeader } from "./components/WindowsSettingsHeader";
import { WindowsTitleBar } from "./components/WindowsTitleBar";
import { useAppUpdateController } from "./lib/appUpdates";
import { isKBrainBrowserHost } from "./lib/host";
import { HistoryMigrationNoticeBanner } from "./lib/kbrain/HistoryMigrationNoticeBanner";
import { requestPlanning } from "./lib/planning/kbrain";
import { TimeZoneNoticeBanner } from "./lib/planning/TimeZoneNoticeBanner";
import { setRetryErrorExtension } from "./lib/providers/runtime/streamRetry";
import { useReleaseAnnouncementController } from "./lib/releaseAnnouncement";
import {
  type AppSettings,
  getDefaultSettings,
  getNextTheme,
  normalizeSettings,
  resolveEffectiveTheme,
  resolveWorkspaceProjects,
  type SttProviderId,
  subscribeToSystemThemePreference,
  THEME_OPTIONS,
  type Theme,
} from "./lib/settings";
import { mergeBackendOwnedSettings } from "./lib/settings/backendOwnedMerge";
import { getSettingsErrorMessage, SettingsStorageError } from "./lib/settings/errors";
import {
  clearRejectedLegacyProviders,
  dismissRejectedLegacyProviders,
  rejectedLegacyProviders,
  subscribeRejectedLegacyProviders,
} from "./lib/settings/legacyProviderImport";
import {
  loadPersistedSettingsWithDefaults,
  persistSettings,
  publishGatewaySettingsSync,
  type SettingsSaveState,
} from "./lib/settings/storage";
import { desktopSttSettingsService } from "./lib/stt/desktopSttSettingsService";
import type { SectionId } from "./pages/settings/types";

const guiResourceHostCapabilities: ResourceHostCapabilities = {
  ...kbrainResourceHostCapabilities,
  skillsAdapter: kbrainSkillsAdapter,
};
configureResourceHostCapabilities(guiResourceHostCapabilities);

let chatPageModule: Promise<typeof import("./pages/ChatPage")> | null = null;

function loadChatPage() {
  chatPageModule ??= import("./pages/ChatPage");
  return chatPageModule;
}

const ChatPage = lazy(async () => ({ default: (await loadChatPage()).ChatPage }));
const SettingsPage = lazy(async () => ({
  default: (await import("@liveagent/ui/pages/settings/SettingsPage")).SettingsPage,
}));
const CronPromptRunner = lazy(async () => ({
  default: (await import("./components/cron/CronPromptRunner")).CronPromptRunner,
}));

function getDefaultContext(): Context {
  return {
    messages: [],
  };
}

function getBootAlignedDefaultSettings(): AppSettings {
  const defaults = getDefaultSettings();
  if (typeof document === "undefined") return defaults;
  return {
    ...defaults,
    theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
  };
}

function interpolateMessage(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value),
    template,
  );
}

const GATEWAY_SETTINGS_SYNC_EVENT = "gateway:settings-sync";

function AppChrome(props: { children: ReactNode; notice?: ReactNode }) {
  // Plain inputs get a shared cut/copy/paste menu; everything else keeps the
  // suppressed native menu (surfaces with their own menus opt out upstream).
  const { onRootContextMenu, onRootMouseDownCapture, menu } = useNativeInputContextMenu();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Root-level pointer handlers only route native input menus and dismissals; child controls own activation semantics.
    <div
      className="relative flex size-full flex-col overflow-hidden bg-background"
      onContextMenu={onRootContextMenu}
      onMouseDownCapture={onRootMouseDownCapture}
    >
      {/* No conditional title bar here: adding or removing a sibling when the
          settings overlay opens would resize the chat subtree underneath it and make
          the whole page jump. The overlay carries its own title bar instead. */}
      {props.notice}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-background">{props.children}</div>
      {menu}
    </div>
  );
}

function hasSettingsSyncChanged(prev: AppSettings, next: AppSettings) {
  return (
    JSON.stringify(buildGatewaySettingsSyncPayload(prev)) !==
    JSON.stringify(buildGatewaySettingsSyncPayload(next))
  );
}

function hasSensitiveSettingsUpdates(settings: AppSettings) {
  return (
    settings.customProviders.some((provider) => provider.apiKey.trim().length > 0) ||
    settings.customProviders.some(
      (provider) =>
        provider.usageQuery.apiKey.trim().length > 0 ||
        provider.usageQuery.accessToken.trim().length > 0 ||
        provider.usageQuery.secretAccessKey.trim().length > 0,
    ) ||
    settings.ssh.hosts.some(
      (host) => host.password.trim().length > 0 || host.privateKey.trim().length > 0,
    )
  );
}

function hasSensitiveSettingsUpdatesPayload(payload: unknown) {
  const source =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as {
          providerApiKeyUpdates?: unknown;
          providerUsageQuerySecretUpdates?: unknown;
          sshSecretUpdates?: unknown;
          sttSecretUpdate?: unknown;
        })
      : {};
  if (
    source.sttSecretUpdate &&
    typeof source.sttSecretUpdate === "object" &&
    !Array.isArray(source.sttSecretUpdate)
  ) {
    return true;
  }
  const providerUpdates = source.providerApiKeyUpdates;
  if (
    providerUpdates &&
    typeof providerUpdates === "object" &&
    !Array.isArray(providerUpdates) &&
    Object.values(providerUpdates).some(
      (value) => typeof value === "string" && value.trim().length > 0,
    )
  ) {
    return true;
  }
  const usageQueryUpdates = source.providerUsageQuerySecretUpdates;
  if (
    usageQueryUpdates &&
    typeof usageQueryUpdates === "object" &&
    !Array.isArray(usageQueryUpdates) &&
    Object.values(usageQueryUpdates).some((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const update = value as {
        apiKey?: unknown;
        accessToken?: unknown;
        secretAccessKey?: unknown;
      };
      // 显式携带字段(含空串=清除已配置密钥)即视为敏感更新,不得被丢弃。
      return (
        typeof update.apiKey === "string" ||
        typeof update.accessToken === "string" ||
        typeof update.secretAccessKey === "string"
      );
    })
  ) {
    return true;
  }
  const sshUpdates = source.sshSecretUpdates;
  return Boolean(
    sshUpdates &&
      typeof sshUpdates === "object" &&
      !Array.isArray(sshUpdates) &&
      Object.values(sshUpdates).some((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const update = value as { password?: unknown; privateKey?: unknown };
        return (
          (typeof update.password === "string" && update.password.trim().length > 0) ||
          (typeof update.privateKey === "string" && update.privateKey.trim().length > 0)
        );
      }),
  );
}

function applyRuntimeSystemDefaults(settings: AppSettings, defaultWorkdir: string): AppSettings {
  const normalizedDefaultWorkdir = defaultWorkdir.trim();
  const system =
    !normalizedDefaultWorkdir || settings.system.workdir.trim()
      ? settings.system
      : {
          ...settings.system,
          workdir: normalizedDefaultWorkdir,
        };
  return normalizeSettings({
    ...settings,
    system: resolveWorkspaceProjects(system, normalizedDefaultWorkdir),
  });
}

export default function App() {
  // Root-level so the header height survives view switches; see the hook's note.
  useMacOsAppHeaderHeight();
  const {
    settingsOpen,
    overlay,
    openSettingsOverlay,
    closeSettingsOverlay,
    handleSettingsOverlayTransitionEnd,
  } = useSettingsOverlay();
  const [settingsSection, setSettingsSection] = useState<SectionId>("system");
  const [settingsProviderId, setSettingsProviderId] = useState<string>();
  const [settingsReady, setSettingsReady] = useState(false);
  const [backgroundHostsReady, setBackgroundHostsReady] = useState(false);
  const [settings, setSettingsState] = useState<AppSettings>(() => getBootAlignedDefaultSettings());
  const [imageStudioWorkspace, setImageStudioWorkspace] = useState(settings.system.workdir);
  const imageStudioHost = useDesktopImageStudioHost(imageStudioWorkspace);
  const [sttProviderOverride, setSttProviderOverride] = useState<SttProviderId | null>(null);
  const [settingsSaveState, setSettingsSaveState] = useState<SettingsSaveState>({
    status: "idle",
  });
  const [context, setContext] = useState<Context>(() => getDefaultContext());
  const runningConversationCountRef = useRef(0);
  const { confirm: requestRestartConfirm, dialog: restartConfirmDialog } = useConfirmDialog();

  const saveSequenceRef = useRef(0);
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const gatewaySyncChainRef = useRef<Promise<void>>(Promise.resolve());
  const defaultWorkdirRef = useRef("");
  // Mirrors `settings` so setSettings/queueSettingsSave can read the latest value
  // synchronously without passing a (side-effecting) function into setSettingsState —
  // React 18 StrictMode double-invokes functional state updaters in development,
  // which would otherwise run those side effects (and any non-idempotent work like
  // crypto.randomUUID() inside caller updaters) twice per call.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // biome-ignore lint/correctness/useExhaustiveDependencies: Saved provider changes invalidate the temporary card selection.
  useEffect(() => {
    setSttProviderOverride(null);
  }, [settings.stt.provider]);

  // 思考档位运行期补充（models.dev）：启动后台拉一次，TTL 内幂等；失败静默，
  // 档位解析维持在「快照 + 兜底」的现状。
  useEffect(() => {
    void loadThinkingLiveSupplement();
  }, []);
  const [systemThemeVersion, setSystemThemeVersion] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The version is an explicit invalidation signal for the system media query, which resolveEffectiveTheme reads outside React.
  const effectiveTheme = useMemo(
    () => resolveEffectiveTheme(settings.theme),
    [settings.theme, systemThemeVersion],
  );

  useEffect(() => {
    if (settings.theme !== "system") return;
    return subscribeToSystemThemePreference(() => {
      setSystemThemeVersion((version) => version + 1);
    });
  }, [settings.theme]);

  // 同步主题 class 到 <html> 根节点
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", effectiveTheme === "dark");
    // index.html 的启动脚本在 system 主题下会监听系统主题；React 接管后移除它。
    const bootWindow = window as Window & { __liveagentBootThemeCleanup?: () => void };
    bootWindow.__liveagentBootThemeCleanup?.();
    bootWindow.__liveagentBootThemeCleanup = undefined;
  }, [effectiveTheme]);

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
    if (isKBrainBrowserHost() || !settingsReady) return;
    void invoke("app_set_close_window_behavior", {
      behavior: settings.closeWindowBehavior,
    }).catch(() => {
      // Ignore non-Tauri and older desktop shells.
    });
  }, [settingsReady, settings.closeWindowBehavior]);

  // 启动时恢复本机保存的全局快捷键（桌面端专属，非 Tauri 环境内部自动忽略）。
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void import("./lib/shortcuts/globalShortcuts")
      .then(({ applyStoredGlobalShortcuts, installAppShortcutListener }) => {
        if (disposed) return;
        cleanup = installAppShortcutListener();
        return applyStoredGlobalShortcuts();
      })
      .catch(() => {});
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  // 窗口置顶状态：Rust 侧是唯一事实源（快捷键或指示器切换都经它广播），
  // 挂载时查询一次以覆盖 webview 重载后指示器丢失的情况。
  const [windowPinned, setWindowPinned] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    invoke<boolean>("app_window_pinned")
      .then((pinned) => {
        if (!cancelled) setWindowPinned(Boolean(pinned));
      })
      .catch(() => {
        // 非 Tauri 环境或旧版桌面壳：忽略。
      });
    listen<boolean>("global-shortcut:pin-changed", (event) => {
      setWindowPinned(Boolean(event.payload));
    })
      .then((nextUnlisten) => {
        if (cancelled) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch(() => {
        // 非 Tauri 环境忽略。
      });
    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function hydrateSettings() {
      try {
        const persistedSettingsPromise = loadPersistedSettingsWithDefaults();
        void loadChatPage();
        const { settings: loaded, defaultWorkdir } = await persistedSettingsPromise;
        loaded.skills = (await kbrainSkillsAdapter.list()).settings;
        if (!cancelled) {
          defaultWorkdirRef.current = defaultWorkdir;
          const loadedWithDefaults = applyRuntimeSystemDefaults(loaded, defaultWorkdir);
          settingsRef.current = loadedWithDefaults;
          setSettingsState(loadedWithDefaults);
          setSettingsSaveState({ status: "saved" });
          void publishGatewaySettingsSync(loadedWithDefaults).catch((error) => {
            console.error("publish gateway settings sync failed", error);
          });
        }
      } catch (error) {
        if (!cancelled) {
          console.error("load persisted settings failed", error);
          const fallback = getDefaultSettings();
          settingsRef.current = fallback;
          setSettingsState(fallback);
          setSettingsSaveState({
            status: "error",
            message: getSettingsErrorMessage(
              error,
              translate("app.settingsLoadFailed", fallback.locale),
              fallback.locale,
              translate,
            ),
          });
        }
      } finally {
        if (!cancelled) {
          setSettingsReady(true);
        }
      }
    }

    void hydrateSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settingsReady) return;
    const revealBackgroundHosts = () => setBackgroundHostsReady(true);
    if (typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(revealBackgroundHosts, { timeout: 1_000 });
      return () => window.cancelIdleCallback(idleId);
    }
    const timeoutId = window.setTimeout(revealBackgroundHosts, 0);
    return () => window.clearTimeout(timeoutId);
  }, [settingsReady]);

  // Push the user's retry-error classification (preset Cloudflare 5xx toggles +
  // custom substrings) into the stream-retry runtime. The extension is a pure
  // function of settings, so re-running on every change keeps the runtime in
  // sync without any per-call plumbing. The runtime's default already enables
  // every preset, so this is a no-op until the user actually changes something.
  useEffect(() => {
    setRetryErrorExtension({
      statusCodes: settings.retryErrorSettings.presetStatusCodes,
      patterns: settings.retryErrorSettings.customPatterns,
    });
  }, [settings.retryErrorSettings]);

  const queueSettingsSave = useCallback(
    (prev: AppSettings, next: AppSettings, fallback: string, publishSync: boolean) => {
      const saveSequence = ++saveSequenceRef.current;
      setSettingsSaveState({ status: "saving" });

      saveChainRef.current = saveChainRef.current
        .catch(() => undefined)
        .then(async () => {
          if (JSON.stringify(prev.skills) !== JSON.stringify(next.skills)) {
            await kbrainSkillsAdapter.settings(next.skills);
          }
          return persistSettings(prev, next);
        })
        .then(async (persistResult) => {
          const publishTarget = normalizeSettings({
            ...next,
            ...(persistResult.customProviders
              ? { customProviders: persistResult.customProviders }
              : {}),
            ...(persistResult.ssh ? { ssh: persistResult.ssh } : {}),
            ...(persistResult.stt ? { stt: persistResult.stt } : {}),
          });
          if (saveSequenceRef.current === saveSequence) {
            // K-brain rebuilds customProviders on every PATCH (a model pick included).
            // Only content changes reach React state, so an unchanged write-back keeps
            // the existing references and does not re-run catalog/model memos.
            const merged = mergeBackendOwnedSettings(
              settingsRef.current,
              persistResult,
              normalizeSettings,
            );
            if (merged) {
              settingsRef.current = merged;
              setSettingsState(merged);
            }
          }
          if (persistResult.conflict) {
            throw new SettingsStorageError(persistResult.conflict);
          }
          if (persistResult.providerError) {
            throw persistResult.providerError;
          }
          if (publishSync) {
            // Gateway synchronization is a secondary broadcast. Keep it ordered, but do not
            // hold the local config write queue on a slow or temporarily unavailable Gateway.
            gatewaySyncChainRef.current = gatewaySyncChainRef.current
              .catch(() => undefined)
              .then(() => publishGatewaySettingsSync(publishTarget))
              .catch((error) => {
                if (saveSequenceRef.current === saveSequence) {
                  console.error("publish gateway settings sync failed", error);
                  setSettingsSaveState({
                    status: "error",
                    message: getSettingsErrorMessage(error, fallback, next.locale, translate),
                  });
                }
              });
          }
        })
        .then(() => {
          if (saveSequenceRef.current === saveSequence) {
            setSettingsSaveState({ status: "saved" });
          }
        })
        .catch((error) => {
          if (saveSequenceRef.current === saveSequence) {
            console.error("persist settings failed", error);
            setSettingsSaveState({
              status: "error",
              message: getSettingsErrorMessage(error, fallback, next.locale, translate),
            });
          }
        });
    },
    [],
  );

  const setSettings = useCallback(
    (updater: (prev: AppSettings) => AppSettings) => {
      const prev = settingsRef.current;
      const updated = updater(prev);
      if (updated === prev) return;
      const next = applyRuntimeSystemDefaults(
        normalizeSettings(updated),
        defaultWorkdirRef.current,
      );
      settingsRef.current = next;
      setSettingsState(next);
      queueSettingsSave(
        prev,
        next,
        translate("app.settingsSaveFailed", next.locale),
        hasSettingsSyncChanged(prev, next) || hasSensitiveSettingsUpdates(next),
      );
    },
    [queueSettingsSave],
  );

  // 旧供应商导入失败的记录（K-brain 拒绝的），在供应商设置里可见；失败不阻塞设置加载。
  const [rejectedLegacyProviderEntries, setRejectedLegacyProviderEntries] = useState(() =>
    rejectedLegacyProviders(),
  );
  useEffect(() => subscribeRejectedLegacyProviders(setRejectedLegacyProviderEntries), []);

  const retryRejectedLegacyProviderImport = useCallback(async () => {
    clearRejectedLegacyProviders();
    try {
      const { settings: reloaded } = await loadPersistedSettingsWithDefaults();
      setSettings(() => reloaded);
    } catch (error) {
      console.error("retry legacy provider import failed", error);
    }
  }, [setSettings]);

  const dismissRejectedLegacyProviderNotice = useCallback(() => {
    dismissRejectedLegacyProviders(rejectedLegacyProviders());
  }, []);

  // Authoritative live read for tool write paths: settingsRef is updated
  // synchronously by setSettings, so read-modify-write sequences that stay in
  // one synchronous segment can never observe a stale snapshot.
  const getMcpSettings = useCallback(() => settingsRef.current.mcp, []);
  const getToolPolicies = useCallback(() => settingsRef.current.system.toolPolicies, []);

  const reloadPersistedSettings = useCallback(async () => {
    await saveChainRef.current.catch(() => undefined);
    const { settings: loaded, defaultWorkdir } = await loadPersistedSettingsWithDefaults();
    loaded.skills = (await kbrainSkillsAdapter.list()).settings;
    defaultWorkdirRef.current = defaultWorkdir;
    const loadedWithDefaults = applyRuntimeSystemDefaults(loaded, defaultWorkdir);
    settingsRef.current = loadedWithDefaults;
    setSettingsState(loadedWithDefaults);
    setSettingsSaveState({ status: "saved" });
  }, []);

  const toggleTheme = useCallback(() => {
    setSettings((prev) => ({
      ...prev,
      theme: getNextTheme(prev.theme),
    }));
  }, [setSettings]);

  // 托盘外观子菜单的直达设置（identity bail-out 避免重复落盘）。
  const setTheme = useCallback(
    (theme: Theme) => {
      setSettings((prev) => (prev.theme === theme ? prev : { ...prev, theme }));
    },
    [setSettings],
  );

  const settingsLeaveGuard = useRef<(() => boolean) | undefined>(undefined);
  const registerSettingsLeaveGuard = useCallback((guard: () => boolean) => {
    settingsLeaveGuard.current = guard;
    return () => {
      if (settingsLeaveGuard.current === guard) settingsLeaveGuard.current = undefined;
    };
  }, []);
  const openSettings = useCallback(
    (section: SectionId = "system", providerId?: string) => {
      if (settingsLeaveGuard.current && !settingsLeaveGuard.current()) return;
      setSettingsSection(section);
      setSettingsProviderId(section === "providers" ? providerId : undefined);
      openSettingsOverlay();
      void reloadPersistedSettings().catch((error) => {
        console.error("reload persisted settings failed", error);
        setSettingsSaveState({
          status: "error",
          message: getSettingsErrorMessage(
            error,
            translate("app.settingsReloadFailed", settingsRef.current.locale),
            settingsRef.current.locale,
            translate,
          ),
        });
      });
    },
    [openSettingsOverlay, reloadPersistedSettings],
  );

  // Read the calendar time zone once per launch so the banner can flag a mismatch; it is
  // not tracked afterwards (a system change applies after restart). Failures stay silent.
  const timeZoneChecked = useRef(false);
  useEffect(() => {
    if (!settingsReady || !backgroundHostsReady || timeZoneChecked.current) return;
    const timer = setTimeout(() => {
      timeZoneChecked.current = true;
      void requestPlanning("timezone.get").catch(() => {});
    }, 1_500);
    return () => clearTimeout(timer);
  }, [settingsReady, backgroundHostsReady]);

  const closeSettings = useCallback(() => {
    if (settingsLeaveGuard.current?.() === false) return;
    closeSettingsOverlay();
  }, [closeSettingsOverlay]);

  // 动作总线（Rust `app:action`）中 App 拥有的动作：主题/打开设置/网关开关/
  // 检查更新，以及「新建对话」时先收起设置覆盖层（会话侧由 ChatPage 处理）。
  const closeSettingsRef = useRef(closeSettings);
  closeSettingsRef.current = closeSettings;
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const openSettingsRef = useRef(openSettings);
  openSettingsRef.current = openSettings;
  const setThemeRef = useRef(setTheme);
  setThemeRef.current = setTheme;
  const runUpdateCheckRef = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<{ action: string; id?: string; value?: string }>("app:action", (event) => {
      switch (event.payload.action) {
        case "new-chat": {
          if (settingsOpenRef.current) {
            closeSettingsRef.current();
          }
          break;
        }
        case "set-theme": {
          const theme = event.payload.value;
          if ((THEME_OPTIONS as readonly string[]).includes(theme ?? "")) {
            setThemeRef.current(theme as Theme);
          }
          break;
        }
        case "open-settings": {
          openSettingsRef.current();
          break;
        }
        case "check-updates": {
          openSettingsRef.current("about");
          runUpdateCheckRef.current();
          break;
        }
        case "gateway-toggle": {
          // 与设置页远程开关同一条路径：settings 保存链会落库并 apply_config，
          // DB / 控制器 / 设置页开关三方保持一致（勿改为 Rust 直连开关）。
          setSettings((prev) => ({
            ...prev,
            remote: { ...prev.remote, enabled: !prev.remote.enabled },
          }));
          break;
        }
        default:
          break;
      }
    })
      .then((nextUnlisten) => {
        if (cancelled) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch(() => {
        // 非 Tauri 环境忽略。
      });
    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [setSettings]);

  const handleTransitionEnd = handleSettingsOverlayTransitionEnd;

  const localeContextValue = useLocaleContextValue(settings.locale);

  useEffect(() => {
    // Calendar reminder notifications are shown by the backend, which has no UI locale.
    void invoke("planning_set_labels", {
      notificationTitle: translate("planner.notificationTitle", settings.locale),
    }).catch(() => {});
  }, [settings.locale]);

  const appUpdateMessages = useMemo(
    () => ({
      checkFailed: translate("settings.aboutUpdateCheckFailed", settings.locale),
      installFailed: translate("settings.aboutUpdateInstallFailed", settings.locale),
      restartFailed: translate("settings.aboutRestartFailed", settings.locale),
    }),
    [settings.locale],
  );

  const beforeAppRestart = useCallback(async () => {
    const count = runningConversationCountRef.current;
    if (count === 0) return true;

    return requestRestartConfirm({
      title: translate("appUpdate.runningTasksTitle", settings.locale),
      description: interpolateMessage(
        translate("appUpdate.runningTasksDescription", settings.locale),
        { count: String(count) },
      ),
      cancelLabel: translate("appUpdate.restartLater", settings.locale),
      confirmLabel: translate("appUpdate.restartAnyway", settings.locale),
      closeLabel: translate("appUpdate.restartLater", settings.locale),
      preferCancel: true,
    });
  }, [requestRestartConfirm, settings.locale]);

  const handleRunningConversationCountChange = useCallback((count: number) => {
    runningConversationCountRef.current = count;
  }, []);

  const appUpdate = useAppUpdateController({
    enabled: settingsReady,
    includePrereleases: settings.updates.includePrereleases,
    messages: appUpdateMessages,
    beforeRestart: beforeAppRestart,
  });
  const releaseAnnouncement = useReleaseAnnouncementController({
    enabled: settingsReady,
    currentVersion: __LIVEAGENT_APP_VERSION__,
  });
  // 托盘「检查更新」动作：controller 在监听 effect 之后创建，经 ref 回填。
  runUpdateCheckRef.current = () => {
    void appUpdate.runCheck().catch(() => undefined);
  };

  useEffect(() => {
    if (!settingsReady) return;
    void import("@liveagent/ui/lib/automation/index")
      .then(({ initAutomation }) => initAutomation())
      .catch((error) => {
        console.warn("Failed to initialize automation store", error);
      });
  }, [settingsReady]);

  useEffect(() => {
    if (!settingsReady) {
      return;
    }

    let cancelled = false;
    const unlistenPromise = listen<GatewaySettingsSyncPayload>(
      GATEWAY_SETTINGS_SYNC_EVENT,
      (event) => {
        if (cancelled) {
          return;
        }

        const prev = settingsRef.current;
        const next = applyRuntimeSystemDefaults(
          applyGatewaySettingsSyncPayload(prev, event.payload),
          defaultWorkdirRef.current,
        );
        const publicChanged = hasSettingsSyncChanged(prev, next);
        if (!publicChanged && !hasSensitiveSettingsUpdatesPayload(event.payload)) {
          return;
        }
        settingsRef.current = next;
        setSettingsState(next);
        queueSettingsSave(
          prev,
          next,
          translate("app.gatewaySettingsSyncFailed", next.locale),
          publicChanged,
        );
      },
    );

    return () => {
      cancelled = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [queueSettingsSave, settingsReady]);

  if (!settingsReady) {
    return (
      <LocaleContext.Provider value={localeContextValue}>
        <Toaster />
        <AppChrome>
          <AppBootShell loadingLabel={translate("app.loading", settings.locale)} />
        </AppChrome>
      </LocaleContext.Provider>
    );
  }

  const visible = settingsOpen;
  const active = overlay === "open";

  return (
    <LocaleContext.Provider value={localeContextValue}>
      <Toaster />
      <AppChrome
        notice={
          <>
            <HistoryMigrationNoticeBanner onOpenSettings={() => openSettings("system")} />
            <TimeZoneNoticeBanner onOpenSettings={() => openSettings("system")} />
          </>
        }
      >
        {backgroundHostsReady ? (
          <Suspense fallback={null}>
            <CronPromptRunner settings={settings} />
          </Suspense>
        ) : null}
        <AppErrorBoundary fallbackHeader={<WindowsTitleBar />}>
          <Suspense
            fallback={<AppBootShell loadingLabel={translate("app.loading", settings.locale)} />}
          >
            <ChatPage
              settings={settings}
              setSettings={setSettings}
              resourceHost={guiResourceHostCapabilities}
              imageStudioHost={imageStudioHost}
              onImageStudioWorkspaceChange={setImageStudioWorkspace}
              sttProviderOverride={sttProviderOverride}
              getMcpSettings={getMcpSettings}
              getToolPolicies={getToolPolicies}
              context={context}
              setContext={setContext}
              onOpenSettings={openSettings}
              onToggleTheme={toggleTheme}
              appUpdate={appUpdate}
              onRunningConversationCountChange={handleRunningConversationCountChange}
            />
          </Suspense>
        </AppErrorBoundary>
        {visible && (
          <div
            className={cn(
              "absolute inset-0 z-50 flex flex-col transition-all duration-300 ease-out",
              active ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6",
            )}
            onTransitionEnd={handleTransitionEnd}
          >
            {/* The overlay owns its title bar so the chat subtree below keeps a
                constant height across open/close. */}
            <WindowsSettingsHeader />
            <div className="relative min-h-0 flex-1 overflow-hidden">
              <AppErrorBoundary>
                <Suspense
                  fallback={
                    <div className="flex size-full items-center justify-center bg-background text-sm text-muted-foreground">
                      {translate("app.loading", settings.locale)}
                    </div>
                  }
                >
                  <SettingsPage
                    settings={settings}
                    settingsHost={settingsHostAdapter}
                    imageClient={imageStudioHost?.client}
                    registerLeaveGuard={registerSettingsLeaveGuard}
                    setSettings={setSettings}
                    saveState={settingsSaveState}
                    onBack={closeSettings}
                    initialSection={settingsSection}
                    initialProviderId={settingsProviderId}
                    appUpdate={appUpdate}
                    releaseAnnouncement={releaseAnnouncement}
                    sttSettingsService={desktopSttSettingsService}
                    onSttProviderChange={setSttProviderOverride}
                    reloadSettings={reloadPersistedSettings}
                    rejectedLegacyProviders={rejectedLegacyProviderEntries}
                    onRetryRejectedLegacyProviders={retryRejectedLegacyProviderImport}
                    onDismissRejectedLegacyProviders={dismissRejectedLegacyProviderNotice}
                  />
                </Suspense>
              </AppErrorBoundary>
            </div>
          </div>
        )}
        {windowPinned && (
          <button
            type="button"
            onClick={() => {
              void invoke("app_toggle_window_pin").catch(() => {});
            }}
            title={translate("app.windowPinnedHint", settings.locale)}
            className={cn(
              "layer-toast absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5",
              "rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1",
              "text-xs font-medium text-primary shadow-sm backdrop-blur transition-colors hover:bg-primary/20",
            )}
          >
            <Pin className="size-3" />
            {translate("app.windowPinned", settings.locale)}
          </button>
        )}
        <ReleaseAnnouncementDialog controller={releaseAnnouncement} />
        {restartConfirmDialog}
      </AppChrome>
    </LocaleContext.Provider>
  );
}
