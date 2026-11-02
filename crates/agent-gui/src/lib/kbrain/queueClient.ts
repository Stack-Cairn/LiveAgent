import type { ChatQueueSnapshot } from "@liveagent/ui/contracts/chatQueue";
import { fetchKBrain, KBrainTransportError } from "./transport";
import {
  KBRAIN_PROTOCOL_VERSION,
  type KBrainClientOptions,
  type KBrainPromptRequest,
  type KBrainRunAccepted,
} from "./types";

export type KBrainQueueReceipt = {
  id: string;
  state: string;
  error?: string;
  run?: KBrainRunAccepted;
};

export type KBrainQueueResponse = {
  version: typeof KBRAIN_PROTOCOL_VERSION;
  accepted: boolean;
  errorCode?: string;
  message?: string;
  snapshot: ChatQueueSnapshot;
  receipt?: KBrainQueueReceipt;
  item?: ChatQueueSnapshot["items"][number] & {
    request: KBrainPromptRequest;
    draftJson: string;
    uploadedFilesJson: string;
  };
};

export type KBrainQueueSubmit = {
  request: KBrainPromptRequest;
  policy?: "auto" | "append" | "interrupt";
  source?: "gui" | "webui";
  draft_json?: string;
  uploaded_files_json?: string;
};

export type KBrainQueueAction = {
  action:
    | "pause"
    | "resume"
    | "get_item"
    | "move"
    | "remove"
    | "edit_begin"
    | "edit_commit"
    | "edit_cancel"
    | "run_now";
  revision: number;
  item_id?: string;
  direction?: "up" | "down";
  request?: KBrainPromptRequest;
  draft_json?: string;
  uploaded_files_json?: string;
};

export function createKBrainQueueClient(options: KBrainClientOptions) {
  async function queueRequest(
    conversationId: string,
    suffix: string,
    init: RequestInit = {},
  ): Promise<KBrainQueueResponse> {
    const response = await fetchKBrain(
      `/v1/sessions/${encodeURIComponent(conversationId)}/queue${suffix}`,
      init,
      options,
    );
    let body: KBrainQueueResponse & { error?: string };
    try {
      body = await response.json();
    } catch (error) {
      if (!response.ok)
        throw Object.assign(new Error(`K-brain queue request failed (${response.status})`), {
          status: response.status,
        });
      if (error instanceof SyntaxError) throw new Error("Malformed K-brain queue response");
      throw new KBrainTransportError(error);
    }
    const snapshot = body?.snapshot;
    if (!response.ok && typeof body?.errorCode !== "string") {
      throw Object.assign(
        new Error(body?.error || `K-brain queue request failed (${response.status})`),
        { status: response.status },
      );
    }
    if (
      body?.version !== KBRAIN_PROTOCOL_VERSION ||
      typeof body.accepted !== "boolean" ||
      snapshot?.conversationId !== conversationId ||
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 0 ||
      typeof snapshot.paused !== "boolean" ||
      !Array.isArray(snapshot.items)
    ) {
      throw new Error("Malformed K-brain queue response");
    }
    if (
      body.receipt &&
      (typeof body.receipt.id !== "string" ||
        !body.receipt.id ||
        typeof body.receipt.state !== "string" ||
        !body.receipt.state)
    ) {
      throw new Error("Malformed K-brain queue receipt");
    }
    if (
      snapshot.items.some(
        (item) =>
          !item || typeof item.id !== "string" || !item.id || typeof item.previewText !== "string",
      )
    ) {
      throw new Error("Malformed K-brain queue item");
    }
    if (body.receipt?.run) {
      const run = body.receipt.run;
      if (
        run.version !== KBRAIN_PROTOCOL_VERSION ||
        run.conversation_id !== conversationId ||
        typeof run.run_id !== "string" ||
        !run.run_id ||
        !Number.isSafeInteger(run.accepted_seq) ||
        run.accepted_seq < 1
      ) {
        throw new Error("Malformed K-brain queue run identity");
      }
    }
    return body as KBrainQueueResponse;
  }

  function getQueue(conversationId: string, signal?: AbortSignal) {
    return queueRequest(conversationId, "", { signal });
  }

  function lookupQueueReceipt(
    conversationId: string,
    clientRequestId: string,
    signal?: AbortSignal,
  ) {
    return queueRequest(
      conversationId,
      `?client_request_id=${encodeURIComponent(clientRequestId)}`,
      { signal },
    );
  }

  function waitQueue(conversationId: string, revision: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid queue revision");
    return queueRequest(conversationId, `?wait=1&after_revision=${revision}`, { signal });
  }

  async function submitQueue(input: KBrainQueueSubmit, signal?: AbortSignal) {
    if (!input.request.conversation_id.trim() || !input.request.client_request_id.trim()) {
      throw new Error("Queue submission requires conversation and client request IDs");
    }
    try {
      return await queueRequest(input.request.conversation_id, "", {
        method: "POST",
        body: JSON.stringify(input),
        signal,
      });
    } catch (error) {
      if (!(error instanceof KBrainTransportError) && !signal?.aborted) throw error;
      // Acceptance outlives the connection. Query its identity, never repeat POST.
      try {
        return await lookupQueueReceipt(
          input.request.conversation_id,
          input.request.client_request_id,
          AbortSignal.timeout(5000),
        );
      } catch {
        if (signal?.aborted) throw signal.reason;
        throw error;
      }
    }
  }

  function queueAction(conversationId: string, action: KBrainQueueAction, signal?: AbortSignal) {
    if (!Number.isSafeInteger(action.revision) || action.revision < 0)
      throw new Error("Invalid queue revision");
    return queueRequest(conversationId, "/actions", {
      method: "POST",
      body: JSON.stringify(action),
      signal,
    });
  }

  return { getQueue, lookupQueueReceipt, waitQueue, submitQueue, queueAction };
}
