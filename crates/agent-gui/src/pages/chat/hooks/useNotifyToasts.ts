import { type ToastTone, toast } from "@liveagent/ui/components/ui/toast-manager";
import { useEffect, useId } from "react";
import type { CompactionStatus } from "../../../lib/chat/compaction/types";

type UseNotifyToastsParams = {
  errorMessage: string | null;
  hookWarning: string | null;
  compactionStatus: CompactionStatus;
};

/**
 * Bridges errorMessage / hookWarning /
 * compaction-failed transitions into toast notifications.
 */
export function useNotifyToasts(params: UseNotifyToastsParams) {
  const { errorMessage, hookWarning, compactionStatus } = params;
  const scope = useId();
  useEffect(() => {
    if (errorMessage) toast.error(errorMessage, { id: `${scope}-error` });
  }, [errorMessage, scope]);

  useEffect(() => {
    if (hookWarning) toast.warning(hookWarning, { id: `${scope}-hook` });
  }, [hookWarning, scope]);

  useEffect(() => {
    if (compactionStatus.phase === "failed") {
      toast.error(`上下文压缩失败：${compactionStatus.message}`, { id: `${scope}-compaction` });
    }
  }, [compactionStatus, scope]);

  return { addNotify };
}

const addNotify = (type: ToastTone, message: string) => toast[type](message);
