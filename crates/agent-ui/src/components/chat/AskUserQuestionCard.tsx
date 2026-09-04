// AskUserQuestion 的聊天卡片：逐题切换、每题单选，推荐项排在首位；
// 纯展示组件，提交动作由调用方注入（GUI 直连工具挂起表，WebUI 走网关）。
// 两端直接复用本组件，端差异一律留在各端的 ToolCallItem。

import { Check, ChevronDown, ChevronUp, Sparkles } from "@liveagent/ui/components/IconSet";

import { useLocale } from "@liveagent/ui/i18n/index";
import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ASK_USER_QUESTION_CUSTOM_MAX_LENGTH,
  ASK_USER_QUESTION_TIMEOUT_MS,
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
} from "../../lib/chat/askUserQuestion";
import { cn } from "../../lib/shared/utils";

export type AskUserQuestionSubmitOutcome = { ok: boolean; message?: string };

const QUESTION_SLIDE = "360ms cubic-bezier(0.22, 1, 0.36, 1)";
const COUNTER_ROLL_MS = 400;

function formatCountdown(remainingMs: number) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function RollingDigits({ value }: { value: string }) {
  const previousValueRef = useRef(value);
  const [previousValue, setPreviousValue] = useState(value);
  const [nextValue, setNextValue] = useState(value);
  const [rolling, setRolling] = useState(false);
  const [shifted, setShifted] = useState(false);
  const [direction, setDirection] = useState<"up" | "down">("up");

  useEffect(() => {
    if (previousValueRef.current === value) return;
    const from = previousValueRef.current;
    previousValueRef.current = value;
    const fromNumber = Number.parseInt(from, 10);
    const toNumber = Number.parseInt(value, 10);
    setDirection(
      Number.isFinite(fromNumber) && Number.isFinite(toNumber) && toNumber < fromNumber
        ? "down"
        : "up",
    );
    setPreviousValue(from);
    setNextValue(value);
    setRolling(true);
    setShifted(false);

    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => setShifted(true));
    });
    const done = window.setTimeout(() => {
      setRolling(false);
      setPreviousValue(value);
      setShifted(false);
    }, COUNTER_ROLL_MS);

    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      window.clearTimeout(done);
    };
  }, [value]);

  const visibleValue = rolling ? nextValue : previousValue;

  return (
    <>
      {Array.from({ length: visibleValue.length }, (_, index) => {
        const previousCharacter = previousValue[index] ?? "";
        const nextCharacter = visibleValue[index] ?? "";
        if (!rolling || previousCharacter === nextCharacter) {
          // biome-ignore lint/suspicious/noArrayIndexKey: Counter glyphs are positional animation cells.
          return <span key={`${index}-${nextCharacter}`}>{nextCharacter}</span>;
        }
        const top = direction === "down" ? nextCharacter : previousCharacter;
        const bottom = direction === "down" ? previousCharacter : nextCharacter;
        const restingOffset = direction === "down" ? "0" : "-1em";
        const startingOffset = direction === "down" ? "-1em" : "0";
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: Counter glyphs are positional animation cells.
            key={`${index}-${previousCharacter}-${nextCharacter}-${direction}`}
            className="relative inline-block h-[1em] overflow-hidden align-[-0.05em] leading-[1em]"
          >
            <span
              className="flex flex-col"
              style={{
                transition: "transform 350ms cubic-bezier(0.4, 0, 0.2, 1)",
                transform: `translateY(${shifted ? restingOffset : startingOffset})`,
              }}
            >
              <span className="h-[1em] leading-[1em]">{top}</span>
              <span className="h-[1em] leading-[1em]">{bottom}</span>
            </span>
          </span>
        );
      })}
    </>
  );
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
  const safeActiveIndex = Math.min(activeIndex, Math.max(questions.length - 1, 0));

  const questionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const measuredRef = useRef(false);
  const [viewportHeight, setViewportHeight] = useState<number | undefined>();
  const [trackOffset, setTrackOffset] = useState(0);
  const [animateQuestionChange, setAnimateQuestionChange] = useState(false);
  const [sliderReady, setSliderReady] = useState(false);

  useLayoutEffect(() => {
    const activeItem = questionRefs.current[safeActiveIndex];
    if (!activeItem) return;
    const reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const updateMeasurements = () => {
      setViewportHeight(activeItem.offsetHeight);
      setTrackOffset(activeItem.offsetTop);
    };

    updateMeasurements();
    setAnimateQuestionChange(measuredRef.current && !reducedMotion);
    measuredRef.current = true;
    setSliderReady(true);

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateMeasurements);
    observer.observe(activeItem);
    return () => observer.disconnect();
  }, [safeActiveIndex]);

  // 该题是否已作答：普通选项已选，或“其他”选中且文本非空。
  const isQuestionAnswered = (questionId: string) => {
    if (isSettled) return Boolean(settledSelections[questionId]);
    if (customSelected[questionId]) return Boolean(customTexts[questionId]?.trim());
    return Boolean(draftSelections[questionId]);
  };

  if (questions.length === 0) return null;

  const activeQuestion = questions[safeActiveIndex];
  const answeredCount = questions.filter((question) => isQuestionAnswered(question.id)).length;
  const allAnswered = answeredCount === questions.length;
  // 带方向切题：内容轨道纵向滑动，当前题再附一层轻量方向过渡。
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
    <div className="tool-expand w-full max-w-[min(100%,36rem)]">
      <div className="overflow-hidden rounded-2xl border border-black/[0.055] bg-white/72 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] backdrop-blur-xl backdrop-saturate-150 dark:border-white/[0.09] dark:bg-white/[0.045] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]">
        <div className="px-4 pb-3 pt-4">
          <div
            aria-live="polite"
            className="overflow-hidden"
            style={{
              height: viewportHeight,
              transition: animateQuestionChange ? `height ${QUESTION_SLIDE}` : undefined,
            }}
          >
            <div
              className="flex flex-col gap-6"
              style={{
                transform: `translate3d(0, ${-trackOffset}px, 0)`,
                transition: animateQuestionChange ? `transform ${QUESTION_SLIDE}` : undefined,
                willChange: "transform",
              }}
            >
              {questions.map((question, questionIndex) => {
                const active = questionIndex === safeActiveIndex;
                if (!sliderReady && !active) return null;
                const questionCustomSelected = isSettled
                  ? Boolean(settledCustom[question.id])
                  : Boolean(customSelected[question.id]);
                const questionCustomText = isSettled
                  ? (settledSelections[question.id] ?? "")
                  : (customTexts[question.id] ?? "");
                const questionStyle: CSSProperties = {
                  opacity: active ? 1 : 0,
                  pointerEvents: active ? undefined : "none",
                  transition: animateQuestionChange ? `opacity ${QUESTION_SLIDE}` : undefined,
                };

                return (
                  <div
                    key={question.id}
                    ref={(element) => {
                      questionRefs.current[questionIndex] = element;
                    }}
                    aria-hidden={active ? undefined : true}
                    className={cn(
                      active && switchDirection === "forward" ? "ask-question-enter-forward" : "",
                      active && switchDirection === "backward" ? "ask-question-enter-backward" : "",
                    )}
                    style={questionStyle}
                  >
                    <div className="text-[calc(13.5px*var(--zone-font-scale,1))] font-medium leading-[1.5] text-foreground/92">
                      {question.prompt}
                    </div>

                    <fieldset
                      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA permits fieldset as the radiogroup context for rich radio rows.
                      role="radiogroup"
                      aria-label={question.prompt}
                      className="mt-2.5 flex min-w-0 flex-col gap-1 border-0 p-0"
                    >
                      {question.options.map((option) => {
                        const selected =
                          !questionCustomSelected && selections[question.id] === option.label;
                        const disabled = !active || !canInteract;
                        return (
                          // biome-ignore lint/a11y/useSemanticElements: Rich option content uses the ARIA radio pattern as one focusable choice.
                          <button
                            key={option.label}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            disabled={disabled}
                            tabIndex={active ? 0 : -1}
                            onClick={() => selectOption(question.id, option.label)}
                            className={cn(
                              "group/option relative flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors duration-150",
                              selected
                                ? "bg-foreground/[0.065] dark:bg-white/[0.085]"
                                : active && canInteract
                                  ? "hover:bg-foreground/[0.035] dark:hover:bg-white/[0.055]"
                                  : "",
                              !selected && (isSettled || cancelled || countdownExpired)
                                ? "opacity-50"
                                : "",
                              active && canInteract ? "cursor-pointer" : "cursor-default",
                            )}
                          >
                            <span
                              className={cn(
                                "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-[background-color,box-shadow] duration-200",
                                selected
                                  ? "bg-foreground text-background"
                                  : "shadow-[inset_0_0_0_1.5px_hsl(var(--muted-foreground)/0.4)] group-hover/option:shadow-[inset_0_0_0_1.5px_hsl(var(--muted-foreground)/0.7)]",
                              )}
                            >
                              <span
                                className={cn(
                                  "h-1.5 w-1.5 rounded-full bg-background transition-transform duration-200",
                                  selected ? "scale-100" : "scale-0",
                                )}
                              />
                            </span>
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                              <span className="flex flex-wrap items-center gap-1.5">
                                <span
                                  className={cn(
                                    "text-[calc(12.5px*var(--zone-font-scale,1))] leading-[1.45]",
                                    selected ? "font-medium text-foreground" : "text-foreground/78",
                                  )}
                                >
                                  {option.label}
                                </span>
                                {option.recommended ? (
                                  <RecommendedTag label={t("chat.askUser.recommended")} />
                                ) : null}
                              </span>
                              {option.description ? (
                                <span className="text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5] text-muted-foreground/72">
                                  {option.description}
                                </span>
                              ) : null}
                            </span>
                          </button>
                        );
                      })}

                      {/* biome-ignore lint/a11y/useSemanticElements: This composite radio owns a nested custom text field and cannot be represented by a native radio. */}
                      <div
                        role="radio"
                        aria-checked={questionCustomSelected}
                        aria-disabled={!active || !canInteract}
                        tabIndex={active && canInteract ? 0 : -1}
                        onClick={() => selectCustom(question.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            selectCustom(question.id);
                          }
                        }}
                        className={cn(
                          "group/option relative flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors duration-150",
                          questionCustomSelected
                            ? "bg-foreground/[0.065] dark:bg-white/[0.085]"
                            : active && canInteract
                              ? "hover:bg-foreground/[0.035] dark:hover:bg-white/[0.055]"
                              : "",
                          !questionCustomSelected && (isSettled || cancelled || countdownExpired)
                            ? "opacity-50"
                            : "",
                          active && canInteract ? "cursor-pointer" : "cursor-default",
                        )}
                      >
                        <span
                          className={cn(
                            "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-[background-color,box-shadow] duration-200",
                            questionCustomSelected
                              ? "bg-foreground text-background"
                              : "shadow-[inset_0_0_0_1.5px_hsl(var(--muted-foreground)/0.4)] group-hover/option:shadow-[inset_0_0_0_1.5px_hsl(var(--muted-foreground)/0.7)]",
                          )}
                        >
                          <span
                            className={cn(
                              "h-1.5 w-1.5 rounded-full bg-background transition-transform duration-200",
                              questionCustomSelected ? "scale-100" : "scale-0",
                            )}
                          />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-1">
                          <span
                            className={cn(
                              "text-[calc(12.5px*var(--zone-font-scale,1))] leading-[1.45]",
                              questionCustomSelected
                                ? "font-medium text-foreground"
                                : "text-foreground/78",
                            )}
                          >
                            {t("chat.askUser.customOption")}
                          </span>
                          {active &&
                          questionCustomSelected &&
                          !isSettled &&
                          !cancelled &&
                          interactive ? (
                            <input
                              autoFocus
                              value={questionCustomText}
                              disabled={!canInteract}
                              maxLength={ASK_USER_QUESTION_CUSTOM_MAX_LENGTH}
                              placeholder={t("chat.askUser.customPlaceholder")}
                              aria-label={t("chat.askUser.customPlaceholder")}
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
                                  [question.id]: value,
                                }));
                              }}
                              className="ask-custom-input-enter mt-0.5 h-8 w-full rounded-lg border border-black/[0.075] bg-white/65 px-2.5 text-[calc(12px*var(--zone-font-scale,1))] text-foreground shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)] outline-none backdrop-blur-md transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-muted-foreground/45 focus:border-foreground/25 focus:bg-white/85 focus:ring-[2.5px] focus:ring-foreground/[0.08] dark:border-white/[0.1] dark:bg-white/[0.05] dark:focus:border-white/[0.18] dark:focus:bg-white/[0.08]"
                            />
                          ) : questionCustomSelected && questionCustomText ? (
                            <span className="break-words text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5] text-muted-foreground/75">
                              {questionCustomText}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    </fieldset>
                  </div>
                );
              })}
            </div>
          </div>

          {errorText ? (
            <div
              role="alert"
              className="mt-2 text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5] text-red-500"
            >
              {errorText}
            </div>
          ) : null}
        </div>

        <div className="flex min-h-11 items-center justify-between gap-3 border-t border-black/[0.055] px-3 py-2 dark:border-white/[0.07]">
          <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground/70">
            {questions.length > 1 ? (
              <>
                <button
                  type="button"
                  aria-label={t("chat.askUser.previousQuestion")}
                  disabled={safeActiveIndex === 0}
                  onClick={() => goToQuestion(safeActiveIndex - 1)}
                  className="flex h-[18px] w-[18px] items-center justify-center rounded-md transition-colors enabled:hover:bg-foreground/[0.05] enabled:hover:text-foreground disabled:opacity-30"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <span className="inline-flex items-center text-[calc(11px*var(--zone-font-scale,1))] font-medium tabular-nums leading-none">
                  <RollingDigits value={`${safeActiveIndex + 1} / ${questions.length}`} />
                </span>
                <button
                  type="button"
                  aria-label={t("chat.askUser.nextQuestion")}
                  disabled={safeActiveIndex === questions.length - 1}
                  onClick={() => goToQuestion(safeActiveIndex + 1)}
                  className="flex h-[18px] w-[18px] items-center justify-center rounded-md transition-colors enabled:hover:bg-foreground/[0.05] enabled:hover:text-foreground disabled:opacity-30"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </>
            ) : null}
            {interactive && !isSettled && !cancelled ? (
              <span
                role="timer"
                className="truncate text-[calc(10.5px*var(--zone-font-scale,1))] tabular-nums text-muted-foreground/60"
              >
                {questions.length > 1 ? "· " : null}
                {formatCountdown(remainingMs)} {t("chat.askUser.timeoutHint")}
              </span>
            ) : null}
          </div>

          {cancelled ? (
            <span className="text-right text-[calc(10.5px*var(--zone-font-scale,1))] leading-[1.35] text-muted-foreground/70">
              {t("chat.askUser.cancelled")}
            </span>
          ) : isSettled ? (
            timedOut ? (
              <span className="text-right text-[calc(10.5px*var(--zone-font-scale,1))] leading-[1.35] text-amber-600 dark:text-amber-400">
                {t("chat.askUser.timedOut")}
              </span>
            ) : (
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/[0.1] px-2 py-1 text-[calc(10.5px*var(--zone-font-scale,1))] font-medium leading-none text-emerald-600 dark:bg-emerald-400/[0.1] dark:text-emerald-400">
                <Check className="h-3 w-3" />
                {t("chat.askUser.answered")}
              </span>
            )
          ) : interactive ? (
            <div className="flex shrink-0 items-center gap-1.5">
              {questions.length > 1 && safeActiveIndex < questions.length - 1 ? (
                <button
                  type="button"
                  disabled={!canInteract}
                  onClick={() => goToQuestion(safeActiveIndex + 1)}
                  className="h-7 rounded-full px-3 text-[calc(11px*var(--zone-font-scale,1))] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.045] hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                  {t("chat.askUser.skip")}
                </button>
              ) : null}
              <button
                type="button"
                disabled={
                  safeActiveIndex === questions.length - 1
                    ? !allAnswered || !canInteract
                    : !isQuestionAnswered(activeQuestion.id) || !canInteract
                }
                onClick={() => {
                  if (safeActiveIndex === questions.length - 1) void submit();
                  else goToQuestion(safeActiveIndex + 1);
                }}
                className="inline-flex h-7 items-center justify-center gap-1.5 rounded-full bg-foreground px-3.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium text-background transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-35"
              >
                {submitting
                  ? t("chat.askUser.submitting")
                  : safeActiveIndex === questions.length - 1
                    ? t("chat.askUser.submit")
                    : t("chat.askUser.continue")}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
