import { callBackend } from "./backendClient";

export interface EventPayload {
  [key: string]: unknown;
}

export async function emitEvent(eventName: string, payload: EventPayload): Promise<void> {
  await callBackend<void>("emit_event", {
    event: eventName,
    payload,
  });
}

export async function listen(
  eventName: string,
  _callback?: (payload: EventPayload) => void,
): Promise<void> {
  // 在 Node 环境中，WS 监听由 Rust 后端通过 /api/events WebSocket 端点广播。
  // Node 代码如需接收事件，应该通过 HTTP 长轮询或改为调用 Rust 接口而不是监听。
  // 这个函数主要用作 API 兼容性占位。实际的事件流向是：
  // 1. Node 发送事件到 Rust：callBackend("emit_event", ...)
  // 2. Rust 通过 EventBus 广播给所有 WS 客户端（包括前端）
  console.warn(
    `listen() 在 Node 环境中不适用，应直接使用 emitEvent()。被请求的事件：${eventName}`,
  );

  // 不执行任何操作，这只是占位符
  return Promise.resolve();
}
