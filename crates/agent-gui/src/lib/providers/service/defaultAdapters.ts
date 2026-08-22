import { deepSeekAdapter } from "./deepSeekAdapter";
import { piAiAdapter } from "./piAiAdapter";
import { registerAdapter } from "./registry";

let installed = false;

/**
 * 安装默认适配器（幂等）。
 *
 * 由分发针孔（runtime/streamByApi.ts 兼容壳）与 llm.stream() 各自在模块加载
 * 时调用：无论消费方从哪个入口进来，注册表都已就绪；重复调用零开销。
 */
export function ensureDefaultLlmAdapters(): void {
  if (installed) return;
  installed = true;
  registerAdapter(piAiAdapter);
  registerAdapter(deepSeekAdapter);
}
