import { listen as tauriListen } from "@tauri-apps/api/event";
import { isKBrainBrowserHost } from "../lib/host";

export type Event<T> = { payload: T };
export type UnlistenFn = () => void;

type EventHandler<T> = (event: Event<T>) => void;

export function listen<T>(_event: string, _handler: EventHandler<T>): Promise<() => void> {
  if (isKBrainBrowserHost()) return Promise.resolve(() => {});
  return tauriListen<T>(_event, _handler);
}
