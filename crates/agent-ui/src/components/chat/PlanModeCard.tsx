// ExitPlanMode 的聊天卡片：展示模型提交的实施计划（markdown），提供
// 批准 / 要求修改（附反馈）两个动作；纯展示组件，提交动作由调用方注入
// （GUI 直连工具挂起表，WebUI 走网关）。两端直接复用本组件，端差异一律
// 留在各端的 ToolCallItem（模式同 AskUserQuestionCard）。

import { Check, CheckCircle2, ListChecks, XCircle } from "@liveagent/ui/components/IconSet";
import { Markdown } from "@liveagent/ui/components/Markdown";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useEffect, useState } from "react";
import {
  EXIT_PLAN_MODE_FEEDBACK_MAX_LENGTH,
  EXIT_PLAN_MODE_SAVE_PATH_MAX_LENGTH,
  EXIT_PLAN_MODE_TIMEOUT_MS,
  type PlanDecision,
  type PlanDecisionAnswer,
} from "../../lib/chat/planMode";
import { cn } from "../../lib/shared/utils";

export type PlanDecisionSubmitOutcome = { ok: boolean; message?: string };

function formatCountdown(remainingMs: number) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * 倒计时提示：优先使用调用方传入的权威截止时间（GUI 读工具挂起表，WebUI 读
 * 网关参数上的 deadline 盖章）。时钟可比性校验同 AskUserQuestionCard：截止
 * 时间不落在“挂载时刻～挂载时刻+完整窗口”内即视为时钟不可比、回退挂载近似，
 * 避免远端时钟偏移把可作答的卡片锁死；真正过期的提交仍由桌面挂起表权威拒绝。
 */
