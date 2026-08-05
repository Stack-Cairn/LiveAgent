import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type AppUpdateChannel = "stable" | "prerelease";

export type AppUpdateCheckResult = {
  configured: boolean;
  available: boolean;
  currentVersion: string;
  version?: string | null;
  date?: string | null;
  body?: string | null;
  channel: AppUpdateChannel;
  releaseTag?: string | null;
  releaseName?: string | null;
  releaseUrl?: string | null;
  repository: string;
  message?: string | null;
  manualDownload?: boolean;
};

export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "ready"
  | "installing"
  | "installed"
  | "restarting"
  | "error";

export type AppUpdateState =
  | { status: "idle"; result?: AppUpdateCheckResult }
  | { status: "checking"; result?: AppUpdateCheckResult }
  | { status: "ready"; result: AppUpdateCheckResult }
  | { status: "installing"; result: AppUpdateCheckResult }
  | { status: "installed"; result: AppUpdateCheckResult }
  | { status: "restarting"; result: AppUpdateCheckResult }
  | { status: "error"; result?: AppUpdateCheckResult; message: string };

export type AppUpdateMessages = {
  checkFailed: string;
  installFailed: string;
  restartFailed: string;
};

export type AppUpdateController = {
  state: AppUpdateState;
  status: AppUpdateStatus;
  result?: AppUpdateCheckResult;
  message?: string;
  checking: boolean;
  installing: boolean;
  installed: boolean;
  restarting: boolean;
  busy: boolean;
  canInstall: boolean;
  showUpdateButton: boolean;
  runCheck: () => Promise<AppUpdateCheckResult | undefined>;
  installOnly: () => Promise<AppUpdateCheckResult | undefined>;
  installAndRestart: () => Promise<AppUpdateCheckResult | undefined>;
  restart: () => Promise<void>;
};

type UseAppUpdateControllerOptions = {
  enabled: boolean;
  includePrereleases: boolean;
  messages?: Partial<AppUpdateMessages>;
};

const DEFAULT_MESSAGES: AppUpdateMessages = {
  checkFailed: "Failed to check for updates.",
  installFailed: "Failed to install update.",
  restartFailed: "Failed to restart app.",
};

export const APP_UPDATE_CHECK_INTERVAL_MS = 20 * 60 * 1000;

function asErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const text = String(error ?? "").trim();
  return text || fallback;
}

export function getAppUpdateStateResult(state: AppUpdateState) {
  return state.result;
}

export function getAppUpdateDisplayVersion(result?: AppUpdateCheckResult) {
  return result?.version || result?.releaseTag || "";
}

export function isAppUpdateBusy(state: AppUpdateState) {
  return (
    state.status === "checking" || state.status === "installing" || state.status === "restarting"
  );
}

export function canInstallAppUpdate(state: AppUpdateState) {
  const result = getAppUpdateStateResult(state);
  return Boolean(
    result?.configured &&
      result.available &&
      state.status !== "checking" &&
      state.status !== "installing" &&
      state.status !== "restarting",
  );
}

export function shouldShowAppUpdateButton(state: AppUpdateState) {
  const result = getAppUpdateStateResult(state);
  return Boolean(
    result?.available || state.status === "installing" || state.status === "restarting",
  );
}

export function shouldRunAutomaticAppUpdateCheck(state: AppUpdateState) {
  return (
    state.status !== "checking" &&
    state.status !== "installing" &&
    state.status !== "installed" &&
    state.status !== "restarting"
  );
}

