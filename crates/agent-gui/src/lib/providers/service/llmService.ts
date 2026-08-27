import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { streamSimpleByApi } from "../runtime/streamByApi";
import { usePayloadInterceptor } from "./interceptors";
import type { LlmStreamRequest } from "./types";

/**
 * dev 构建探测。
 *
 * Vite 下 import.meta.env.DEV 为真；生产构建被静态替换为 false。Node 测试
 * 加载器（esbuild CJS 转译）中 import.meta 是空壳，可选链安全落到 false——
 * 测试如需覆盖冻结路径用 setLlmServiceDevModeForTest。
 */
function detectDevBuild(): boolean {
  try {
    return Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
}

let devModeOverride: boolean | undefined;

/** 测试专用：强制指定 dev 冻结开关（undefined 恢复自动探测）。 */
export function setLlmServiceDevModeForTest(value: boolean | undefined): void {
  devModeOverride = value;
}

function isDevBuild(): boolean {
  return devModeOverride ?? detectDevBuild();
}

/** 已分发过的请求信封——一次性分发不变量的记账。 */
const dispatchedRequests = new WeakSet<LlmStreamRequest>();

/**
 * LLM 统一流式入口。
 *
 * 职责被刻意压到最小（PR-1 行为等价不变量）：
 * 1. 一次性分发——同一请求信封重复分发抛错，杜绝"复用上一轮请求信封"这类
 *    隐性共享（重试/failover 的重放语义在适配器内部与调用方，不经此层）；
 * 2. dev 冻结——仅 dev 构建把信封冻住，让越过 seam 之后的信封突变当场以
 *    TypeError 暴露（ESM 严格模式）；生产构建零开销；
 * 3. 经 runtime/streamByApi.ts 协议分发针孔路由到注册表适配器。针孔是 seam
 *    的公开可观测点（传输 golden 与 failover 测试按该模块路径 mock 截获
 *    全部出站流），不得绕开。
 *
 * 传输路由字段（headers 内 x-liveagent-* 等）不透明透传：不读取、不判断、
 * 不缓存。
 */
export function llmStream(request: LlmStreamRequest): AssistantMessageEventStream {
  if (dispatchedRequests.has(request)) {
    throw new Error("LlmStreamRequest was already dispatched; build a fresh request per stream");
  }
  dispatchedRequests.add(request);
  if (isDevBuild()) {
    Object.freeze(request);
  }
  return streamSimpleByApi(request.model, request.context, request.options);
}

export const llm = {
  stream: llmStream,
  /**
   * 注册自定义 payload 拦截器（PR-3），返回幂等 dispose。执行位置在默认
   * 拦截器之后、payload-debug-logging 链尾之前。
   */
  use: usePayloadInterceptor,
};
