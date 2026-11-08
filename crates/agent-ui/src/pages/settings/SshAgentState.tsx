// What K-brain's SSHManager holds for each Settings > SSH host: whether it has the
// credential and which host keys it saved. The desktop pushes the hosts to K-brain
// (`settings_kbrain_ssh_state` syncs first); hosts without a K-brain that supports
// SSHManager, and the WebUI, which has no such command, show nothing extra.

import { invoke } from "@liveagent/app/shims/tauriCore";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useCallback, useEffect, useRef, useState } from "react";
import { PromptTag } from "./shared";

export type KBrainSshHostKey = { algorithm: string; fingerprint: string };

export type KBrainSshHostState = {
  id: string;
  host: string;
  port: number;
  authType: string;
  credential: "saved" | "missing" | "interactive" | string;
  hostKeys: KBrainSshHostKey[];
};

export type KBrainSshState = {
  connected: boolean;
  supported: boolean;
  hosts?: KBrainSshHostState[];
  knownHostsPath?: string;
  skippedHostIds?: string[];
  error?: string;
};

function readHostKeys(value: unknown): KBrainSshHostKey[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { algorithm, fingerprint } = entry as Record<string, unknown>;
    return typeof fingerprint === "string" && fingerprint
      ? [{ algorithm: typeof algorithm === "string" ? algorithm : "", fingerprint }]
      : [];
  });
}

export function normalizeKBrainSshState(raw: unknown): KBrainSshState | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const state: KBrainSshState = {
    connected: record.connected === true,
    supported: record.supported === true,
  };
  if (Array.isArray(record.hosts)) {
    state.hosts = record.hosts.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const host = entry as Record<string, unknown>;
      if (typeof host.id !== "string" || !host.id) return [];
      return [
        {
          id: host.id,
          host: typeof host.host === "string" ? host.host : "",
          port: typeof host.port === "number" ? host.port : 22,
          authType: typeof host.authType === "string" ? host.authType : "",
          credential: typeof host.credential === "string" ? host.credential : "",
          hostKeys: readHostKeys(host.hostKeys),
        },
      ];
    });
  }
  if (typeof record.knownHostsPath === "string") state.knownHostsPath = record.knownHostsPath;
  if (Array.isArray(record.skippedHostIds)) {
    state.skippedHostIds = record.skippedHostIds.filter(
      (id): id is string => typeof id === "string",
    );
  }
  if (typeof record.error === "string" && record.error) state.error = record.error;
  return state;
}

/**
 * Loads the K-brain view on mount and whenever a settings save finishes; `refresh`
 * reloads it on demand (after forgetting a host key). Null while unknown or when the
 * host has no such command.
 */
export function useKBrainSshState(saveStatus: string) {
  const [state, setState] = useState<KBrainSshState | null>(null);
  const requestRef = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    let next: KBrainSshState | null = null;
    try {
      next = normalizeKBrainSshState(await invoke<unknown>("settings_kbrain_ssh_state", {}));
    } catch {
      next = null;
    }
    if (request === requestRef.current) setState(next);
  }, []);
  useEffect(() => {
    if (saveStatus === "saving") return;
    void refresh();
  }, [refresh, saveStatus]);
  return { state, refresh };
}

/** The K-brain line under a host card: credential state and saved host keys. */
export function SshAgentHostStatus({
  hostId,
  state,
}: {
  hostId: string;
  state: KBrainSshState | null;
}) {
  const { t } = useLocale();
  if (!state?.connected || !state.supported || state.error) return null;
  if (state.skippedHostIds?.includes(hostId)) {
    return (
      <div className="text-xs leading-relaxed text-muted-foreground" data-ssh-agent-host={hostId}>
        {t("settings.sshAgentSkipped")}
      </div>
    );
  }
  const host = state.hosts?.find((entry) => entry.id === hostId);
  if (!host) return null;
  const credentialLabel =
    host.credential === "saved"
      ? t("settings.sshAgentCredentialSaved")
      : host.credential === "interactive"
        ? t("settings.sshAgentCredentialInteractive")
        : host.credential === "missing"
          ? t("settings.sshAgentCredentialMissing")
          : "";
  return (
    <div className="space-y-1.5" data-ssh-agent-host={hostId}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">{t("settings.sshAgentLabel")}</span>
        {credentialLabel ? (
          <PromptTag label={credentialLabel} muted={host.credential !== "saved"} />
        ) : null}
        {host.hostKeys.length === 0 ? (
          <span className="text-xs text-muted-foreground/70">
            {t("settings.sshAgentNoHostKeys")}
          </span>
        ) : null}
      </div>
      {host.hostKeys.length > 0 ? (
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">{t("settings.sshAgentHostKeys")}</div>
          {host.hostKeys.map((key) => (
            <div
              key={`${key.algorithm}-${key.fingerprint}`}
              className="flex min-w-0 flex-wrap items-baseline gap-x-2 font-mono text-xs"
              data-ssh-agent-host-key={key.fingerprint}
            >
              <span className="shrink-0 text-muted-foreground">{key.algorithm}</span>
              <span className="min-w-0 select-text break-all text-foreground/85">
                {key.fingerprint}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A section-level note when the push to K-brain failed. */
export function SshAgentSyncError({ state }: { state: KBrainSshState | null }) {
  const { t } = useLocale();
  if (!state?.error) return null;
  return (
    <div className="rounded-lg bg-destructive/5 px-3 py-2 text-xs leading-relaxed text-destructive">
      {t("settings.sshAgentSyncFailed").replace("{error}", state.error)}
    </div>
  );
}

/** Whether the card has a K-brain line to show. */
export function hasSshAgentHostStatus(hostId: string, state: KBrainSshState | null) {
  if (!state?.connected || !state.supported || state.error) return false;
  return (
    Boolean(state.skippedHostIds?.includes(hostId)) ||
    Boolean(state.hosts?.some((entry) => entry.id === hostId))
  );
}
