// AskUserQuestion 的聊天卡片：顶部 tabs 切换多个问题，每题单选、推荐项
// 排在首位；纯展示组件，提交动作由调用方注入（GUI 直连工具挂起表，WebUI 走网关）。
// 两端直接复用本组件，端差异一律留在各端的 ToolCallItem。

import { Check, Sparkles } from "@liveagent/ui/components/IconSet";

import { useLocale } from "@liveagent/ui/i18n/index";
import { useEffect, useMemo, useState } from "react";
import {
  ASK_USER_QUESTION_CUSTOM_MAX_LENGTH,
  ASK_USER_QUESTION_TIMEOUT_MS,
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
} from "../../lib/chat/askUserQuestion";
import { cn } from "../../lib/shared/utils";

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
 * 回退为挂载时刻近似。倒计时归零立即禁止交互，随后 tool_result 把卡片
 * 切到只读态。
 *
 * 盖章用的是桌面时钟，而倒计时读本机时钟：远端浏览器时钟偏移足够大时，
 * 一个仍在挂起的提问会在挂载瞬间就显示过期（或远超完整窗口）。因此仅当
 * 截止时间落在“挂载时刻（不含）～挂载时刻 + 完整应答窗口（含）”内才采信，
 * 否则视为时钟不可比、回退挂载近似，避免把可作答的卡片锁死；真正过期的
 * 提交仍由桌面挂起表权威拒绝。
 */
