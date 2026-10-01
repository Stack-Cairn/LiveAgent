import { useCallback, useEffect, useRef, useState } from "react";

export const COPY_FEEDBACK_DURATION = {
  short: 1200,
  default: 1500,
  tooltip: 1600,
  settings: 2000,
} as const;

/** Owns only successful-copy feedback. Clipboard access and failure UI stay with callers. */
export function useCopyFeedback<T>(initialValue: T, durationMs: number, onExpire?: () => void) {
  const [copied, setCopied] = useState(initialValue);
  const timer = useRef<number | null>(null);
  const mounted = useRef(true);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  const cancelTimer = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelTimer();
    };
  }, [cancelTimer]);

  const resetCopied = useCallback(() => {
    cancelTimer();
    if (mounted.current) setCopied(initialValue);
  }, [cancelTimer, initialValue]);

  const showCopied = useCallback(
    (value: T) => {
      if (!mounted.current) return;
      cancelTimer();
      setCopied(value);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        if (!mounted.current) return;
        setCopied(initialValue);
        onExpireRef.current?.();
      }, durationMs);
    },
    [cancelTimer, durationMs, initialValue],
  );

  return { copied, showCopied, resetCopied };
}
