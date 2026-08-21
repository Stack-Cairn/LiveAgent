// ExitPlanMode 的聊天卡片：展示模型提交的实施计划（markdown）。
// 对话式范式：提交即结束本轮——用户直接输入"同意/开始"即批准，输入其他内容
// 即修改意见（正常发消息）；卡片只保留一个「批准并开始执行」快捷按钮。
// 纯展示组件，按钮动作与待决状态由调用方注入；两端复用，端差异留在 ToolCallItem。

import { Check, CheckCircle2, ListChecks } from "@liveagent/ui/components/IconSet";
import { Markdown } from "@liveagent/ui/components/Markdown";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useState } from "react";
import type { PlanDecisionAnswer } from "../../lib/chat/planMode";

export type PlanDecisionSubmitOutcome = { ok: boolean; message?: string };

export function PlanModeCard({
  plan,
  approved = false,
  pending = false,
  readOnly = false,
  onSubmit,
}: {
  /** 模型提交的完整计划（markdown）。 */
  plan: string;
  /** 已获批准（历史/落定态）。 */
  approved?: boolean;
  /** 该计划仍是会话的待决计划（可批准）；被新提交覆盖后为 false。 */
  pending?: boolean;
  readOnly?: boolean;
  onSubmit?: (answer: PlanDecisionAnswer) => Promise<PlanDecisionSubmitOutcome>;
}) {
  const { t } = useLocale();
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState("");

  const canApprove = pending && !approved && !readOnly && Boolean(onSubmit);

  const approve = async () => {
    if (!onSubmit || !canApprove || submitting) return;
    setSubmitting(true);
    setErrorText("");
    try {
      const outcome = await onSubmit({ decision: "approve" });
      if (!outcome.ok) {
        setErrorText(outcome.message || t("chat.planMode.submitFailed"));
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : t("chat.planMode.submitFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="tool-expand overflow-hidden rounded-xl border border-border/45 bg-background/70 dark:border-white/[0.08] dark:bg-white/[0.03]">
      <div className="flex items-center gap-2 border-b border-border/35 px-3 py-2 dark:border-white/[0.05]">
        <ListChecks className="h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
        <span className="text-[calc(12px*var(--zone-font-scale,1))] font-medium text-foreground/90">
          {t("chat.planMode.cardTitle")}
        </span>
        {approved ? (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[calc(11px*var(--zone-font-scale,1))] text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {t("chat.planMode.approved")}
          </span>
        ) : null}
      </div>

      <div className="px-3.5 py-3">
        <Markdown content={plan} className="font-chat text-sm" readOnly={readOnly} />
      </div>

      {canApprove ? (
        <div className="flex items-center gap-2.5 border-t border-border/35 px-3 py-2 dark:border-white/[0.05]">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void approve()}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-[calc(12px*var(--zone-font-scale,1))] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-40"
          >
            <Check className="h-3.5 w-3.5" />
            {t("chat.planMode.approve")}
          </button>
          <span className="min-w-0 truncate text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground">
            {errorText || t("chat.planMode.replyHint")}
          </span>
        </div>
      ) : null}
    </div>
  );
}
