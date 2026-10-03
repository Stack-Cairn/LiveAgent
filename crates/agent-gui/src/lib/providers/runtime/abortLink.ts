/**
 * 把多个（可缺省的）AbortSignal 合成一个：任一源中止即中止合成信号。
 *
 * 仓库约定不用 `AbortSignal.any`，统一走这里。只有一个有效源时直接
 * 返回它本身、不建新 controller；调用方在用完后必须调用 `cleanup` 摘掉挂在
 * 源信号上的监听，否则长寿命的父 signal 会一直攥着已结束的子 controller。
 */
export function createLinkedAbortSignal(signals: Array<AbortSignal | undefined>): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  const activeSignals = Array.from(
    new Set(signals.filter((signal): signal is AbortSignal => Boolean(signal))),
  );
  if (activeSignals.length <= 1) {
    return { signal: activeSignals[0], cleanup: () => undefined };
  }

  const controller = new AbortController();
  const cleanupFns: Array<() => void> = [];
  const cleanup = () => {
    while (cleanupFns.length > 0) {
      cleanupFns.pop()?.();
    }
  };
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
    cleanup();
  };

  for (const sourceSignal of activeSignals) {
    if (sourceSignal.aborted) {
      abort();
      break;
    }
    sourceSignal.addEventListener("abort", abort, { once: true });
    cleanupFns.push(() => sourceSignal.removeEventListener("abort", abort));
  }

  return { signal: controller.signal, cleanup };
}
