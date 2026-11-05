import {
  offersRunSandboxSetup,
  runSandboxLacksPathProtection,
} from "@liveagent/ui/lib/kbrain/health";
import type { SandboxSetupOutcome } from "@liveagent/ui/lib/kbrain/sandboxSetup";
import { useEffect, useState } from "react";
import { isKBrainBrowserHost } from "../lib/host";
import { getKBrainRuntimeConnection } from "../lib/kbrain/runtimeConnection";
import type { KBrainRunSandboxCapability } from "../lib/kbrain/types";
import { getKBrainHealth, setUpKBrainSandbox } from "./kbrainSettings";

export type { SandboxSetupOutcome };

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
  /**
   * Present (true) when K-brain can run its Windows sandbox setup from here so the
   * offline sandbox can cut the network: `sandbox_setup` 1, `setup_available`, no
   * network control yet, and a backend on this machine (UAC shows on its desktop).
   */
  setup_available?: true;
  /** K-brain's short English note about setup (run_sandbox.setup_hint). */
  setup_hint?: string;
};

const BACKEND_TOO_OLD = "update K-brain to a version with run sandboxing";

/**
 * Reads K-brain's capabilities.run_sandbox from /v1/health. Commands run in the
 * backend, so its sandbox, not the desktop's, is the one that applies. A backend
 * without the capability reports unsupported, so the sandbox modes are disabled
 * instead of silently running commands unconfined. So does a sandbox that leaves
 * the protected workspace paths writable (path_protection false, e.g. Landlock):
 * those files are used outside the sandbox, which would let a command escape.
 * `setupHost` false (a backend on another machine) never offers sandbox setup.
 */
export function sandboxCapabilityFromHealth(
  health: { capabilities?: Record<string, unknown> },
  options: { setupHost?: boolean } = {},
): SandboxCapability {
  const capabilities = health.capabilities ?? {};
  const raw = capabilities.run_sandbox;
  if (!raw || typeof raw !== "object") {
    return {
      supported: false,
      mechanism: "",
      platform: "",
      network_control: false,
      reason: BACKEND_TOO_OLD,
    };
  }
  const value = raw as KBrainRunSandboxCapability & Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : "");
  // Only a sandbox the backend can run reports path protection; an unsupported
  // one keeps the backend's own reason.
  const lacksPathProtection = runSandboxLacksPathProtection(value);
  const supported = value.supported === true && !lacksPathProtection;
  const setup = options.setupHost !== false && offersRunSandboxSetup({ capabilities });
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
    ...(setup ? { setup_available: true as const } : {}),
    ...(setup && text("setup_hint").trim() ? { setup_hint: text("setup_hint").trim() } : {}),
  };
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Setup's UAC prompt appears where K-brain runs, so only a local backend offers it. */
function backendIsLocal(): boolean {
  const connection = getKBrainRuntimeConnection();
  if (!connection) return false;
  if (connection.managedLocal) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(connection.baseUrl).hostname);
  } catch {
    return false;
  }
}

let cachedCapability: SandboxCapability | null = null;
let pending: Promise<SandboxCapability> | null = null;
// Each read takes a number; an older read finishing late never overwrites a newer one.
let readSequence = 0;
const listeners = new Set<(capability: SandboxCapability) => void>();

function readCapability(): Promise<SandboxCapability> {
  const sequence = ++readSequence;
  const read = getKBrainHealth()
    .then((health) => sandboxCapabilityFromHealth(health, { setupHost: backendIsLocal() }))
    .then((result) => {
      if (sequence === readSequence) {
        cachedCapability = result;
        for (const listener of listeners) listener(result);
      }
      return result;
    });
  pending = read;
  // A failed read is not cached; the next mount or refresh asks again.
  read.catch(() => {
    if (pending === read) pending = null;
  });
  return read;
}

/**
 * Reads the capability again (after sandbox setup bumps capabilityRevision) and
 * updates every mounted selector.
 */
export function refreshSandboxCapability(): Promise<SandboxCapability> {
  return readCapability();
}

/** Desktop: the backend's run sandbox; null while the first health read is pending. */
export function useSandboxCapability(): SandboxCapability | null {
  const [capability, setCapability] = useState<SandboxCapability | null>(cachedCapability);

  useEffect(() => {
    if (isKBrainBrowserHost()) return;
    listeners.add(setCapability);
    if (cachedCapability) setCapability(cachedCapability);
    else
      (pending ?? readCapability()).catch((error) => {
        console.warn("K-brain sandbox capability unavailable", error);
      });
    return () => {
      listeners.delete(setCapability);
    };
  }, []);

  return capability;
}

/**
 * Runs K-brain's Windows sandbox setup and then reads the capability again, so the
 * offline sandbox becomes selectable once it works. The re-read follows every
 * attempt the backend may have acted on (a dropped connection included), and its
 * answer decides whether a finished setup really left the offline sandbox usable.
 */
export async function setUpOfflineSandbox(): Promise<SandboxSetupOutcome> {
  if (isKBrainBrowserHost()) return { status: "unsupported" };
  let outcome: SandboxSetupOutcome;
  try {
    outcome = await setUpKBrainSandbox();
  } catch (error) {
    outcome = { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
  if (outcome.status === "unsupported") return outcome;
  let capability: SandboxCapability;
  try {
    capability = await refreshSandboxCapability();
  } catch (error) {
    console.warn("K-brain sandbox capability unavailable after setup", error);
    return outcome;
  }
  if (outcome.status === "ready" || outcome.status === "incomplete") {
    if (capability.network_control) return { status: "ready" };
    const hint = capability.setup_hint ?? (outcome.status === "incomplete" ? outcome.hint : "");
    return hint ? { status: "incomplete", hint } : { status: "incomplete" };
  }
  return outcome;
}
