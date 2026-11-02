import { abortError, ImageClientError, protocolError, responseError, safeInteger } from "./errors";
import type {
  ExportDestination,
  ExportResult,
  ImageEvent,
  ImageStudioClient,
  TargetVerificationAttempt,
  TargetVerificationReceipt,
  TargetVerificationRequest,
} from "./types";
import { IMAGE_WIRE_VERSION } from "./types";
import {
  array,
  bool,
  envelope,
  knownEvents,
  page,
  parseAsset,
  parseEvent,
  parseJob,
  parseJobEnvelope,
  parseProject,
  parseRequest,
  parseSettings,
  parseTarget,
  record,
  text,
} from "./wire";

export type ImageTransport = (path: string, init: RequestInit) => Promise<Response>;
export interface FetchTransportOptions {
  /** Backend/proxy root, never a provider URL. Kept fixed for this client's lifetime. */
  baseUrl: string;
  /** Resolve fresh backend authorization for each request; never puts tokens in URLs. */
  headers?: () => HeadersInit | Promise<HeadersInit>;
  fetch?: typeof globalThis.fetch;
  credentials?: RequestCredentials;
}
/** No write replay or credential refresh is performed by this transport. */
export function fetchTransport(options: FetchTransportOptions): ImageTransport {
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    throw new ImageClientError("IMAGE_INVALID_INPUT");
  }
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new ImageClientError("IMAGE_INVALID_INPUT");
  }
  const root = base.href.replace(/\/+$/, "");
  return async (path, init) => {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
      throw new ImageClientError("IMAGE_INVALID_INPUT");
    try {
      if (init.signal?.aborted) throw abortError();
      const headers = new Headers(await options.headers?.());
      new Headers(init.headers).forEach((value, key) => {
        headers.set(key, value);
      });
      if (init.body instanceof FormData) headers.delete("Content-Type");
      if (init.signal?.aborted) throw abortError();
      return await (options.fetch ?? globalThis.fetch)(`${root}${path}`, {
        ...init,
        headers,
        credentials: options.credentials ?? "omit",
        redirect: "error",
        cache: "no-store",
      });
    } catch {
      if (init.signal?.aborted) throw abortError();
      throw new ImageClientError("IMAGE_NETWORK_ERROR", 0, true);
    }
  };
}
export type ImageExportHandler = (id: string, signal?: AbortSignal) => Promise<ExportResult>;
export interface ImageStudioClientOptions {
  /** Host-scoped by verified owner, backend and workspace. No credentials. */
  verificationStorage?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
  transport: ImageTransport;
  /** Abort on backend/scope change and discard the client. The host owns Blob URL cleanup. */
  signal?: AbortSignal;
  imagePath?: string;
  healthPath?: string;
  /** An absent destination fails as unsupported; there is no fallback to download. */
  exports?: Partial<Record<ExportDestination, ImageExportHandler>>;
  /** Total retry budget for a subscription, including repeated successful but short streams. */
  reconnectDelaysMs?: readonly number[];
}

function parseVerificationInput(value: unknown): TargetVerificationRequest {
  const v = record(value);
  if (v.operation !== "generate" || v.count !== 1 || v.confirmPaid !== true) throw protocolError();
  return {
    expectedRevision: safeInteger(v.expectedRevision),
    projectId: text(v.projectId),
    connectionId: text(v.connectionId),
    remoteId: text(v.remoteId),
    targetRevision: safeInteger(v.targetRevision),
    operation: "generate",
    count: 1,
    prompt: text(v.prompt),
    confirmPaid: true,
  };
}

function parseVerification(value: unknown): TargetVerificationReceipt {
  const v = record(value);
  const result: TargetVerificationReceipt = {
    id: text(v.id),
    targetId: text(v.targetId),
    state: text(v.state),
    settingsRevision: safeInteger(v.settingsRevision),
  };
  if (!["pending", "verified", "failed", "unknown", "stale", "blocked"].includes(result.state))
    throw protocolError();
  if (v.jobId !== undefined) result.jobId = text(v.jobId);
  if (v.reason !== undefined) result.reason = text(v.reason);
  if (v.jobStatus !== undefined) {
    const status = text(v.jobStatus);
    if (
      ![
        "queued",
        "running",
        "saving",
        "succeeded",
        "partial_succeeded",
        "failed",
        "cancel_requested",
        "cancelled",
        "result_unknown",
      ].includes(status)
    )
      throw protocolError();
    result.jobStatus = status as NonNullable<TargetVerificationReceipt["jobStatus"]>;
  }
  // Job state remains optional: receipts may precede durable job acceptance.
  return result;
}

