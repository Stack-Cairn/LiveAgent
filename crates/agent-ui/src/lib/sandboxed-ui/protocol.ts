// Host side of the postMessage JSON-RPC 2.0 bridge shared by plugin panels and MCP App
// views (K-brain docs/sandboxed-ui.md). Pages run in an opaque-origin sandbox, so every
// message is untrusted: the frame listener checks `event.source`, this module checks the
// shape, size and rate, and only allowlisted methods ever reach a handler.

/** The only sandbox token any LiveAgent-rendered page gets. Never add allow-same-origin. */
export const SANDBOXED_UI_SANDBOX = "allow-scripts";

export const SANDBOXED_UI_MAX_MESSAGE_BYTES = 1024 * 1024;
export const SANDBOXED_UI_MAX_REQUESTS_PER_SECOND = 20;

export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const SANDBOXED_UI_EXECUTION_FAILED = -32000;
export const SANDBOXED_UI_DENIED = -32001;
export const SANDBOXED_UI_NOT_ALLOWED = -32002;
export const SANDBOXED_UI_LIMIT_EXCEEDED = -32003;

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcErrorObject = { code: number; message: string; data?: unknown };

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: JsonRpcErrorObject };

export type ParsedJsonRpcMessage =
  | { kind: "request"; message: JsonRpcRequest }
  | { kind: "notification"; message: JsonRpcNotification }
  | { kind: "response"; message: JsonRpcResponse };

