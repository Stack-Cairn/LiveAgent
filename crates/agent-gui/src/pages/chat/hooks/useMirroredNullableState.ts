import { type SetStateAction, useCallback, useRef, useState } from "react";

export function useMirroredNullableState<T>() {
  const [value, setValueState] = useState<T | null>(null);
  const valueRef = useRef<T | null>(value);
  const setValue = useCallback((next: SetStateAction<T | null>) => {
    const resolved =
      typeof next === "function"
        ? (next as (previous: T | null) => T | null)(valueRef.current)
        : next;
    valueRef.current = resolved;
    setValueState(resolved);
  }, []);
  return [value, setValue, valueRef] as const;
}
