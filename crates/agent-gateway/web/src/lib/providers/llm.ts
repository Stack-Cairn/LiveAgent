import type { SharedModelOption } from "@liveagent/ui/lib/models/modelOptions";
import type { ProviderId } from "../settings";

export type ModelOption = SharedModelOption<ProviderId>;
export { parseModelValue, toModelValue } from "@liveagent/ui/lib/models/modelValue";
export {
  assistantMessageToText,
  normalizeErrorMessage,
} from "@liveagent/ui/lib/providers/errorMessage";
