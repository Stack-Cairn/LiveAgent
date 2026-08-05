import { useCallback, useEffect, useRef, useState } from "react";

// Row-local "copied" feedback: the 1.5s checkmark is inherently local to the
// button that was clicked, so no list-level state (which used to re-render
// every visible row per click) is involved.
export function useCopiedFlag() {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  const markCopied = useCallback(() => {
    setCopied(true);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setCopied(false);
    }, 1500);
  }, []);

  return { copied, markCopied };
}
