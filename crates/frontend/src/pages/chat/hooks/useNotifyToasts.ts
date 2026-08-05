import { useCallback, useEffect, useRef, useState } from "react";
import type { NotifyItem } from "../../../components/chat/NotifyToast";
import type { CompactionStatus } from "../../../lib/chat/compaction/types";

type UseNotifyToastsParams = {
  errorMessage: string | null;
  hookWarning: string | null;
  compactionStatus: CompactionStatus;
};

/**
 * Owns the toast list and bridges errorMessage / hookWarning /
 * compaction-failed transitions into toast notifications.
 */
export function useNotifyToasts(params: UseNotifyToastsParams) {
  const { errorMessage, hookWarning, compactionStatus } = params;
  const [notifyItems, setNotifyItems] = useState<NotifyItem[]>([]);
  const notifyIdCounter = useRef(0);

  const addNotify = useCallback((type: NotifyItem["type"], message: string) => {
    const id = `notify-${++notifyIdCounter.current}`;
    setNotifyItems((prev) => [...prev, { id, type, message }]);
  }, []);

  const dismissNotify = useCallback((id: string) => {
    setNotifyItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  useEffect(() => {
    if (errorMessage) addNotify("error", errorMessage);
  }, [errorMessage, addNotify]);

  useEffect(() => {
    if (hookWarning) addNotify("warning", hookWarning);
  }, [hookWarning, addNotify]);

  useEffect(() => {
    if (compactionStatus.phase === "failed") {
      addNotify("error", `上下文压缩失败：${compactionStatus.message}`);
    }
  }, [compactionStatus, addNotify]);

  return { notifyItems, addNotify, dismissNotify };
}