function useDecisionCountdown(active: boolean, deadlineAt?: number) {
  const [mountedAt] = useState(() => Date.now());
  const deadline =
    deadlineAt !== undefined &&
    deadlineAt > mountedAt &&
    deadlineAt <= mountedAt + EXIT_PLAN_MODE_TIMEOUT_MS
      ? deadlineAt
      : mountedAt + EXIT_PLAN_MODE_TIMEOUT_MS;
  const [remainingMs, setRemainingMs] = useState(() => deadline - Date.now());

  useEffect(() => {
    if (!active) return;
    const tick = () => setRemainingMs(deadline - Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [active, deadline]);

  return remainingMs;
}

export function PlanModeCard({
  plan,
  decision,
  feedback,
  cancelled = false,
  timedOut = false,
  interactive,
  deadlineAt,
  readOnly = false,
  /** 宿主的摘要行已展示标题时隐藏卡片自带头部(倒计时移入底部操作行)。 */
  showHeader = true,
  onSubmit,
}: {
  /** 模型提交的完整计划（markdown）。 */
  plan: string;
  /** 已落定的决定（工具结果）；提供后卡片只读展示结果。 */
  decision?: PlanDecision;
  /** 拒绝时的用户反馈原文。 */
  feedback?: string;
  cancelled?: boolean;
  /** 应答窗口超时、按“未批准”落定。 */
  timedOut?: boolean;
  /** 工具执行中且当前端可应答时为 true。 */
  interactive: boolean;
  /** 权威应答截止时间戳（毫秒）；缺省以挂载时刻近似。 */
  deadlineAt?: number;
  readOnly?: boolean;
  showHeader?: boolean;
  onSubmit?: (answer: PlanDecisionAnswer) => Promise<PlanDecisionSubmitOutcome>;
}) {
  const { t } = useLocale();
  const [feedbackDraft, setFeedbackDraft] = useState("");
  const [showFeedbackInput, setShowFeedbackInput] = useState(false);
  // 批准时可选存盘:勾选后显示路径输入(相对工作区,预填 plan.md),
  // 落盘由执行续轮完成(规划轮无写能力)。
  const [saveEnabled, setSaveEnabled] = useState(false);
  const [savePathDraft, setSavePathDraft] = useState("plan.md");
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState("");

  const isSettled = decision !== undefined || cancelled || timedOut;
  const countdownActive = interactive && !isSettled;
  const remainingMs = useDecisionCountdown(countdownActive, deadlineAt);
  const canInteract = countdownActive && remainingMs > 0 && !submitting;

  const submit = async (answer: PlanDecisionAnswer) => {
    if (!onSubmit || !canInteract) return;
    setSubmitting(true);
    setErrorText("");
    try {
      const outcome = await onSubmit(answer);
      if (!outcome.ok) {
        setErrorText(outcome.message || t("chat.planMode.submitFailed"));
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : t("chat.planMode.submitFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const submitReject = () => {
    const trimmed = feedbackDraft.trim().slice(0, EXIT_PLAN_MODE_FEEDBACK_MAX_LENGTH);
    void submit({ decision: "reject", ...(trimmed ? { feedback: trimmed } : {}) });
  };

  return (
    <div className="tool-expand overflow-hidden rounded-xl border border-border/45 bg-background/70 dark:border-white/[0.08] dark:bg-white/[0.03]">
      {showHeader ? (
        <div className="flex items-center gap-2 border-b border-border/35 px-3 py-2 dark:border-white/[0.05]">
          <ListChecks className="h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
          <span className="text-[calc(12px*var(--zone-font-scale,1))] font-medium text-foreground/90">
            {t("chat.planMode.cardTitle")}
          </span>
          {countdownActive && remainingMs > 0 ? (
            <span className="ml-auto shrink-0 text-[calc(11px*var(--zone-font-scale,1))] tabular-nums text-muted-foreground">
              {formatCountdown(remainingMs)}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="px-3.5 py-3">
        <Markdown content={plan} className="font-chat text-sm" readOnly={readOnly} />
      </div>

      {/* 落定态提示条：批准 / 要求修改（含反馈）/ 超时 / 取消。 */}
      {isSettled ? (
        <div
          className={cn(
            "flex flex-col gap-1 border-t border-border/35 px-3 py-2 dark:border-white/[0.05]",
          )}
        >
          <div className="flex items-center gap-1.5 text-[calc(11.5px*var(--zone-font-scale,1))]">
            {decision === "approve" ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                <span className="text-emerald-700 dark:text-emerald-300">
                  {t("chat.planMode.approved")}
                </span>
              </>
            ) : decision === "reject" ? (
              <>
                <XCircle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                <span className="text-amber-700 dark:text-amber-300">
                  {t("chat.planMode.rejected")}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">
                {cancelled ? t("chat.planMode.cancelled") : t("chat.planMode.timedOut")}
              </span>
            )}
          </div>
          {feedback ? (
            <div className="whitespace-pre-wrap rounded-lg bg-muted/40 px-2.5 py-1.5 text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.55] text-foreground/80">
              {feedback}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 交互区：批准 / 要求修改；展开反馈输入后回车或按钮提交。 */}
      {countdownActive ? (
        <div className="flex flex-col gap-2 border-t border-border/35 px-3 py-2 dark:border-white/[0.05]">
          <label className="flex cursor-pointer items-center gap-2 text-[calc(11.5px*var(--zone-font-scale,1))] text-foreground/80">
            <input
              type="checkbox"
              checked={saveEnabled}
              disabled={!canInteract}
              onChange={(event) => setSaveEnabled(event.target.checked)}
              className="h-3.5 w-3.5 shrink-0 accent-[hsl(var(--primary))]"
            />
            {t("chat.planMode.saveToggle")}
            {saveEnabled ? (
              <input
                type="text"
                value={savePathDraft}
                disabled={!canInteract}
                onChange={(event) => setSavePathDraft(event.target.value)}
                maxLength={EXIT_PLAN_MODE_SAVE_PATH_MAX_LENGTH}
                placeholder="plan.md"
                aria-label={t("chat.planMode.savePathLabel")}
                className="min-w-0 flex-1 rounded-md border border-border/50 bg-background/80 px-2 py-1 font-mono text-[calc(11px*var(--zone-font-scale,1))] outline-hidden focus-visible:ring-2 focus-visible:ring-primary/35 dark:border-white/[0.08]"
              />
            ) : null}
          </label>
          {showFeedbackInput ? (
            <textarea
              value={feedbackDraft}
              onChange={(event) => setFeedbackDraft(event.target.value)}
              maxLength={EXIT_PLAN_MODE_FEEDBACK_MAX_LENGTH}
              rows={3}
              disabled={!canInteract}
              placeholder={t("chat.planMode.feedbackPlaceholder")}
              className="w-full resize-y rounded-lg border border-border/50 bg-background/80 px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] leading-[1.55] outline-hidden focus-visible:ring-2 focus-visible:ring-primary/35 dark:border-white/[0.08]"
            />
          ) : null}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!canInteract}
              onClick={() => {
                const savePath = saveEnabled
                  ? savePathDraft.trim().slice(0, EXIT_PLAN_MODE_SAVE_PATH_MAX_LENGTH)
                  : "";
                void submit({ decision: "approve", ...(savePath ? { savePath } : {}) });
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[calc(12px*var(--zone-font-scale,1))] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-40"
            >
              <Check className="h-3.5 w-3.5" />
              {t("chat.planMode.approve")}
            </button>
            {showFeedbackInput ? (
              <button
                type="button"
                disabled={!canInteract}
                onClick={submitReject}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/60 px-3 text-[calc(12px*var(--zone-font-scale,1))] font-medium text-foreground/85 transition-colors hover:bg-muted/60 disabled:pointer-events-none disabled:opacity-40"
              >
                {t("chat.planMode.submitFeedback")}
              </button>
            ) : (
              <button
                type="button"
                disabled={!canInteract}
                onClick={() => setShowFeedbackInput(true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/60 px-3 text-[calc(12px*var(--zone-font-scale,1))] font-medium text-foreground/85 transition-colors hover:bg-muted/60 disabled:pointer-events-none disabled:opacity-40"
              >
                {t("chat.planMode.requestChanges")}
              </button>
            )}
            {submitting ? (
              <span className="text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground">
                {t("chat.planMode.submitting")}
              </span>
            ) : null}
            {!showHeader && remainingMs > 0 ? (
              <span className="ml-auto shrink-0 text-[calc(11px*var(--zone-font-scale,1))] tabular-nums text-muted-foreground">
                {formatCountdown(remainingMs)}
              </span>
            ) : null}
          </div>
          {errorText ? (
            <div className="text-[calc(11px*var(--zone-font-scale,1))] text-destructive">
              {errorText}
            </div>
          ) : null}
          {remainingMs <= 0 ? (
            <div className="text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground">
              {t("chat.planMode.timedOut")}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
