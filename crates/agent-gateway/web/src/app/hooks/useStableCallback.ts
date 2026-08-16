import { useCallback, useRef } from "react";

// Stable identity wrapper so callback props recreated per render (e.g. by the
// per-render gateway action factories) never churn effects or memo'd regions.
// Calls always dispatch to the latest closure, so captured state stays fresh.
export function useStableCallback<Args extends unknown[], Return>(
  handler: (...args: Args) => Return,
): (...args: Args) => Return {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  return useCallback((...args: Args) => handlerRef.current(...args), []);
}
