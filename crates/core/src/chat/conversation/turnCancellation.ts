export type TurnCancellationScope = {
  controller: AbortController;
  release: () => void;
};

export type TurnCancellation = {
  // 整轮的用户停止意图。会话的 abort controller 只注册它一次、永不换代，
  // 停止请求不会再落进"abort 后、新 controller 注册前"的窗口。
  userStop: AbortController;
  deriveScope: () => TurnCancellationScope;
};

/**
 * 两级取消：userStop 是轮次级信号；每个 LLM 请求（主请求、压缩摘要、标题任务）
 * 各自 deriveScope() 拿子 controller。局部 abort（如 mid-stream 压缩打断主请求）
 * 只影响自己的 scope；userStop 触发时链式传导到所有存活 scope。
 * 不用 AbortSignal.any：避免对 Tauri webview WebKit 版本的假设。
 */
// 把外部给定的 AbortSignal（如子代理的运行信号）桥接成 userStop。
export function createTurnCancellationFromSignal(signal?: AbortSignal): TurnCancellation {
  const cancellation = createTurnCancellation();
  if (signal) {
    if (signal.aborted) {
      cancellation.userStop.abort(signal.reason);
    } else {
      signal.addEventListener("abort", () => cancellation.userStop.abort(signal.reason), {
        once: true,
      });
    }
  }
  return cancellation;
}

export function createTurnCancellation(): TurnCancellation {
  const userStop = new AbortController();

  function deriveScope(): TurnCancellationScope {
    const controller = new AbortController();
    if (userStop.signal.aborted) {
      controller.abort(userStop.signal.reason);
      return { controller, release: () => {} };
    }

    const onUserStop = () => {
      controller.abort(userStop.signal.reason);
    };
    userStop.signal.addEventListener("abort", onUserStop, { once: true });
    const release = () => {
      userStop.signal.removeEventListener("abort", onUserStop);
    };
    // scope 自身结束后释放监听，长轮次不积累监听器。
    controller.signal.addEventListener("abort", release, { once: true });
    return { controller, release };
  }

  return { userStop, deriveScope };
}