function linkedSignal(signals: (AbortSignal | undefined)[]) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const signal of signals) signal?.removeEventListener("abort", abort);
    },
  };
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
function segment(id: string): string {
  if (
    !id ||
    id === "." ||
    id === ".." ||
    [...id].some((char) => char.charCodeAt(0) <= 32 || "/\\?#".includes(char))
  )
    throw new ImageClientError("IMAGE_INVALID_INPUT");
  return encodeURIComponent(id);
}
function query(input: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value !== undefined) params.set(key, value);
  return params.size ? `?${params}` : "";
}
function jsonBody(value: unknown): Pick<RequestInit, "body" | "headers"> {
  try {
    return { body: JSON.stringify(value), headers: { "Content-Type": "application/json" } };
  } catch {
    throw new ImageClientError("IMAGE_INVALID_INPUT");
  }
}

export function createImageStudioClient(options: ImageStudioClientOptions): ImageStudioClient {
  const verificationMemory = new Map<string, string>();
  const journal = options.verificationStorage ?? {
    getItem: (key: string) => verificationMemory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      verificationMemory.set(key, value);
    },
  };
  const journalKey = (id: string) => `image-verification:v1:${segment(id)}`;
  function loadVerificationAttempt(id: string): TargetVerificationAttempt | null {
    if (options.signal?.aborted) throw abortError();
    try {
      const raw = journal.getItem(journalKey(id));
      if (!raw) return null;
      if (raw.length > 65536) throw protocolError();
      const v = record(JSON.parse(raw));
      if (v.version !== 1 || v.targetId !== id) throw protocolError();
      const key = text(v.key);
      if (!key || key.length > 256 || /[^\x21-\x7e]/.test(key)) throw protocolError();
      const result: TargetVerificationAttempt = { key, input: parseVerificationInput(v.input) };
      if (v.receipt !== undefined) {
        result.receipt = parseVerification(v.receipt);
        if (result.receipt.targetId !== id) throw protocolError();
      }
      return result;
    } catch {
      throw new ImageClientError("IMAGE_VERIFICATION_STORAGE_UNAVAILABLE");
    }
  }
  function saveVerificationAttempt(id: string, attempt: TargetVerificationAttempt) {
    if (options.signal?.aborted) throw abortError();
    try {
      const raw = JSON.stringify({
        version: 1,
        targetId: id,
        key: attempt.key,
        input: attempt.input,
        receipt: attempt.receipt,
      });
      if (raw.length > 65536) throw protocolError();
      journal.setItem(journalKey(id), raw);
      if (journal.getItem(journalKey(id)) !== raw) throw protocolError();
    } catch {
      throw new ImageClientError("IMAGE_VERIFICATION_STORAGE_UNAVAILABLE");
    }
  }
  function rememberVerificationReceipt(
    targetId: string,
    receipt: TargetVerificationReceipt,
    key?: string,
  ) {
    if (receipt.targetId !== targetId) throw protocolError();
    const attempt = loadVerificationAttempt(targetId);
    if (attempt && (key !== undefined ? key === attempt.key : attempt.receipt?.id === receipt.id)) {
      attempt.receipt = receipt;
      saveVerificationAttempt(targetId, attempt);
    }
    return receipt;
  }
  const settingsSavedListeners = new Set<() => void>();
  options.signal?.addEventListener("abort", () => settingsSavedListeners.clear(), { once: true });
  const imagePath = (options.imagePath ?? "/v1/image").replace(/\/+$/, "");
  const healthPath = options.healthPath ?? "/v1/health";
  const reconnectDelays = [...(options.reconnectDelaysMs ?? [1000, 2000, 4000, 8000, 15000])];
  if (
    reconnectDelays.length > 5 ||
    reconnectDelays.some((ms) => !Number.isFinite(ms) || ms < 0 || ms > 15000)
  ) {
    throw new ImageClientError("IMAGE_INVALID_INPUT");
  }
  async function scoped<T>(
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const linked = linkedSignal([options.signal, signal]);
    try {
      if (linked.signal.aborted) throw abortError();
      const value = await run(linked.signal);
      if (linked.signal.aborted) throw abortError();
      return value;
    } catch (error) {
      if (linked.signal.aborted) throw abortError();
      if (error instanceof ImageClientError) throw error;
      throw new ImageClientError("IMAGE_NETWORK_ERROR", 0, true);
    } finally {
      linked.dispose();
    }
  }
  async function send(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await options.transport(path, { ...init, signal });
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (error instanceof ImageClientError) throw error;
      throw new ImageClientError("IMAGE_NETWORK_ERROR", 0, true);
    }
    if (signal.aborted) {
      try {
        await response.body?.cancel();
      } catch {
        /* The host may have already closed it. */
      }
      throw abortError();
    }
    if (!response.ok) throw await responseError(response);
    return response;
  }
  async function readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw protocolError(response.status);
    }
  }
  async function json(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return scoped(signal, async (active) =>
      envelope(
        await readJson(
          await send(
            `${imagePath}${path}`,
            {
              ...init,
              headers: {
                Accept: "application/json",
                ...Object.fromEntries(new Headers(init.headers)),
              },
            },
            active,
          ),
        ),
      ),
    );
  }
  return {
    capabilities: () =>
      scoped(undefined, async (signal) => {
        const response = await send(
          healthPath,
          { headers: { Accept: "application/json" } },
          signal,
        );
        const health = record(await readJson(response));
        if (health.capabilities === undefined) {
          // Require a recognizable health response, not an arbitrary 200 JSON object.
          if (typeof health.status !== "string") throw protocolError();
          return { supported: false };
        }
        const capabilities = record(health.capabilities);
        if (capabilities.image === undefined) return { supported: false };
        const image = record(capabilities.image);
        const supported = bool(image.supported);
        const version = image.version === undefined ? undefined : text(image.version);
        if (supported && version !== IMAGE_WIRE_VERSION) throw protocolError();
        return { supported, ...(version === undefined ? {} : { version }) };
      }),
    hasVerificationPersistence: () => options.verificationStorage !== undefined,
    loadVerificationAttempt,
    clearVerificationAttempt: (targetId) => {
      const attempt = loadVerificationAttempt(targetId);
      if (!attempt) return;
      if (
        !attempt.receipt ||
        attempt.receipt.state === "unknown" ||
        (attempt.receipt.state !== "verified" &&
          !["failed", "succeeded", "partial_succeeded", "cancelled"].includes(
            attempt.receipt.jobStatus ?? "",
          ))
      )
        throw new ImageClientError("IMAGE_RESULT_UNKNOWN");
      try {
        journal.setItem(journalKey(targetId), "");
        if (journal.getItem(journalKey(targetId))) throw protocolError();
      } catch {
        throw new ImageClientError("IMAGE_VERIFICATION_STORAGE_UNAVAILABLE");
      }
    },
    startTargetVerification: async (targetId, input, key) => {
      if (
        !input.confirmPaid ||
        input.operation !== "generate" ||
        input.count !== 1 ||
        !input.prompt.trim() ||
        !key ||
        key.length > 256 ||
        /[^\x21-\x7e]/.test(key)
      )
        throw new ImageClientError("IMAGE_INVALID_INPUT");
      const request = parseVerificationInput(input);
      const old = loadVerificationAttempt(targetId);
      if (old && (old.key !== key || JSON.stringify(old.input) !== JSON.stringify(request)))
        throw new ImageClientError("IMAGE_IDEMPOTENCY_CONFLICT", 409);
      const attempt: TargetVerificationAttempt = old ?? { key, input: request };
      // Persist before sending any potentially billable request.
      saveVerificationAttempt(targetId, attempt);
      const receipt = parseVerification(
        (
          await json(`/targets/${segment(targetId)}/verify`, {
            method: "POST",
            ...jsonBody(request),
            headers: { "Content-Type": "application/json", "X-Idempotency-Key": key },
          })
        ).verification,
      );
      if (receipt.targetId !== targetId) throw protocolError();
      attempt.receipt = receipt;
      saveVerificationAttempt(targetId, attempt);
      return receipt;
    },
    getTargetVerificationByKey: async (targetId, key) => {
      if (!key || key.length > 256 || /[^\x21-\x7e]/.test(key))
        throw new ImageClientError("IMAGE_INVALID_INPUT");
      const receipt = parseVerification(
        (
          await json(`/targets/${segment(targetId)}/verifications/by-key`, {
            headers: { "X-Idempotency-Key": key },
          })
        ).verification,
      );
      return rememberVerificationReceipt(targetId, receipt, key);
    },
    getTargetVerification: async (targetId, receiptId) => {
      const receipt = parseVerification(
        (await json(`/targets/${segment(targetId)}/verifications/${segment(receiptId)}`))
          .verification,
      );
      if (receipt.id !== receiptId) throw protocolError();
      return rememberVerificationReceipt(targetId, receipt);
    },
    listTargets: async () => array(parseTarget)((await json("/targets")).items),
    getSettings: async () => {
      const value = await json("/settings");
      return parseSettings(value.settings ?? value);
    },
    subscribeSettingsSaved: (listener) => {
      if (!options.signal?.aborted) settingsSavedListeners.add(listener);
      return () => {
        settingsSavedListeners.delete(listener);
      };
    },
    saveSettings: async (input) => {
      safeInteger(input.expectedRevision);
      const value = await json("/settings", {
        method: "PUT",
        ...jsonBody({
          expectedRevision: input.expectedRevision,
          connections: input.connections,
          targets: input.targets,
        }),
      });
      const settings = parseSettings(value.settings ?? value);
      for (const listener of settingsSavedListeners) {
        try {
          listener();
        } catch {
          // An observer cannot turn a confirmed save into an ambiguous write failure.
        }
      }
      return settings;
    },
    writeSecret: async (input) => {
      const value = await json("/secrets", {
        method: "POST",
        ...jsonBody({
          connectionId: input.connectionId,
          purpose: input.purpose,
          value: input.value,
        }),
      });
      // No retained draft, secret input, or raw response.
      return { ref: text(value.ref), configured: bool(value.configured) };
    },
    listProjects: async (cursor) => page(await json(`/projects${query({ cursor })}`), parseProject),
    createProject: async (title, workspaceRef) =>
      parseProject(
        (
          await json("/projects", {
            method: "POST",
            ...jsonBody({ title, workspaceRef }),
          })
        ).project,
      ),
    updateProject: async (id, title, expectedRevision) => {
      safeInteger(expectedRevision);
      return parseProject(
        (
          await json(`/projects/${segment(id)}`, {
            method: "PATCH",
            ...jsonBody({ title, expectedRevision }),
          })
        ).project,
      );
    },
    deleteProject: (id) =>
      scoped(undefined, async (signal) => {
        const response = await send(
          `${imagePath}/projects/${segment(id)}`,
          { method: "DELETE" },
          signal,
        );
        if (response.status !== 204) envelope(await readJson(response));
      }),
    upload: async (file, name, signal) => {
      const form = new FormData();
      form.append("file", file, name);
      return parseAsset((await json("/assets", { method: "POST", body: form }, signal)).asset);
    },
    createJob: async (input, key) => {
      if (!key || [...key].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127))
        throw new ImageClientError("IMAGE_INVALID_INPUT");
      const request = jsonBody(parseRequest(input));
      const value = await json("/jobs", {
        method: "POST",
        ...request,
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      });
      bool(value.replayed);
      return parseJobEnvelope(value);
    },
    getJob: async (id) => parseJobEnvelope(await json(`/jobs/${segment(id)}`)),
    listJobs: async (projectId, cursor) =>
      page(await json(`/jobs${query({ projectId, cursor })}`), parseJob),
    cancelJob: async (id) =>
      parseJobEnvelope(await json(`/jobs/${segment(id)}/cancel`, { method: "POST" })),
    deleteJob: async (id) => {
      await json(`/jobs/${segment(id)}`, { method: "DELETE" });
    },
    subscribe: (id, afterSeq, onEvent, signal) =>
      scoped(signal, async (active) => {
        let lastSeq = safeInteger(afterSeq);
        let retries = 0;
        while (!active.aborted) {
          try {
            const response = await send(
              `${imagePath}/jobs/${segment(id)}/events`,
              {
                headers: { Accept: "text/event-stream", "Last-Event-ID": String(lastSeq) },
              },
              active,
            );
            if (
              response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !==
                "text/event-stream" ||
              !response.body
            ) {
              await response.body?.cancel();
              throw protocolError();
            }
            const finished = await consumeEvents(response.body, active, (event) => {
              if (event.jobId !== id) throw protocolError();
              if (event.seq <= lastSeq) return false;
              lastSeq = event.seq; // Unknown event types also advance the reconnect cursor.
              if (knownEvents.has(event.type)) {
                try {
                  onEvent(event);
                } catch {
                  throw new ImageClientError("IMAGE_CALLBACK_FAILED");
                }
              }
              return event.type === "job.finished";
            });
            if (finished) return;
            throw new ImageClientError("IMAGE_STREAM_ENDED", 0, true);
          } catch (error) {
            if (active.aborted) throw abortError();
            const failure =
              error instanceof ImageClientError
                ? error
                : new ImageClientError("IMAGE_NETWORK_ERROR", 0, true);
            // Gaps, authentication, bad protocol and all other 4xx go to the host; never loop on them.
            const retryable =
              failure.retryable &&
              (failure.status === 0 || failure.status === 429 || failure.status >= 500);
            if (!retryable || retries >= reconnectDelays.length) throw failure;
            await delay(reconnectDelays[retries++], active);
          }
        }
        throw abortError();
      }),
    readAsset: (id, variant, signal) =>
      scoped(signal, async (active) => {
        if (variant !== "original" && variant !== "thumbnail")
          throw new ImageClientError("IMAGE_INVALID_INPUT");
        const response = await send(
          `${imagePath}/assets/${segment(id)}/content${query({ variant })}`,
          {
            headers: { Accept: "image/png, image/jpeg, image/webp" },
          },
          active,
        );
        const mime = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
        if (!mime || !["image/png", "image/jpeg", "image/webp"].includes(mime)) {
          await response.body?.cancel();
          throw protocolError();
        }
        return response.blob();
      }),
    exportAsset: (id, destination) =>
      scoped(undefined, async (signal) => {
        segment(id);
        const handler = options.exports?.[destination];
        if (!handler) throw new ImageClientError("IMAGE_UNSUPPORTED_OPERATION");
        try {
          return { saved: bool((await handler(id, signal)).saved) };
        } catch {
          if (signal.aborted) throw abortError();
          throw new ImageClientError("IMAGE_EXPORT_FAILED");
        }
      }),
  };
}

