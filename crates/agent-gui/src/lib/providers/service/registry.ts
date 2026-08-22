import type { LlmAdapter } from "./types";

/**
 * api → adapter 注册表。
 *
 * PR-1 的注册表是模块内静态注册（registerAdapter 仅供本目录的默认装配与
 * 测试使用），不提供运行期动态卸载——那是 PR-3 拦截器注册化的范畴。
 */
const adaptersByApi = new Map<string, LlmAdapter>();

export function registerAdapter(adapter: LlmAdapter): void {
  for (const api of adapter.apis) {
    const existing = adaptersByApi.get(api);
    if (existing && existing !== adapter) {
      throw new Error(`Duplicate LLM adapter registration for API: ${api}`);
    }
    adaptersByApi.set(api, adapter);
  }
}

/**
 * 解析一个 wire 协议的适配器。
 *
 * 未注册协议的错误文案与重构前 streamByApi.ts 的 default 分支逐字保持一致
 * （"Unsupported model API: ..."），错误路径也不漂移。
 */
export function resolveAdapter(api: string): LlmAdapter {
  const adapter = adaptersByApi.get(api);
  if (!adapter) {
    throw new Error(`Unsupported model API: ${api}`);
  }
  return adapter;
}

/** 已注册协议列表（测试用，按注册顺序）。 */
export function registeredApis(): string[] {
  return [...adaptersByApi.keys()];
}
