import { runSandboxLacksPathProtection } from "@liveagent/ui/lib/kbrain/health";
import { useEffect, useState } from "react";
import { isKBrainBrowserHost } from "../lib/host";
import { getKBrainHealth } from "./kbrainSettings";

export type SandboxCapability = {
  supported: boolean;
  mechanism: string;
  platform: string;
  /** Whether the offline variant (sandboxOffline) can block the network. */
  network_control: boolean;
  /** False when the sandbox fences writes but cannot hide credential directories. */
  read_masking?: boolean;
  /**
   * False when protected workspace paths (.liveagent, .git/hooks, ...) stay
   * writable inside the sandbox; LiveAgent then reports the sandbox unsupported.
   */
  path_protection?: boolean;
  reason?: string;
};

const BACKEND_TOO_OLD = "update K-brain to a version with run sandboxing";

/**
 * Reads K-brain's capabilities.run_sandbox from /v1/health. Commands run in the
 * backend, so its sandbox, not the desktop's, is the one that applies. A backend
 * without the capability reports unsupported, so the sandbox modes are disabled
 * instead of silently running commands unconfined. So does a sandbox that leaves
 * the protected workspace paths writable (path_protection false, e.g. Landlock):
 * those files are used outside the sandbox, which would let a command escape.
 */
export function sandboxCapabilityFromHealth(health: {
  capabilities?: Record<string, unknown>;
}): SandboxCapability {
  const raw = health.capabilities?.run_sandbox;
  if (!raw || typeof raw !== "object") {
    return {
      supported: false,
      mechanism: "",
      platform: "",
      network_control: false,
      reason: BACKEND_TOO_OLD,
    };
  }
  const value = raw as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : "");
  // Only a sandbox the backend can run reports path protection; an unsupported
  // one keeps the backend's own reason.
  const lacksPathProtection = runSandboxLacksPathProtection(value);
  const supported = value.supported === true && !lacksPathProtection;
  return {
    supported,
    mechanism: text("mechanism"),
    platform: text("platform"),
    network_control: supported && value.network_control === true,
    ...(typeof value.read_masking === "boolean" ? { read_masking: value.read_masking } : {}),
    ...(lacksPathProtection
      ? { path_protection: false }
      : supported && typeof value.path_protection === "boolean"
        ? { path_protection: value.path_protection }
        : {}),
    ...(text("reason") ? { reason: text("reason") } : {}),
  };
}

let cachedCapability: SandboxCapability | null = null;
let pending: Promise<SandboxCapability> | null = null;

/** Desktop: the backend's run sandbox; null while the first health read is pending. */
export function useSandboxCapability(): SandboxCapability | null {
  const [capability, setCapability] = useState<SandboxCapability | null>(cachedCapability);

  useEffect(() => {
    if (isKBrainBrowserHost() || cachedCapability) return;
    let disposed = false;
    pending ??= getKBrainHealth().then(sandboxCapabilityFromHealth);
    pending
      .then((result) => {
        cachedCapability = result;
        if (!disposed) setCapability(result);
      })
      .catch((error) => {
        // A failed read is not cached; the next mount asks again.
        pending = null;
        console.warn("K-brain sandbox capability unavailable", error);
      });
    return () => {
      disposed = true;
    };
  }, []);

  return capability;
}