/** A handler failure that maps to a JSON-RPC error code the page can act on. */
export class SandboxedUiError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "SandboxedUiError";
    this.code = code;
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (
    (typeof value === "string" && value.length <= 256) ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** Ids of messages too large or too frequent to parse fully, so the error can still be addressed. */
export function readJsonRpcRequestId(data: unknown): JsonRpcId | undefined {
  if (!isPlainRecord(data) || data.jsonrpc !== "2.0" || typeof data.method !== "string") {
    return undefined;
  }
  return isJsonRpcId(data.id) ? data.id : undefined;
}

/** Classifies a structured-clone message; anything that is not JSON-RPC 2.0 is null. */
export function parseJsonRpcMessage(data: unknown): ParsedJsonRpcMessage | null {
  if (!isPlainRecord(data) || data.jsonrpc !== "2.0") return null;
  const hasId = "id" in data && data.id !== undefined;
  if (typeof data.method === "string") {
    if (!data.method || data.method.length > 128) return null;
    if (hasId) {
      if (!isJsonRpcId(data.id)) return null;
      return {
        kind: "request",
        message: { jsonrpc: "2.0", id: data.id, method: data.method, params: data.params },
      };
    }
    return {
      kind: "notification",
      message: { jsonrpc: "2.0", method: data.method, params: data.params },
    };
  }
  if (!hasId || !isJsonRpcId(data.id)) return null;
  if ("result" in data) {
    return { kind: "response", message: { jsonrpc: "2.0", id: data.id, result: data.result } };
  }
  if (isPlainRecord(data.error) && typeof data.error.code === "number") {
    return {
      kind: "response",
      message: {
        jsonrpc: "2.0",
        id: data.id,
        error: {
          code: data.error.code,
          message: typeof data.error.message === "string" ? data.error.message : "",
        },
      },
    };
  }
  return null;
}

const MAX_ESTIMATE_DEPTH = 64;

/**
 * Approximate serialized size of a structured-clone value, stopping as soon as it passes
 * `limit` so a hostile page cannot make the host walk a huge payload. Cycles and values
 * nested deeper than 64 levels count as over the limit.
 */
export function estimateMessageBytes(value: unknown, limit = SANDBOXED_UI_MAX_MESSAGE_BYTES) {
  let total = 0;
  const over = limit + 1;
  const seen = new Set<object>();
  const visit = (current: unknown, depth: number): boolean => {
    if (total > limit) return false;
    if (depth > MAX_ESTIMATE_DEPTH) {
      total = over;
      return false;
    }
    if (current === null || current === undefined) {
      total += 4;
      return true;
    }
    switch (typeof current) {
      case "string":
        // UTF-8 bytes are at most 3x the UTF-16 length; count the worst case cheaply.
        total += current.length * 3 + 2;
        return total <= limit;
      case "number":
      case "bigint":
        total += 24;
        return true;
      case "boolean":
        total += 5;
        return true;
      case "object":
        break;
      default:
        total += 8;
        return true;
    }
    const object = current as object;
    if (seen.has(object)) {
      total = over;
      return false;
    }
    seen.add(object);
    if (ArrayBuffer.isView(object)) {
      total += object.byteLength;
      return total <= limit;
    }
    if (object instanceof ArrayBuffer) {
      total += object.byteLength;
      return total <= limit;
    }
    if (typeof Blob !== "undefined" && object instanceof Blob) {
      total += object.size;
      return total <= limit;
    }
    if (object instanceof Map || object instanceof Set) {
      for (const entry of object instanceof Map ? object.entries() : object.values()) {
        if (!visit(entry, depth + 1)) return false;
      }
      return true;
    }
    if (Array.isArray(object)) {
      total += 2;
      for (const item of object) {
        if (!visit(item, depth + 1)) return false;
      }
      return true;
    }
    total += 2;
    for (const key of Object.keys(object)) {
      total += key.length * 3 + 3;
      if (!visit((object as Record<string, unknown>)[key], depth + 1)) return false;
    }
    return true;
  };
  visit(value, 0);
  return total;
}

/** Sliding one-second window: at most `limit` accepted calls per window. */
export function createRateLimiter(
  limit = SANDBOXED_UI_MAX_REQUESTS_PER_SECOND,
  windowMs = 1000,
  now: () => number = () => Date.now(),
) {
  const stamps: number[] = [];
  return {
    take(): boolean {
      const at = now();
      while (stamps.length && at - stamps[0] >= windowMs) stamps.shift();
      if (stamps.length >= limit) return false;
      stamps.push(at);
      return true;
    },
  };
}

export type SandboxedUiMethodHandler = (params: unknown) => unknown | Promise<unknown>;

export type SandboxedUiBridgeOptions = {
  /** Posts to the frame's contentWindow with target origin "*". */
  post: (message: JsonRpcResponse | JsonRpcNotification) => void;
  /** The allowlist: only these methods are answered; everything else is -32601. */
  methods: Readonly<Record<string, SandboxedUiMethodHandler>>;
  /** Page notifications the host listens to (others are dropped). */
  notifications?: Readonly<Record<string, (params: unknown) => void>>;
  maxMessageBytes?: number;
  maxRequestsPerSecond?: number;
  now?: () => number;
};

export type SandboxedUiBridge = {
  /** Feeds one `message` event payload whose `event.source` was already verified. */
  receive: (data: unknown) => void;
  /** Sends a host notification; dropped after dispose. */
  notify: (method: string, params?: unknown) => void;
  /** Drops pending requests: their answers are never posted. */
  dispose: () => void;
  readonly disposed: boolean;
};

export function createSandboxedUiBridge(options: SandboxedUiBridgeOptions): SandboxedUiBridge {
  const maxBytes = options.maxMessageBytes ?? SANDBOXED_UI_MAX_MESSAGE_BYTES;
  const limiter = createRateLimiter(
    options.maxRequestsPerSecond ?? SANDBOXED_UI_MAX_REQUESTS_PER_SECOND,
    1000,
    options.now,
  );
  let disposed = false;

  const send = (message: JsonRpcResponse | JsonRpcNotification) => {
    if (disposed) return;
    try {
      options.post(message);
    } catch {
      // The frame went away between the check and the post.
    }
  };
  const fail = (id: JsonRpcId, code: number, message: string) =>
    send({ jsonrpc: "2.0", id, error: { code, message } });

  const receive = (data: unknown) => {
    if (disposed) return;
    if (estimateMessageBytes(data, maxBytes) > maxBytes) {
      const id = readJsonRpcRequestId(data);
      if (id !== undefined) fail(id, SANDBOXED_UI_LIMIT_EXCEEDED, "Message too large");
      return;
    }
    const parsed = parseJsonRpcMessage(data);
    if (!parsed || parsed.kind === "response") return;
    if (!limiter.take()) {
      if (parsed.kind === "request") {
        fail(parsed.message.id, SANDBOXED_UI_LIMIT_EXCEEDED, "Too many requests");
      }
      return;
    }
    if (parsed.kind === "notification") {
      const listener = Object.hasOwn(options.notifications ?? {}, parsed.message.method)
        ? options.notifications?.[parsed.message.method]
        : undefined;
      try {
        listener?.(parsed.message.params);
      } catch {
        // A notification has no answer; a failing listener is simply ignored.
      }
      return;
    }
    const { id, method, params } = parsed.message;
    const handler = Object.hasOwn(options.methods, method) ? options.methods[method] : undefined;
    if (!handler) {
      fail(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
      return;
    }
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(handler(params));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (result) => send({ jsonrpc: "2.0", id, result: result === undefined ? null : result }),
      (error: unknown) => {
        if (error instanceof SandboxedUiError) fail(id, error.code, error.message);
        else
          fail(
            id,
            SANDBOXED_UI_EXECUTION_FAILED,
            error instanceof Error && error.message ? error.message : "Execution failed",
          );
      },
    );
  };

  return {
    receive,
    notify(method, params) {
      send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
    },
    dispose() {
      disposed = true;
    },
    get disposed() {
      return disposed;
    },
  };
}

/**
 * Wires a window `message` listener to a bridge: only messages whose `event.source` is the
 * frame's own contentWindow are passed on (`event.origin` is always "null" for an opaque
 * sandbox and proves nothing). Returns the unsubscribe function.
 */
export function listenToSandboxedFrame(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  getFrameWindow: () => unknown,
  receive: (data: unknown) => void,
): () => void {
  const onMessage = (event: MessageEvent) => {
    const frameWindow = getFrameWindow();
    if (!frameWindow || event.source !== frameWindow) return;
    receive(event.data);
  };
  target.addEventListener("message", onMessage as EventListener);
  return () => target.removeEventListener("message", onMessage as EventListener);
}
