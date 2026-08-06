import { callBackend } from "./backendClient";

export interface EventPayload {
  [key: string]: unknown;
}

export async function emitEvent(eventName: string, payload: EventPayload): Promise<void> {
  await callBackend<void>("engine_emit_event", {
    event: eventName,
    payload,
  });
}
