import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { ensureDefaultLlmAdapters } from "../service/defaultAdapters";
import { resolveAdapter } from "../service/registry";
import type { StreamOptionsEx } from "./types";

// 保证经本模块的任何调用（含被测试按路径 mock 后又还原的场景）注册表已就绪。
ensureDefaultLlmAdapters();

/**
 * 协议分发针孔（PR-1 seam 骨架）。
 *
 * 原五协议 switch 已搬移到 ../service/：pi-ai 四协议在 service/piAiAdapter.ts，
 * DeepSeek 原生在 service/deepSeekAdapter.ts；本函数只剩注册表路由一行，
 * 保留原签名、语义与 "Unsupported model API: ..." 错误文案。
 *
 * 统一入口 llm.stream()（service/llmService.ts）也经由本模块出站——传输
 * golden 与 failover 测试按本模块路径 mock 即可截获全部出站流，这一
 * 可观测点是 seam 的公开契约，后续 PR 不得绕开。
 */
export function streamSimpleByApi(model: Model<Api>, context: Context, options: StreamOptionsEx) {
  ensureDefaultLlmAdapters();
  return resolveAdapter(model.api).stream(model, context, options);
}
