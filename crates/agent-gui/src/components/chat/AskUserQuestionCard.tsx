// AskUserQuestion 的聊天卡片：顶部 tabs 切换多个问题，每题单选、推荐项
// 排在首位；纯展示组件，提交动作由调用方注入（GUI 直连工具挂起表，WebUI 走网关）。
// 本文件在 agent-gui 与 agent-gateway/web 之间逐字节镜像
// （见 scripts/mirror-manifest.json），端差异一律留在各端的 ToolCallItem。
import { useEffect, useMemo, useState } from "react";

import { useLocale } from "../../i18n";
import {
  ASK_USER_QUESTION_TIMEOUT_MS,
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
} from "../../lib/chat/askUserQuestion";
import { cn } from "../../lib/shared/utils";
import { Check, Sparkles } from "../icons";

export type AskUserQuestionSubmitOutcome = { ok: boolean; message?: string };

function formatCountdown(remainingMs: number) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * 倒计时提示：优先使用调用方传入的权威截止时间（GUI 读工具挂起表，WebUI 读
 * 网关参数上的 deadline 盖章），两端与桌面计时同源；缺失时（历史/降级数据）
 * 回退为挂载时刻近似。超时后 tool_result 会把卡片切到只读态。
 */
function useAnswerCountdown(active: boolean, deadlineAt?: number) {
  const [fallbackDeadline] = useState(() => Date.now() + ASK_USER_QUESTION_TIMEOUT_MS);
  const deadline = deadlineAt ?? fallbackDeadline;
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

function RecommendedTag({ label }: { label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/[0.14] px-1.5 py-0.5 text-[calc(10px*var(--zone-font-scale,1))] font-medium leading-none text-amber-700 dark:bg-amber-400/[0.12] dark:text-amber-300">
      <Sparkles className="h-2.5 w-2.5" />
      {label}
    </span>
  );
}

export function AskUserQuestionCard({
  questions,
  answers,
  cancelled = false,
  timedOut = false,
  interactive,
  deadlineAt,
  onSubmit,
}: {
  questions: AskUserQuestionItem[];
  /** 已落定的应答（工具结果）；提供后卡片只读展示选择结果。 */
  answers?: AskUserQuestionAnswer[];
  cancelled?: boolean;
  /** 应答窗口超时、按推荐项自动落定。 */
  timedOut?: boolean;
  /** 工具执行中且当前端可应答时为 true。 */
  interactive: boolean;
  /** 权威应答截止时间戳（毫秒）；缺省以挂载时刻近似。 */
  deadlineAt?: number;
  onSubmit?: (answers: AskUserQuestionAnswer[]) => Promise<AskUserQuestionSubmitOutcome>;
}) {
  const { t } = useLocale();
  const [activeIndex, setActiveIndex] = useState(0);
  const [draftSelections, setDraftSelections] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState("");

  const settledSelections = useMemo(() => {
    const map: Record<string, string> = {};
    for (const answer of answers ?? []) {
      map[answer.questionId] = answer.selectedLabel;
    }
    return map;
  }, [answers]);

  const isSettled = (answers?.length ?? 0) > 0;
  const selections = isSettled ? settledSelections : draftSelections;
  const canInteract = interactive && !isSettled && !cancelled && !submitting;
  const remainingMs = useAnswerCountdown(interactive && !isSettled && !cancelled, deadlineAt);

  if (questions.length === 0) return null;

  const safeActiveIndex = Math.min(activeIndex, questions.length - 1);
  const activeQuestion = questions[safeActiveIndex];
  const answeredCount = questions.filter((question) => selections[question.id]).length;
  const allAnswered = answeredCount === questions.length;

  const selectOption = (questionId: string, label: string) => {
    if (!canInteract) return;
    setErrorText("");
    setDraftSelections((current) => {
      const next = { ...current, [questionId]: label };
      // 选完当前题自动跳到下一道未作答的题，减少手动切 tab。
      const nextUnanswered = questions.findIndex(
        (question, index) => index !== safeActiveIndex && !next[question.id],
      );
      if (nextUnanswered >= 0 && next[questionId]) {
        setActiveIndex(nextUnanswered);
      }
      return next;
    });
  };

  const submit = async () => {
    if (!onSubmit || !allAnswered || !canInteract) return;
    const payload: AskUserQuestionAnswer[] = questions.map((question) => ({
      questionId: question.id,
      prompt: question.prompt,
      selectedLabel: draftSelections[question.id] ?? "",
    }));
    setSubmitting(true);
    setErrorText("");
    try {
      const outcome = await onSubmit(payload);
      if (!outcome.ok) {
        setErrorText(outcome.message || t("chat.askUser.submitFailed"));
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : t("chat.askUser.submitFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="tool-expand overflow-hidden rounded-xl border border-border/45 bg-background/70 dark:border-white/[0.08] dark:bg-white/[0.03]">
      {questions.length > 1 ? (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-border/35 px-1.5 py-1.5 dark:border-white/[0.05]">
          {questions.map((question, index) => {
            const isActive = index === safeActiveIndex;
            const isAnswered = Boolean(selections[question.id]);
            return (
              <button
                key={question.id}
                type="button"
                onClick={() => setActiveIndex(index)}
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-[calc(11px*var(--zone-font-scale,1))] font-medium leading-none transition-colors",
                  isActive
                    ? "bg-foreground/[0.07] text-foreground dark:bg-white/[0.09]"
                    : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground/80",
                )}
              >
                {isAnswered ? <Check className="h-3 w-3 text-emerald-500" /> : null}
                {question.header || `${t("chat.askUser.tabFallback")} ${index + 1}`}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="flex flex-col gap-2 px-3 py-2.5">
        <div className="text-[calc(12.5px*var(--zone-font-scale,1))] font-medium leading-[1.55] text-foreground/90">
          {activeQuestion.prompt}
        </div>

        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={activeQuestion.prompt}>
          {activeQuestion.options.map((option) => {
            const isSelected = selections[activeQuestion.id] === option.label;
            return (
              <button
                key={option.label}
                type="button"
                role="radio"
                aria-checked={isSelected}
                disabled={!canInteract}
                onClick={() => selectOption(activeQuestion.id, option.label)}
                className={cn(
                  "group/option flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
                  isSelected
                    ? "border-primary/45 bg-primary/[0.06] dark:border-primary/40 dark:bg-primary/[0.1]"
                    : "border-border/40 dark:border-white/[0.07]",
                  canInteract && !isSelected
                    ? "hover:border-border/70 hover:bg-foreground/[0.03] dark:hover:border-white/[0.14]"
                    : "",
                  !canInteract && !isSelected && (isSettled || cancelled) ? "opacity-55" : "",
                  canInteract ? "cursor-pointer" : "cursor-default",
                )}
              >
                <span
                  className={cn(
                    "mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors",
                    isSelected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-muted-foreground/40 group-hover/option:border-muted-foreground/70",
                  )}
                >
                  {isSelected ? <Check className="h-2.5 w-2.5" /> : null}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[calc(12px*var(--zone-font-scale,1))] font-medium leading-[1.5] text-foreground/85">
                      {option.label}
                    </span>
                    {option.recommended ? (
                      <RecommendedTag label={t("chat.askUser.recommended")} />
                    ) : null}
                  </span>
                  {option.description ? (
                    <span className="text-[calc(11px*var(--zone-font-scale,1))] leading-[1.55] text-muted-foreground/80">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>

        {cancelled ? (
          <div className="text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5] text-muted-foreground/70">
            {t("chat.askUser.cancelled")}
          </div>
        ) : isSettled ? (
          timedOut ? (
            <div className="text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5] text-amber-600 dark:text-amber-400">
              {t("chat.askUser.timedOut")}
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-[calc(11px*var(--zone-font-scale,1))] leading-none text-emerald-600 dark:text-emerald-400">
              <Check className="h-3 w-3" />
              {t("chat.askUser.answered")}
            </div>
          )
        ) : interactive ? (
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <span className="min-w-0 truncate text-[calc(11px*var(--zone-font-scale,1))] tabular-nums leading-none text-muted-foreground/70">
              {answeredCount}/{questions.length} {t("chat.askUser.progress")}
              <span className="ml-2 text-muted-foreground/55">
                {formatCountdown(remainingMs)} {t("chat.askUser.timeoutHint")}
              </span>
            </span>
            <button
              type="button"
              disabled={!allAnswered || submitting}
              onClick={() => void submit()}
              className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium leading-none text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
            >
              {submitting ? t("chat.askUser.submitting") : t("chat.askUser.submit")}
            </button>
          </div>
        ) : null}

        {errorText ? (
          <div className="text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5] text-red-500">
            {errorText}
          </div>
        ) : null}
      </div>
    </div>
  );
}
