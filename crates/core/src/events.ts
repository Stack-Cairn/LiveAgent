import { callBackend } from "./backendClient";
import type { WireEvent } from "./protocol/wireEvents";

export interface EventPayload {
  [key: string]: unknown;
}

export async function emitEvent(eventName: string, payload: EventPayload): Promise<void> {
  await callBackend<void>("engine_emit_event", {
    event: eventName,
    payload,
  });
}

/**
 * 唯一的事件出口。事件名就是 WireEvent 的 `type`,backend 原样扇出、前端按名
 * 订阅 —— 没有改名,也没有第二条路径。`type` 不进 payload:名字已经在信封上。
 */
export function emitWireEvent(event: WireEvent): void {
  const { type, ...payload } = event;
  void emitEvent(type, payload);
}
