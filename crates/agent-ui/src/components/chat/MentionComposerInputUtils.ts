import type { KeyboardEvent } from "react";

export function isImeKeyboardEvent(event: KeyboardEvent<HTMLDivElement>) {
  const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent & {
    isComposing?: boolean;
    keyCode?: number;
    which?: number;
  };
  return (
    nativeEvent.isComposing === true ||
    nativeEvent.keyCode === 229 ||
    nativeEvent.which === 229 ||
    event.key === "Process"
  );
}

export function isActiveImeKeyboardEvent(event: KeyboardEvent<HTMLDivElement>) {
  const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent & {
    isComposing?: boolean;
  };
  return nativeEvent.isComposing === true || event.key === "Process";
}

export function isEnterKeyboardEvent(event: KeyboardEvent<HTMLDivElement>) {
  const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent;
  return (
    event.key === "Enter" || nativeEvent.code === "Enter" || nativeEvent.code === "NumpadEnter"
  );
}

export function hasLegacyImeKeyboardSignal(event: KeyboardEvent<HTMLDivElement>) {
  const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent & {
    keyCode?: number;
    which?: number;
  };
  return nativeEvent.keyCode === 229 || nativeEvent.which === 229;
}
