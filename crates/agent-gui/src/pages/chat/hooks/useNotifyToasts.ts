import { type ToastTone, toast } from "@liveagent/ui/components/ui/toast-manager";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useEffect, useId } from "react";
import type { CompactionStatus } from "../../../lib/chat/compaction/types";

type UseNotifyToastsParams = {
  errorMessage: string | null;
  hookWarning: string | null;
  compactionStatus: CompactionStatus;
};

/**
 * Bridges errorMessage / hookWarning /
 * compaction failed / degraded transitions into toast notifications.
 */
export function useNotifyToasts(params: UseNotifyToastsParams) {
  const { errorMessage, hookWarning, compactionStatus } = params;
  const { t } = useLocale();
  const scope = useId();
  useEffect(() => {
    if (errorMessage) toast.error(errorMessage, { id: `${scope}-error` });
  }, [errorMessage, scope]);

  useEffect(() => {
    if (hookWarning) toast.warning(hookWarning, { id: `${scope}-hook` });
  }, [hookWarning, scope]);

  useEffect(() => {
    if (compactionStatus.phase === "failed") {
      // 函数替换：供应商错误里的 $& / $' 不得被当成替换模式。
      const { message } = compactionStatus;
      toast.error(
        message
          ? t("chat.compactionFailed").replace("{message}", () => message)
          : t("chat.manualCompactFailed"),
        { id: `${scope}-compaction` },
      );
    } else if (compactionStatus.phase === "completed" && compactionStatus.degraded) {
      // LLM 档全部失败、由 deterministic 兜底：压缩成功但摘要有损，提醒用户留意质量。
      toast.warning(t("chat.compactionDegraded"), { id: `${scope}-compaction` });
    }
  }, [compactionStatus, scope, t]);

  return { addNotify };
}

const addNotify = (type: ToastTone, message: string) =>
  toast[type](message, { id: `app-notify:${type}:${message}` });
