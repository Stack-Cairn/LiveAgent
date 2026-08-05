/**
 * `@tauri-apps/api/event` 的替身。见 tauriCore.ts 的说明——同一套 vite alias +
 * tsconfig paths 的顶替手法。
 *
 * 事件按名字分两路（判定表在 commandRouting.ts）：
 *   - 壳自己发的（app:action、global-shortcut:*、terminal:exit-requested、
 *     tauri://*）→ 原生 IPC 订阅，因为发送方就是壳，网络上没有这些帧；
 *   - 其余 → 后端 WS。
 *
 * 为什么按名字分流而不是「两路都挂」：桌面壳里的内嵌后端是独立的
 * EventBus 实例（src-tauri/src/backend_server.rs 自己 build_state），和壳的
 * EventBus 不共享。两组事件名互不相交，所以一个事件名只有一个来源——按名字
 * 分流是确定的。两路都挂反而会在名字撞车时投递两次，而重复的事件在
 * 流式 token 这种场景里是直接可见的 bug。
 */

import { isShellEvent } from "./commandRouting";
import { getNativeInternals } from "./endpoint";
import { dispatchLocalEvent, subscribeBackendEvent } from "./transport";

export type EventName = string;

export type Event<T> = {
  /** 事件名 */
  event: EventName;
  /** 本次订阅的 id */
  id: number;
  /** 载荷 */
  payload: T;
};

export type EventCallback<T> = (event: Event<T>) => void;

export type UnlistenFn = () => void;

export type Options = {
  /** 只监听某个窗口/webview 的事件。仅在桌面壳里有意义。 */
  target?: string | { kind: string; label?: string };
};

type EventPluginInternals = {
  unregisterListener: (event: string, eventId: number) => void;
};

let nextLocalId = 1;

async function listenNative<T>(
  event: EventName,
  handler: EventCallback<T>,
  options?: Options,
): Promise<UnlistenFn> {
  const internals = getNativeInternals();
  if (!internals) {
    // 浏览器里没有壳，这些事件不会有人发。返回空的取消函数而不是抛错：
    // 调用点是 useEffect 里的订阅，抛错会把整个组件挂掉。
    return () => {};
  }

  const target =
    typeof options?.target === "string"
      ? { kind: "AnyLabel", label: options.target }
      : (options?.target ?? { kind: "Any" });

  const eventId = (await internals.invoke("plugin:event|listen", {
    event,
    target,
    handler: internals.transformCallback(handler as (payload: unknown) => void),
  })) as number;

  return () => {
    // 顺序照抄 @tauri-apps/api/event 的 _unlisten：先摘本地监听表再通知 Rust。
    const plugin = (window as unknown as Record<string, unknown>)
      .__TAURI_EVENT_PLUGIN_INTERNALS__ as EventPluginInternals | undefined;
    plugin?.unregisterListener(event, eventId);
    void internals.invoke("plugin:event|unlisten", { event, eventId });
  };
}

/** 订阅事件。签名与 `@tauri-apps/api/event` 的 listen 一致。 */
export async function listen<T>(
  event: EventName,
  handler: EventCallback<T>,
  options?: Options,
): Promise<UnlistenFn> {
  if (isShellEvent(event)) {
    return listenNative(event, handler, options);
  }

  const id = nextLocalId++;
  return subscribeBackendEvent(event, (frame) => {
    handler({ event: frame.event, id, payload: frame.payload as T });
  });
}

/** 只收一次。 */
export async function once<T>(
  event: EventName,
  handler: EventCallback<T>,
  options?: Options,
): Promise<UnlistenFn> {
  // 订阅在 await 返回之前就已生效，所以第一帧有可能早于赋值到达——用标志位
  // 保证「只收一次」，而不是依赖 unlisten 那时已经存在。
  let done = false;
  let unlisten: UnlistenFn | null = null;

  const stop = () => {
    done = true;
    unlisten?.();
  };

  unlisten = await listen<T>(
    event,
    (received) => {
      if (done) return;
      stop();
      handler(received);
    },
    options,
  );
  if (done) unlisten();
  return stop;
}

/** 发事件。壳内交给 Rust 广播，浏览器里只在本地回环。 */
export async function emit(event: EventName, payload?: unknown): Promise<void> {
  const internals = getNativeInternals();
  if (internals) {
    await internals.invoke("plugin:event|emit", { event, payload });
    return;
  }
  dispatchLocalEvent(event, payload);
}
