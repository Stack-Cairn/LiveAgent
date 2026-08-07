import { callBackend } from "./backendClient";
import type { WireEvent } from "./protocol/wireEvents";

export interface EventPayload {
  [key: string]: unknown;
}

// 串行化队列：每个 HTTP POST 必须等前一个完成后再发，防止并发请求乱序到达 backend。
let eventQueue: Promise<void> = Promise.resolve();

export async function emitEvent(eventName: string, payload: EventPayload): Promise<void> {
  await callBackend<void>("engine_emit_event", {
    event: eventName,
    payload,
  });
}

/**
 * 唯一的事件出口。事件名就是 WireEvent 的 `type`,backend 原样扇出、前端按名
 * 订阅 —— 没有改名,也没有第二条路径。`type` 不进 payload:名字已经在信封上。
 *
 * 事件经链式 Promise 串行发送：前一个 HTTP POST 完成后才发下一个，保证 backend
 * 收到的事件顺序与 Node 侧发射顺序一致。错误不中断队列——吞掉后继续处理后续事件。
 */
export function emitWireEvent(event: WireEvent): void {
  const { type, ...payload } = event;
  eventQueue = eventQueue.then(
    () => emitEvent(type, payload),
    () => emitEvent(type, payload),
  );
}
