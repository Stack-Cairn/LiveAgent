import { useCallback, useRef } from "react";
import {
  type CustomProvider,
  type ResolvedProviderChatRoute,
  resolveProviderChatRoute,
} from "../../../lib/settings";

/**
 * 渲染期路由解析的 memo：按（供应商对象，模型 id）缓存 resolveProviderChatRoute
 * 的结果。供应商对象随 settings 整体替换，WeakMap 以对象身份为键即天然失效，
 * 与 useMemo([provider, modelId]) 同一口径——只是可以在按 Pane 循环的绑定构造
 * 里调用（那里不能再挂 Hook）。
 */
export function useProviderChatRouteMemo() {
  const cacheRef = useRef(new WeakMap<CustomProvider, Map<string, ResolvedProviderChatRoute>>());
  return useCallback((provider: CustomProvider, modelId: string): ResolvedProviderChatRoute => {
    let byModel = cacheRef.current.get(provider);
    if (!byModel) {
      byModel = new Map();
      cacheRef.current.set(provider, byModel);
    }
    const cached = byModel.get(modelId);
    if (cached) return cached;
    const route = resolveProviderChatRoute(provider, modelId);
    byModel.set(modelId, route);
    return route;
  }, []);
}
