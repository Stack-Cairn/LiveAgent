// ExitPlanMode 的聊天卡片：展示模型提交的实施计划（markdown）。
// 对话式范式：提交即结束本轮——用户直接输入"同意/开始"即批准，输入其他内容
// 即修改意见（正常发消息）；卡片只保留一个「批准并开始执行」快捷按钮。
// 纯展示组件，按钮动作与待决状态由调用方注入；两端复用，端差异留在 ToolCallItem。

import { Check, CheckCircle2, ListChecks, Loader2 } from "@liveagent/ui/components/IconSet";
import { Markdown } from "@liveagent/ui/components/Markdown";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useState } from "react";
import type { PlanDecisionAnswer } from "../../lib/chat/planMode";
import { cn } from "../../lib/shared/utils";

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

  // 卡片有三种观感,而不是"已批准/其余"两种:
  //   approved — 已落定批准;
  //   pending  — 仍是会话的待决计划(只读视图下同样待决,只是本端不能操作);
  //   inactive — 既未批准也不再待决。成因可能是被新计划取代、本轮被取消,或
  //              历史/降级数据丢了标记,本端无从分辨,因此只陈述"不再待决"这个
  //              确定事实,不臆断原因。
  const tone: "approved" | "pending" | "inactive" = approved
    ? "approved"
    : pending
      ? "pending"
      : "inactive";

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
    <div
      className={cn(
        // 边框与兄弟工具卡保持一致,状态色只由左侧脊承担一处,避免多点强调互相稀释。
        "tool-expand relative overflow-hidden rounded-xl border border-border/45 bg-background/70 dark:border-white/[0.08] dark:bg-white/[0.03]",
        // 只有仍可拍板的计划值得从转录里浮起来;已落定的一律回落成安静的历史文档。
        tone === "pending"
          ? "shadow-[0_1px_2px_-1px_rgba(15,23,42,0.07),0_14px_32px_-26px_rgba(2,132,199,0.55)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_14px_32px_-24px_rgba(0,0,0,0.7)]"
          : "dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
      )}
    >
      {/* 状态脊：整条转录里只有这张卡片在等用户拍板。左侧色条是全卡唯一的强调,
          既把它与普通工具行区分开,又用颜色承载三种状态。 */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 left-0 w-[3px]",
          tone === "approved"
            ? "bg-gradient-to-b from-emerald-400 to-emerald-500"
            : tone === "pending"
              ? "bg-gradient-to-b from-sky-400 via-sky-500 to-indigo-500 shadow-[2px_0_12px_-2px_rgba(2,132,199,0.5)]"
              : "bg-border dark:bg-white/[0.12]",
        )}
      />

      <div className="flex items-center gap-2 border-b border-border/35 px-3.5 py-2 dark:border-white/[0.05]">
        <ListChecks
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            tone === "approved"
              ? "text-emerald-600 dark:text-emerald-400"
              : tone === "pending"
                ? "text-sky-600 dark:text-sky-400"
                : "text-muted-foreground/60",
          )}
        />
        <span className="text-[calc(12px*var(--zone-font-scale,1))] font-medium tracking-[0.01em] text-foreground/90">
          {t("chat.planMode.cardTitle")}
        </span>

        {/* 计划很长时按钮会落在视口外,表头状态让人不用滚到底也知道这份计划的处境。 */}
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-[calc(11px*var(--zone-font-scale,1))] leading-none text-muted-foreground">
          {tone === "approved" ? (
            <>
              <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
              {t("chat.planMode.approved")}
            </>
          ) : tone === "pending" ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-sky-500 dark:bg-sky-400" />
              {t("chat.planMode.awaiting")}
            </>
          ) : (
            <>
              <span className="h-1.5 w-1.5 rounded-full border border-muted-foreground/45" />
              {t("chat.planMode.inactive")}
            </>
          )}
        </span>
      </div>

      <div className="px-4 py-3.5">
        <Markdown content={plan} className="plan-markdown font-chat" readOnly={readOnly} />
      </div>

      {canApprove ? (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t border-border/35 bg-foreground/[0.015] px-3.5 py-2.5 dark:border-white/[0.05] dark:bg-white/[0.015]">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void approve()}
            className="group/approve inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[calc(12px*var(--zone-font-scale,1))] font-medium text-primary-foreground shadow-[0_1px_2px_-1px_rgba(15,23,42,0.25)] transition-[background-color,transform,box-shadow] duration-150 ease-out hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            {submitting ? t("chat.planMode.approving") : t("chat.planMode.approve")}
          </button>
          {errorText ? (
            <span className="min-w-0 flex-1 text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5] text-[hsl(var(--chat-error))]">
              {errorText}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
