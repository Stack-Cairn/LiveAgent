import type { ProviderPayloadMiddleware } from "../runtime/payloadPipeline";

/**
 * 具名 payload 拦截器（PR-3 拦截器注册化）。
 *
 * name 是注册表内的唯一身份：顺序快照测试按名字逐一断言，同名重复注册
 * 抛错，dispose 按名字移除。intercept 即原 ProviderPayloadMiddleware——
 * 纯函数 (options, params) => options，注册化不改变中间件本身的契约。
 */
export type PayloadInterceptor = {
  readonly name: string;
  readonly intercept: ProviderPayloadMiddleware;
};

/**
 * 默认拦截器（现有 10 个中间件的具名包装，payloadPipeline.ts 模块初始化
 * 时一次性安装，顺序即原 finalizePayloadMiddlewares 数组顺序）。最后一个
 * 是钉住链尾的 payload-debug-logging。
 */
let defaultInterceptors: readonly PayloadInterceptor[] = [];

/** 自定义拦截器，按注册先后排列；执行位置在默认拦截器之后、链尾之前。 */
const customInterceptors: PayloadInterceptor[] = [];

/**
 * 组合结果缓存。finalizeProviderStreamOptions 在热路径上（agentRunner 每
 * 轮、textOnly 每次调用），注册/移除时失效重建，调用时零分配。
 */
let composedChain: ProviderPayloadMiddleware | undefined;

function invalidateComposedChain(): void {
  composedChain = undefined;
}

function hasInterceptorName(name: string): boolean {
  return (
    defaultInterceptors.some((entry) => entry.name === name) ||
    customInterceptors.some((entry) => entry.name === name)
  );
}

/**
 * 安装默认拦截器链。仅供 payloadPipeline.ts 模块初始化调用一次；重复安装
 * 抛错（防止测试加载器或 HMR 下的双重初始化悄悄改变链序）。
 */
export function installDefaultPayloadInterceptors(
  interceptors: readonly PayloadInterceptor[],
): void {
  if (defaultInterceptors.length > 0) {
    throw new Error("Default payload interceptors were already installed");
  }
  const seen = new Set<string>();
  for (const entry of interceptors) {
    if (seen.has(entry.name)) {
      throw new Error(`Duplicate default payload interceptor name: ${entry.name}`);
    }
    seen.add(entry.name);
  }
  defaultInterceptors = [...interceptors];
  invalidateComposedChain();
}

/**
 * 注册自定义拦截器，返回 dispose（幂等）。
 *
 * 执行顺序不变量：默认拦截器（除链尾）→ 自定义（按注册先后）→
 * payload-debug-logging 链尾。自定义改动因此仍被调试日志观测到。
 */
export function usePayloadInterceptor(interceptor: PayloadInterceptor): () => void {
  if (!interceptor.name) {
    throw new Error("PayloadInterceptor requires a non-empty name");
  }
  if (typeof interceptor.intercept !== "function") {
    throw new Error(`PayloadInterceptor "${interceptor.name}" requires an intercept function`);
  }
  if (hasInterceptorName(interceptor.name)) {
    throw new Error(`Payload interceptor is already registered: ${interceptor.name}`);
  }
  customInterceptors.push(interceptor);
  invalidateComposedChain();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const index = customInterceptors.indexOf(interceptor);
    if (index >= 0) {
      customInterceptors.splice(index, 1);
      invalidateComposedChain();
    }
  };
}

/** 当前生效的拦截器名字序列（执行顺序），供顺序快照测试与诊断。 */
export function listPayloadInterceptorNames(): readonly string[] {
  return orderedInterceptors().map((entry) => entry.name);
}

function orderedInterceptors(): readonly PayloadInterceptor[] {
  if (defaultInterceptors.length === 0) return [...customInterceptors];
  const head = defaultInterceptors.slice(0, -1);
  const tail = defaultInterceptors[defaultInterceptors.length - 1];
  return [...head, ...customInterceptors, tail];
}

/** 按执行顺序组合出的单一中间件；结果缓存至下一次注册/移除。 */
export function composePayloadInterceptorChain(): ProviderPayloadMiddleware {
  if (!composedChain) {
    const chain = orderedInterceptors();
    composedChain = (options, params) =>
      chain.reduce((next, entry) => entry.intercept(next, params), options);
  }
  return composedChain;
}
