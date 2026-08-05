import { useCallback, useEffect, useRef } from "react";
import {
  checkCliIdentityVersions,
  cliIdentityProvidersNeedingCheck,
  mergeCliIdentityCheckResults,
} from "../lib/providers/cliIdentityUpdates";
import { type AppSettings, updateCustomSettings } from "../lib/settings";

const CHECK_TIMEOUT_MS = 8_000;
const RECHECK_TICK_MS = 60 * 60 * 1_000;

export function CliIdentityUpdateHost(props: {
  settings: AppSettings;
  setSettings: (updater: (previous: AppSettings) => AppSettings) => void;
}) {
  const { settings, setSettings } = props;
  const identitiesRef = useRef(settings.customSettings.providerIdentities);
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  identitiesRef.current = settings.customSettings.providerIdentities;

  const runCheck = useCallback(async () => {
    if (runningRef.current) return;
    const providerIds = cliIdentityProvidersNeedingCheck(identitiesRef.current);
    if (providerIds.length === 0) return;
    runningRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
      const results = await checkCliIdentityVersions(providerIds, controller.signal);
      setSettings((previous) => {
        const merged = mergeCliIdentityCheckResults(
          previous.customSettings.providerIdentities,
          results,
        );
        return merged.changed
          ? updateCustomSettings(previous, { providerIdentities: merged.identities })
          : previous;
      });
    } finally {
      window.clearTimeout(timeout);
      if (abortRef.current === controller) abortRef.current = null;
      runningRef.current = false;
    }
  }, [setSettings]);

  useEffect(() => {
    void runCheck();
    const interval = window.setInterval(() => void runCheck(), RECHECK_TICK_MS);
    const onFocus = () => void runCheck();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      abortRef.current?.abort();
    };
  }, [runCheck]);

  return null;
}