/** Incremental SSE framing: UTF-8, CR/LF/CRLF, comments, multiline data and bounded frames. */
async function consumeEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: ImageEvent) => boolean,
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const limit = 1024 * 1024;
  let line = "";
  let skipLF = false;
  let data: string[] = [];
  let size = 0;
  let id: string | undefined;
  let eventName = "";
  let finished = false;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const finishLine = () => {
    if (line !== "") {
      size += line.length + 1;
      if (size > limit) throw protocolError();
    }
    if (line === "") {
      if (data.length && (eventName === "" || eventName === "image.event")) {
        let value: unknown;
        try {
          value = JSON.parse(data.join("\n"));
        } catch {
          throw protocolError();
        }
        const event = parseEvent(value);
        if (id === undefined || !/^(0|[1-9]\d*)$/.test(id) || safeInteger(Number(id)) !== event.seq)
          throw protocolError();
        finished = onEvent(event);
      }
      data = [];
      size = 0;
      id = undefined;
      eventName = "";
    } else if (!line.startsWith(":")) {
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data.push(value);
      else if (field === "id" && !value.includes("\0")) id = value;
      else if (field === "event") eventName = value;
    }
    line = "";
  };
  const feed = (chunk: string) => {
    for (const char of chunk) {
      if (signal.aborted) throw abortError();
      if (finished) break;
      if (skipLF) {
        skipLF = false;
        if (char === "\n") continue;
      }
      if (char === "\r" || char === "\n") {
        finishLine();
        skipLF = char === "\r";
      } else {
        line += char;
        if (line.length > limit) throw protocolError();
      }
    }
  };
  try {
    if (signal.aborted) throw abortError();
    while (!finished) {
      const next = await reader.read();
      if (signal.aborted) throw abortError();
      let decoded: string;
      try {
        decoded = decoder.decode(next.value, { stream: !next.done });
      } catch {
        throw protocolError();
      }
      feed(decoded);
      if (next.done) break; // Unterminated data is replayed, never acknowledged.
    }
    return finished;
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      await reader.cancel();
    } catch {
      /* Already closed or errored. */
    }
    reader.releaseLock();
  }
}
