import type { ProviderId } from "../../settings";
import { isRecord } from "./common";
import type { StreamOptionsEx } from "./types";

export function attachCodexResponsesStorage(
  providerId: ProviderId,
  options: StreamOptionsEx,
): StreamOptionsEx {
  const previousOnPayload = options.onPayload;

  // xai 走 xaiResponsesPayloadCompat 处理 store；此处仅 Codex 官方 Responses。
  if (providerId !== "codex") {
    return options;
  }

  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;

      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }

      if (model.api === "openai-responses" && isRecord(nextPayload)) {
        return {
          ...nextPayload,
          store: true,
        };
      }

      return nextPayload;
    },
  };
}
