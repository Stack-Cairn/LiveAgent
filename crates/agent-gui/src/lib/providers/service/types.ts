import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
} from "@liveagent/app/lib/agentTypes";
import type { StreamRetryConfig } from "../runtime/streamRetry";
import type { StreamOptionsEx } from "../runtime/types";

export type LlmStreamRequest = {
  model: Model<Api>;
  context: Context;
  options: StreamOptionsEx;
};

export type LlmAdapter = {
  readonly apis: readonly string[];
  stream(
    model: Model<Api>,
    context: Context,
    options: StreamOptionsEx,
  ): AssistantMessageEventStream;
  resolveModel?(model: Model<Api>): Model<Api>;
  retryPolicy?(model: Model<Api>): StreamRetryConfig | undefined;
};