export function useAppUpdateController({
  enabled,
  includePrereleases,
  messages,
}: UseAppUpdateControllerOptions): AppUpdateController {
  const [state, setState] = useState<AppUpdateState>({ status: "idle" });
  const stateRef = useRef<AppUpdateState>(state);
  const checkSeqRef = useRef(0);
  const messagesRef = useRef<AppUpdateMessages>(DEFAULT_MESSAGES);

  useEffect(() => {
    messagesRef.current = {
      ...DEFAULT_MESSAGES,
      ...messages,
    };
  }, [messages]);

  const setUpdateState = useCallback((next: AppUpdateState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const runCheck = useCallback(async () => {
    if (!enabled) {
      return undefined;
    }

    const requestId = ++checkSeqRef.current;
    const current = stateRef.current;
    setUpdateState({
      status: "checking",
      result: getAppUpdateStateResult(current),
    });

    try {
      const result = await invoke<AppUpdateCheckResult>("app_update_check", {
        include_prerelease: includePrereleases,
      });
      if (requestId === checkSeqRef.current) {
        setUpdateState({ status: "ready", result });
      }
      return result;
    } catch (error) {
      const currentResult = getAppUpdateStateResult(stateRef.current);
      const message = asErrorMessage(error, messagesRef.current.checkFailed);
      if (requestId === checkSeqRef.current) {
        setUpdateState({
          status: "error",
          result: currentResult,
          message,
        });
      }
      throw error;
    }
  }, [enabled, includePrereleases, setUpdateState]);

  useEffect(() => {
    if (!enabled) {
      setUpdateState({ status: "idle" });
      return undefined;
    }

    const checkForUpdates = () => {
      if (!shouldRunAutomaticAppUpdateCheck(stateRef.current)) {
        return;
      }

      void runCheck().catch(() => undefined);
    };

    checkForUpdates();
    const intervalId = window.setInterval(checkForUpdates, APP_UPDATE_CHECK_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [enabled, runCheck, setUpdateState]);

  const installOnly = useCallback(async () => {
    const current = stateRef.current;
    const result = getAppUpdateStateResult(current);
    if (!result?.configured || !result.available || current.status === "installing") {
      return undefined;
    }

    setUpdateState({ status: "installing", result });
    try {
      const nextResult = await invoke<AppUpdateCheckResult>("app_update_install", {
        include_prerelease: includePrereleases,
      });
      setUpdateState({ status: "installed", result: nextResult });
      return nextResult;
    } catch (error) {
      setUpdateState({
        status: "error",
        result,
        message: asErrorMessage(error, messagesRef.current.installFailed),
      });
      throw error;
    }
  }, [includePrereleases, setUpdateState]);

  const restart = useCallback(async () => {
    const current = stateRef.current;
    const result = getAppUpdateStateResult(current);
    if (!result || current.status === "restarting") {
      return;
    }

    setUpdateState({ status: "restarting", result });
    try {
      await invoke("app_restart");
    } catch (error) {
      setUpdateState({
        status: "error",
        result,
        message: asErrorMessage(error, messagesRef.current.restartFailed),
      });
      throw error;
    }
  }, [setUpdateState]);

  const installAndRestart = useCallback(async () => {
    const result = await installOnly();
    if (!result) {
      return undefined;
    }

    setUpdateState({ status: "restarting", result });
    try {
      await invoke("app_restart");
      return result;
    } catch (error) {
      setUpdateState({
        status: "error",
        result,
        message: asErrorMessage(error, messagesRef.current.restartFailed),
      });
      throw error;
    }
  }, [installOnly, setUpdateState]);

  const result = getAppUpdateStateResult(state);
  const message = state.status === "error" ? state.message : undefined;
  const checking = state.status === "checking";
  const installing = state.status === "installing";
  const installed = state.status === "installed";
  const restarting = state.status === "restarting";
  const busy = isAppUpdateBusy(state);
  const canInstall = canInstallAppUpdate(state);
  const showUpdateButton = shouldShowAppUpdateButton(state);

  return useMemo(
    () => ({
      state,
      status: state.status,
      result,
      message,
      checking,
      installing,
      installed,
      restarting,
      busy,
      canInstall,
      showUpdateButton,
      runCheck,
      installOnly,
      installAndRestart,
      restart,
    }),
    [
      state,
      result,
      message,
      checking,
      installing,
      installed,
      restarting,
      busy,
      canInstall,
      showUpdateButton,
      runCheck,
      installOnly,
      installAndRestart,
      restart,
    ],
  );
}
