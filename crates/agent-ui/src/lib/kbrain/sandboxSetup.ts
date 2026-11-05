/**
 * Result of K-brain's `POST /v1/sandbox/setup` (capability `sandbox_setup`), which
 * installs the Windows sandbox accounts behind a UAC prompt on the backend's desktop.
 * See K-brain docs/liveagent-backend.md, "Windows sandbox setup".
 */
export type SandboxSetupOutcome =
  /** Setup finished and the offline sandbox can now cut the network. */
  | { status: "ready" }
  /** Setup finished but the sandbox self-test still fails; `hint` says why. */
  | { status: "incomplete"; hint?: string }
  /** 403: the user declined or closed the administrator prompt; nothing changed. */
  | { status: "declined" }
  /** 409: another setup is already running. */
  | { status: "busy" }
  /** 500: setup failed, possibly part-way; running it again repairs it. */
  | { status: "failed"; message?: string }
  /** 501: the backend's platform has no sandbox setup. */
  | { status: "unsupported" }
  /** Anything else: transport failure, auth, an unexpected status. */
  | { status: "error"; message: string };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The sandbox from a setup response can cut the network (same rule as health). */
function cutsNetwork(runSandbox: unknown): boolean {
  return (
    isObject(runSandbox) &&
    runSandbox.supported === true &&
    runSandbox.network_control === true &&
    runSandbox.path_protection !== false
  );
}

/** Maps a setup response (HTTP status and JSON body, or its raw text) to an outcome. */
export function sandboxSetupOutcome(httpStatus: number, body: unknown): SandboxSetupOutcome {
  const value = isObject(body) ? body : {};
  const message = text(value.error) ?? (typeof body === "string" ? text(body) : undefined);
  if (httpStatus >= 200 && httpStatus < 300) {
    if (cutsNetwork(value.run_sandbox)) return { status: "ready" };
    const runSandbox = isObject(value.run_sandbox) ? value.run_sandbox : {};
    const status = isObject(value.status) ? value.status : {};
    const hint =
      text(runSandbox.setup_hint) ?? text(status.hint) ?? text(status.problem) ?? message;
    return hint ? { status: "incomplete", hint } : { status: "incomplete" };
  }
  if (httpStatus === 403) return { status: "declined" };
  if (httpStatus === 409) return { status: "busy" };
  if (httpStatus === 501) return { status: "unsupported" };
  if (httpStatus === 500) return message ? { status: "failed", message } : { status: "failed" };
  return { status: "error", message: message ?? `K-brain request failed (${httpStatus})` };
}

/** Reads a fetch Response from `POST /v1/sandbox/setup`. */
export async function readSandboxSetupResponse(response: Response): Promise<SandboxSetupOutcome> {
  const raw = await response.text();
  let body: unknown = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    // Keep the raw text: proxies and old backends answer errors in plain text.
  }
  return sandboxSetupOutcome(response.status, body);
}