function useAnswerCountdown(active: boolean, deadlineAt?: number) {
  const [mountedAt] = useState(() => Date.now());
  const deadline =
    deadlineAt !== undefined &&
    deadlineAt > mountedAt &&
    deadlineAt <= mountedAt + ASK_USER_QUESTION_TIMEOUT_MS
      ? deadlineAt
      : mountedAt + ASK_USER_QUESTION_TIMEOUT_MS;
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
  // 切题方向（首次渲染为 null 不播动画）；keyed 内容区据此选滑入方向。
  const [switchDirection, setSwitchDirection] = useState<"forward" | "backward" | null>(null);
  const [draftSelections, setDraftSelections] = useState<Record<string, string>>({});
  // “其他（自行输入）”合成项：选中态与输入文本按 questionId 各自持久，
  // 与 draftSelections 并列（不用哨兵 label，避免与真实选项 label 撞车）。
  const [customSelected, setCustomSelected] = useState<Record<string, boolean>>({});
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState("");

  const { settledSelections, settledCustom } = useMemo(() => {
    const selections: Record<string, string> = {};
    const custom: Record<string, boolean> = {};
    for (const answer of answers ?? []) {
      selections[answer.questionId] = answer.selectedLabel;
      if (answer.custom === true) custom[answer.questionId] = true;
    }
    return { settledSelections: selections, settledCustom: custom };
  }, [answers]);

  const isSettled = (answers?.length ?? 0) > 0;
  const selections = isSettled ? settledSelections : draftSelections;
  const countdownActive = interactive && !isSettled && !cancelled;
  const remainingMs = useAnswerCountdown(countdownActive, deadlineAt);
  const countdownExpired = countdownActive && remainingMs <= 0;
  const canInteract = countdownActive && remainingMs > 0 && !submitting;

  // 该题是否已作答：普通选项已选，或“其他”选中且文本非空。
  const isQuestionAnswered = (questionId: string) => {
    if (isSettled) return Boolean(settledSelections[questionId]);
    if (customSelected[questionId]) return Boolean(customTexts[questionId]?.trim());
    return Boolean(draftSelections[questionId]);
  };

  if (questions.length === 0) return null;

  const safeActiveIndex = Math.min(activeIndex, questions.length - 1);
  const activeQuestion = questions[safeActiveIndex];
  const answeredCount = questions.filter((question) => isQuestionAnswered(question.id)).length;
  const allAnswered = answeredCount === questions.length;
  // 当前题“其他”行的选中态与文本：落定后以应答里的 custom 标记与原文为准。
  const activeCustomSelected = isSettled
    ? Boolean(settledCustom[activeQuestion.id])
    : Boolean(customSelected[activeQuestion.id]);
  const activeCustomText = isSettled
    ? (settledSelections[activeQuestion.id] ?? "")
    : (customTexts[activeQuestion.id] ?? "");

  // 带方向切题：内容区按 question.id 重挂载并向对应方向滑入。
  const goToQuestion = (index: number) => {
    if (index === safeActiveIndex || index < 0 || index >= questions.length) return;
    setSwitchDirection(index > safeActiveIndex ? "forward" : "backward");
    setActiveIndex(index);
  };

  const selectOption = (questionId: string, label: string) => {
    if (!canInteract) return;
    setErrorText("");
    setCustomSelected((current) => {
      if (!current[questionId]) return current;
      const next = { ...current };
      delete next[questionId];
      return next;
    });
    setDraftSelections((current) => {
      const next = { ...current, [questionId]: label };
      // 选完当前题自动跳到下一道未作答的题，减少手动切 tab。
      const nextUnanswered = questions.findIndex(
        (question, index) =>
          index !== safeActiveIndex &&
          !next[question.id] &&
          !(customSelected[question.id] && customTexts[question.id]?.trim()),
      );
      if (nextUnanswered >= 0 && next[questionId]) {
        goToQuestion(nextUnanswered);
      }
      return next;
    });
  };

  // 选中“其他”行：清掉该题的普通选项，等待用户输入（不自动跳题）。
  const selectCustom = (questionId: string) => {
    if (!canInteract) return;
    setErrorText("");
    setDraftSelections((current) => {
      if (!(questionId in current)) return current;
      const next = { ...current };
      delete next[questionId];
      return next;
    });
    setCustomSelected((current) =>
      current[questionId] ? current : { ...current, [questionId]: true },
    );
  };

  const submit = async () => {
    if (!onSubmit || !allAnswered || !canInteract) return;
    const payload: AskUserQuestionAnswer[] = questions.map((question) => {
      if (customSelected[question.id]) {
        return {
          questionId: question.id,
          prompt: question.prompt,
          selectedLabel: (customTexts[question.id] ?? "")
            .trim()
            .slice(0, ASK_USER_QUESTION_CUSTOM_MAX_LENGTH),
          custom: true,
        };
      }
      return {
        questionId: question.id,
        prompt: question.prompt,
        selectedLabel: draftSelections[question.id] ?? "",
      };
    });
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
            const isAnswered = isQuestionAnswered(question.id);
            return (
              <button
                key={question.id}
                type="button"
                onClick={() => goToQuestion(index)}
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
        {/* key 触发重挂载，切题时按方向播放轻量滑入动画。 */}
        <div
          key={activeQuestion.id}
          className={cn(
            "flex flex-col gap-2",
            switchDirection === "forward" ? "ask-question-enter-forward" : "",
            switchDirection === "backward" ? "ask-question-enter-backward" : "",
          )}
        >
          <div className="text-[calc(12.5px*var(--zone-font-scale,1))] font-medium leading-[1.55] text-foreground/90">
            {activeQuestion.prompt}
          </div>

          <div
            className="flex flex-col gap-1.5"
            role="radiogroup"
            aria-label={activeQuestion.prompt}
          >
            {activeQuestion.options.map((option) => {
              const isSelected =
                !activeCustomSelected && selections[activeQuestion.id] === option.label;
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
                    !canInteract && !isSelected && (isSettled || cancelled || countdownExpired)
                      ? "opacity-55"
                      : "",
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

            {/* UI 合成的“其他（自行输入）”行：固定在选项最底部，不属于模型给出的
                options；选中后展开单行输入框，键入文本即该题应答。选项行是
                button 而 input 不能嵌套其中，故此行用 div role="radio"。 */}
            <div
              role="radio"
              aria-checked={activeCustomSelected}
              aria-disabled={!canInteract}
              tabIndex={canInteract ? 0 : -1}
              onClick={() => selectCustom(activeQuestion.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  selectCustom(activeQuestion.id);
                }
              }}
              className={cn(
                "group/option flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
                activeCustomSelected
                  ? "border-primary/45 bg-primary/[0.06] dark:border-primary/40 dark:bg-primary/[0.1]"
                  : "border-border/40 dark:border-white/[0.07]",
                canInteract && !activeCustomSelected
                  ? "hover:border-border/70 hover:bg-foreground/[0.03] dark:hover:border-white/[0.14]"
                  : "",
                !canInteract &&
                  !activeCustomSelected &&
                  (isSettled || cancelled || countdownExpired)
                  ? "opacity-55"
                  : "",
                canInteract ? "cursor-pointer" : "cursor-default",
              )}
            >
              <span
                className={cn(
                  "mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors",
                  activeCustomSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/40 group-hover/option:border-muted-foreground/70",
                )}
              >
                {activeCustomSelected ? <Check className="h-2.5 w-2.5" /> : null}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-[calc(12px*var(--zone-font-scale,1))] font-medium leading-[1.5] text-foreground/85">
                  {t("chat.askUser.customOption")}
                </span>
                {activeCustomSelected && !isSettled && !cancelled && interactive ? (
                  <input
                    autoFocus
                    value={activeCustomText}
                    disabled={!canInteract}
                    maxLength={ASK_USER_QUESTION_CUSTOM_MAX_LENGTH}
                    placeholder={t("chat.askUser.customPlaceholder")}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter" && allAnswered) {
                        event.preventDefault();
                        void submit();
                      }
                    }}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setErrorText("");
                      setCustomTexts((current) => ({
                        ...current,
                        [activeQuestion.id]: value,
                      }));
                    }}
                    className="ask-custom-input-enter mt-0.5 h-8 w-full rounded-lg border border-black/[0.08] bg-white/65 px-2.5 text-[calc(12px*var(--zone-font-scale,1))] text-foreground shadow-[inset_0_1px_2px_rgba(0,0,0,0.04),0_1px_0_rgba(255,255,255,0.55)] outline-none backdrop-blur-md backdrop-saturate-150 transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-muted-foreground/45 focus:border-primary/45 focus:bg-white/80 focus:ring-[2.5px] focus:ring-primary/[0.13] dark:border-white/[0.1] dark:bg-white/[0.05] dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)] dark:focus:border-primary/40 dark:focus:bg-white/[0.08]"
                  />
                ) : activeCustomSelected && activeCustomText ? (
                  <span className="break-words text-[calc(11px*var(--zone-font-scale,1))] leading-[1.55] text-muted-foreground/80">
                    {activeCustomText}
                  </span>
                ) : null}
              </span>
            </div>
          </div>
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
              disabled={!allAnswered || !canInteract}
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
