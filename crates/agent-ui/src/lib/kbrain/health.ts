/**
 * Single `/v1/health` parser for every TS host (desktop direct, browser direct,
 * settings). Rules follow docs/design/2026-10-26-kbrain-decoupled-updates.md
 * section 3.1; the Rust and Go parsers share `health-contract-vectors.json`.
 */

export const KBRAIN_LEGACY_PROTOCOL_VERSION = "kbrain.agent.v1";
export const KBRAIN_PROTOCOL_NAME = "kbrain.agent";
export const KBRAIN_PROTOCOL_MAJOR = 1;

export type KBrainProtocolInfo = { name: string; major: number; minor: number };

export type KBrainBuildInfo = { version: string; revision?: string; channel?: string };

export type KBrainHealth = {
  /** True when the backend predates structured health (no `protocol`). */
  legacy: boolean;
  protocol: KBrainProtocolInfo;
  build: KBrainBuildInfo | null;
  startupContract: number | null;
  instanceId: string | null;
  capabilityRevision: number | null;
  capabilities: Record<string, unknown>;
};

export class KBrainHealthContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KBrainHealthContractError";
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function reject(message: string): never {
  throw new KBrainHealthContractError(`K-brain health contract violation: ${message}`);
}

/** A present field with the wrong type is a broken contract, never "missing". */
function optional<T>(
  body: JsonObject,
  key: string,
  accept: (value: unknown) => value is T,
  expected: string,
): T | null {
  if (!(key in body)) return null;
  const value = body[key];
  if (!accept(value)) reject(`${key} must be ${expected}`);
  return value;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Only an absent `protocol` falls back to the legacy v1 path. `null`, a string
 * or a contradicting name/major means the backend is lying about its contract.
 */
function readProtocol(body: JsonObject): KBrainProtocolInfo | null {
  if (!("protocol" in body)) return null;
  const protocol = body.protocol;
  if (!isObject(protocol)) reject("protocol must be an object");
  if (protocol.name !== KBRAIN_PROTOCOL_NAME || protocol.major !== KBRAIN_PROTOCOL_MAJOR) {
    reject(
      `protocol ${String(protocol.name)}/${String(protocol.major)} contradicts ${KBRAIN_LEGACY_PROTOCOL_VERSION}`,
    );
  }
  if (!isNonNegativeInteger(protocol.minor))
    reject("protocol.minor must be a non-negative integer");
  return { name: KBRAIN_PROTOCOL_NAME, major: KBRAIN_PROTOCOL_MAJOR, minor: protocol.minor };
}

function readBuild(body: JsonObject): KBrainBuildInfo | null {
  const build = optional(body, "build", isObject, "an object");
  if (!build) return null;
  if (!isString(build.version) || !build.version.trim()) reject("build.version must be a string");
  const revision = optional(build, "revision", isString, "a string");
  const channel = optional(build, "channel", isString, "a string");
  return {
    version: build.version,
    ...(revision ? { revision } : {}),
    ...(channel ? { channel } : {}),
  };
}

export function parseKBrainHealth(body: unknown): KBrainHealth {
  if (!isObject(body)) reject("health body must be a JSON object");
  if (body.status !== "ok") reject(`status is ${JSON.stringify(body.status)}, not "ok"`);
  if (body.version !== KBRAIN_LEGACY_PROTOCOL_VERSION) {
    throw new KBrainHealthContractError(
      `K-brain backend protocol mismatch (reported version ${String(body.version)})`,
    );
  }
  const protocol = readProtocol(body);
  return {
    legacy: protocol === null,
    protocol: protocol ?? { name: KBRAIN_PROTOCOL_NAME, major: KBRAIN_PROTOCOL_MAJOR, minor: 0 },
    build: readBuild(body),
    startupContract: optional(
      body,
      "startupContract",
      isNonNegativeInteger,
      "a non-negative integer",
    ),
    instanceId: optional(body, "instanceId", isString, "a string"),
    capabilityRevision: optional(
      body,
      "capabilityRevision",
      isNonNegativeInteger,
      "a non-negative integer",
    ),
    capabilities: optional(body, "capabilities", isObject, "an object") ?? {},
  };
}

/**
 * Decodes the raw response bytes strictly before parsing. `Response.json()`
 * strips a BOM and replaces invalid UTF-8, which would let TS accept bodies the
 * Rust and Go hosts reject (RFC 8259 section 8.1).
 */
export async function readKBrainHealthResponse(response: Response): Promise<KBrainHealth> {
  // Read outside the try: an aborted or timed-out body keeps the caller's reason.
  const bytes = await response.arrayBuffer();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    reject("health body is not valid UTF-8");
  }
  if (text.charCodeAt(0) === 0xfeff) reject("health body starts with a byte order mark");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    reject("health body is not JSON");
  }
  return parseKBrainHealth(body);
}

/** Frozen historical capabilities (`session_queue`, `session_exists`, ...) are exactly 1. */
export function hasFrozenCapability(
  health: Pick<KBrainHealth, "capabilities">,
  name: string,
): boolean {
  return health.capabilities[name] === 1;
}

/** Monotonic integer capabilities such as `session_changes` compare with `>=`. */
export function capabilityAtLeast(
  health: Pick<KBrainHealth, "capabilities">,
  name: string,
  minimum: number,
): boolean {
  const value = health.capabilities[name];
  return isNonNegativeInteger(value) && value >= minimum;
}

export function supportsPermissionMode(
  health: Pick<KBrainHealth, "capabilities">,
  mode: string,
): boolean {
  const modes = health.capabilities.permission_modes;
  return Array.isArray(modes) && modes.includes(mode);
}
