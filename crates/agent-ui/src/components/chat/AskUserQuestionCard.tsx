// AskUserQuestion 的聊天卡片：逐题切换（顶部按 header 列出各题），单选或多选，推荐项排在首位；
// 纯展示组件，提交动作由调用方注入（GUI 直连工具挂起表，WebUI 走网关）。
// 两端直接复用本组件，端差异一律留在各端的 ToolCallItem。

import { Check, ChevronDown, ChevronUp } from "@liveagent/ui/components/IconSet";

import { Badge } from "@liveagent/ui/components/ui/badge";
import { Button } from "@liveagent/ui/components/ui/button";
import { Input } from "@liveagent/ui/components/ui/input";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useEffect, useMemo, useState } from "react";
import {
  ASK_USER_QUESTION_CUSTOM_MAX_LENGTH,
  ASK_USER_QUESTION_TIMEOUT_MS,
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
  buildMultiSelectAnswer,
  interpretAskUserQuestionAnswer,
} from "../../lib/chat/askUserQuestion";
import { cn } from "../../lib/shared/utils";
import { MotionDirectionalPanel } from "../MotionDirectionalPanel";

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
 *
 * 窗口从卡片首次可作答时算起，而不是挂载时：卡片随工具调用挂载，提问可能
 * 等 AI 审查或审批之后才登记，截止时间也从那时起算。
 */
function useAnswerCountdown(active: boolean, deadlineAt?: number) {
  const [openedAt, setOpenedAt] = useState<number | null>(() => (active ? Date.now() : null));
  if (active && openedAt === null) setOpenedAt(Date.now());
  const windowStart = openedAt ?? Date.now();
  const deadline =
    deadlineAt !== undefined &&
    deadlineAt > windowStart &&
    deadlineAt <= windowStart + ASK_USER_QUESTION_TIMEOUT_MS
      ? deadlineAt
      : windowStart + ASK_USER_QUESTION_TIMEOUT_MS;
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

/** 题目的短标签：header，缺省回退为“Q1”“Q2”…。 */
export function askUserQuestionTabLabel(
  question: AskUserQuestionItem,
  index: number,
  fallback: string,
) {
  return question.header || `${fallback}${index + 1}`;
}

/** 选项左侧的选择标记：单选为圆点，多选为方框加勾。 */
function ChoiceMark({
  multiple,
  selected,
  inline = false,
}: {
  multiple: boolean;
  selected: boolean;
  /** 与输入框同行时垂直居中，不加顶部偏移。 */
  inline?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center border",
        inline ? "" : "mt-0.5",
        multiple ? "rounded-sm" : "rounded-full",
        "transition-[background-color,border-color] duration-200",
        selected
          ? "border-foreground bg-foreground text-background"
          : "border-muted-foreground/40 group-hover/option:border-muted-foreground/70",
      )}
    >
      {multiple ? (
        selected ? (
          <Check className="size-3" />
        ) : null
      ) : (
        <span
          className={cn(
            "size-1.5 rounded-full bg-background transition-transform duration-200",
            selected ? "scale-100" : "scale-0",
          )}
        />
      )}
    </span>
  );
}

function RecommendedTag({ label }: { label: string }) {
  return (
    <Badge variant="success" className="border-transparent px-1.5 text-xs">
      {label}
    </Badge>
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
  /** 应答窗口已超时；旧版结果可能仍包含自动选择的答案。 */
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

  const { settledSelections, settledCustom, settledMulti, settledCustomText } = useMemo(() => {
    const selections: Record<string, string> = {};
    const custom: Record<string, boolean> = {};
    const multi: Record<string, string[]> = {};
    const customText: Record<string, string> = {};
    for (const settled of answers ?? []) {
      // 只带拼接 label 的多选应答（旧记录、直连回放）按问题定义拆回选项。
      const question = questions.find((item) => item.id === settled.questionId);
      const answer =
        question?.multiple && !settled.selectedLabels
          ? (interpretAskUserQuestionAnswer(question, settled.selectedLabel, settled.custom) ??
            settled)
          : settled;
      selections[answer.questionId] = answer.selectedLabel;
      if (answer.selectedLabels) {
        multi[answer.questionId] = answer.selectedLabels;
        if (answer.customText) {
          custom[answer.questionId] = true;
          customText[answer.questionId] = answer.customText;
        }
      } else if (answer.custom === true) {
        custom[answer.questionId] = true;
        customText[answer.questionId] = answer.selectedLabel;
      }
    }
    return {
      settledSelections: selections,
      settledCustom: custom,
      settledMulti: multi,
      settledCustomText: customText,
    };
  }, [answers, questions]);

  const isSettled = (answers?.length ?? 0) > 0;
  const showFinal = isSettled || cancelled || timedOut;
  const selections = showFinal ? settledSelections : draftSelections;
  const countdownActive = interactive && !isSettled && !cancelled && !timedOut;
  const remainingMs = useAnswerCountdown(countdownActive, deadlineAt);
  const countdownExpired = countdownActive && remainingMs <= 0;
  const canInteract = countdownActive && remainingMs > 0 && !submitting;
  // 多选题的草稿：按 questionId 记选中的列出选项（声明在倒计时之后，保持既有状态顺序）。
  const [draftMulti, setDraftMulti] = useState<Record<string, string[]>>({});
  const safeActiveIndex = Math.min(activeIndex, Math.max(questions.length - 1, 0));

  // 该题是否已作答：普通选项已选，或“其他”选中且文本非空。
  const isQuestionAnswered = (question: AskUserQuestionItem) => {
    const questionId = question.id;
    if (showFinal) return Boolean(settledSelections[questionId]);
    if (question.multiple) {
      const customFilled = Boolean(customSelected[questionId] && customTexts[questionId]?.trim());
      return (draftMulti[questionId]?.length ?? 0) > 0 || customFilled;
    }
    if (customSelected[questionId]) return Boolean(customTexts[questionId]?.trim());
    return Boolean(draftSelections[questionId]);
  };

  if (questions.length === 0) return null;

  const activeQuestion = questions[safeActiveIndex];
  const answeredCount = questions.filter((question) => isQuestionAnswered(question)).length;
  const allAnswered = answeredCount === questions.length;
  // 带方向切题：内容轨道纵向滑动，当前题再附一层轻量方向过渡。
  const goToQuestion = (index: number) => {
    if (index === safeActiveIndex || index < 0 || index >= questions.length) return;
    setSwitchDirection(index > safeActiveIndex ? "forward" : "backward");
    setActiveIndex(index);
  };

  const selectOption = (question: AskUserQuestionItem, label: string) => {
    if (!canInteract) return;
    const questionId = question.id;
    setErrorText("");
    if (question.multiple) {
      // 多选：逐项勾选/取消，与“其他”可以并存。
      setDraftMulti((current) => {
        const chosen = current[questionId] ?? [];
        const next = chosen.includes(label)
          ? chosen.filter((value) => value !== label)
          : [...chosen, label];
        return { ...current, [questionId]: next };
      });
      return;
    }
    setCustomSelected((current) => {
      if (!current[questionId]) return current;
      const next = { ...current };
      delete next[questionId];
      return next;
    });
    // 选中不跳题：翻页一律由用户点「继续」/上下箭头决定，避免选错后
    // 画面已经滑走、找不回来。与下方「其他」行的行为保持一致。
    setDraftSelections((current) => ({ ...current, [questionId]: label }));
  };

  // 选中“其他”行：单选题清掉该题的普通选项，等待用户输入（不自动跳题）；
  // 多选题与已勾选的选项并存，点复选框可取消。
  const selectCustom = (question: AskUserQuestionItem, toggle = false) => {
    if (!canInteract) return;
    const questionId = question.id;
    setErrorText("");
    if (question.multiple) {
      setCustomSelected((current) => {
        if (toggle && current[questionId]) {
          const next = { ...current };
          delete next[questionId];
          return next;
        }
        return current[questionId] ? current : { ...current, [questionId]: true };
      });
      return;
    }
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
      if (question.multiple) {
        return buildMultiSelectAnswer(
          question,
          draftMulti[question.id] ?? [],
          customSelected[question.id] ? (customTexts[question.id] ?? "") : "",
        );
      }
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

  const tabFallback = t("chat.askUser.tabFallback");

  return (
    <div className="w-full max-w-panel-36rem">
      <div className="overflow-hidden rounded-xl border border-border/60 bg-muted/20">
        {questions.length > 1 ? (
          // 各题的短标签（header，缺省 Q1…）：一眼看到共有几题、哪些已答，点击直接切题。
          <div
            role="tablist"
            aria-label={t("chat.tool.askUserTitle")}
            className="flex items-center gap-1 overflow-x-auto border-b border-border/60 px-2 py-1.5"
          >
            {questions.map((question, index) => {
              const selected = index === safeActiveIndex;
              const answered = isQuestionAnswered(question);
              return (
                <button
                  key={question.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  data-ask-question-tab={question.id}
                  onClick={() => goToQuestion(index)}
                  className={cn(
                    "flex h-6 max-w-40 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium leading-none",
                    "transition-colors duration-150",
                    selected
                      ? "bg-foreground/[0.07] text-foreground"
                      : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground/80",
                  )}
                >
                  {answered ? (
                    <Check className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  ) : null}
                  <span className="truncate">
                    {askUserQuestionTabLabel(question, index, tabFallback)}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="px-4 pb-3 pt-4">
          {/* 只渲染当前题、高度自然撑开。此前用「固定高度视口 + transform
              轨道 + offsetTop 测量」实现纵向滑动，但 offsetTop 依赖
              offsetParent，而这条链上没有定位祖先，会算出错误偏移并留下
              大片空白；方向滑入改由下方 CSS 动画类承担。 */}
          <div aria-live="polite">
            {questions.map((question, questionIndex) => {
              const active = questionIndex === safeActiveIndex;
              if (!active) return null;
              const multiple = question.multiple === true;
              const questionCustomSelected = showFinal
                ? Boolean(settledCustom[question.id])
                : Boolean(customSelected[question.id]);
              const questionCustomText = showFinal
                ? (settledCustomText[question.id] ?? "")
                : (customTexts[question.id] ?? "");
              const chosenLabels = showFinal
                ? (settledMulti[question.id] ?? [])
                : (draftMulti[question.id] ?? []);
              const optionRole = multiple ? "checkbox" : "radio";
              return (
                <MotionDirectionalPanel
                  key={question.id}
                  panelKey={question.id}
                  direction={switchDirection}
                >
                  {questions.length === 1 && question.header ? (
                    <div className="mb-1 text-xs font-medium text-muted-foreground">
                      {question.header}
                    </div>
                  ) : null}
                  <div className="text-sm font-medium leading-1p5 text-foreground">
                    {question.prompt}
                  </div>
                  {multiple ? (
                    <div className="mt-0.5 text-xs text-muted-foreground/80">
                      {t("chat.askUser.multipleHint")}
                    </div>
                  ) : null}

                  <fieldset
                    role={multiple ? "group" : "radiogroup"}
                    aria-label={question.prompt}
                    className="mt-2.5 flex min-w-0 flex-col gap-1 border-0 p-0"
                  >
                    {question.options.map((option) => {
                      const selected = multiple
                        ? chosenLabels.includes(option.label)
                        : !questionCustomSelected && selections[question.id] === option.label;
                      const disabled = !active || !canInteract;
                      return (
                        // biome-ignore lint/a11y/useAriaPropsSupportedByRole: optionRole is radio or checkbox, both of which support aria-checked.
                        <button
                          key={option.label}
                          type="button"
                          role={optionRole}
                          aria-checked={selected}
                          disabled={disabled}
                          tabIndex={active ? 0 : -1}
                          onClick={() => selectOption(question, option.label)}
                          className={cn(
                            "group/option relative flex w-full items-start gap-2 rounded-lg p-2",
                            "text-left transition-colors duration-150",
                            selected
                              ? "bg-foreground/6"
                              : active && canInteract
                                ? "hover:bg-foreground/4"
                                : "",
                            !selected && (isSettled || cancelled || countdownExpired)
                              ? "opacity-50"
                              : "",
                            active && canInteract ? "cursor-pointer" : "cursor-default",
                          )}
                        >
                          <ChoiceMark multiple={multiple} selected={selected} />
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span
                                className={cn(
                                  "text-xs leading-1p45",
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
                              <span className="text-xs leading-1p5 text-muted-foreground/72">
                                {option.description}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      );
                    })}

                    {/* 自定义回答：保留选择标记使左缘与上方选项对齐，输入框直接
                        占据标签位置。切换到本项只由「真正输入」或点选择标记触发，
                        不能用 onFocus：输入框常驻且排在选项之后，键盘 Tab 路过
                        它就会清掉已选选项，使该题变回未作答、提交按钮禁用。 */}
                    {interactive && !showFinal ? (
                      <div
                        className={cn(
                          "group/option flex w-full items-center gap-2 rounded-lg p-2",
                          "transition-colors duration-150",
                          questionCustomSelected ? "bg-foreground/6" : "",
                        )}
                      >
                        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: optionRole is radio or checkbox, both of which support aria-checked. */}
                        <button
                          type="button"
                          role={optionRole}
                          aria-checked={questionCustomSelected}
                          aria-label={t("chat.askUser.customPlaceholder")}
                          disabled={!canInteract}
                          onClick={() => selectCustom(question, true)}
                          className={cn(
                            "flex shrink-0 items-center justify-center",
                            canInteract ? "cursor-pointer" : "cursor-default",
                          )}
                        >
                          <ChoiceMark
                            multiple={multiple}
                            selected={questionCustomSelected}
                            inline
                          />
                        </button>
                        <Input
                          value={questionCustomText}
                          disabled={!canInteract}
                          maxLength={ASK_USER_QUESTION_CUSTOM_MAX_LENGTH}
                          placeholder={t("chat.askUser.customPlaceholder")}
                          aria-label={t("chat.askUser.customPlaceholder")}
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
                            selectCustom(question);
                            setCustomTexts((current) => ({
                              ...current,
                              [question.id]: value,
                            }));
                          }}
                          className={cn(
                            "h-8 min-w-0 flex-1 bg-transparent text-xs shadow-none",
                            questionCustomSelected ? "border-foreground/35" : "border-border/60",
                          )}
                        />
                      </div>
                    ) : questionCustomSelected && questionCustomText ? (
                      <div className="flex w-full items-center gap-2 rounded-lg p-2">
                        <ChoiceMark multiple={multiple} selected inline />
                        <span className="min-w-0 flex-1 wrap-break-word text-xs font-medium leading-1p45 text-foreground">
                          {questionCustomText}
                        </span>
                      </div>
                    ) : null}
                  </fieldset>
                </MotionDirectionalPanel>
              );
            })}
          </div>

          {errorText ? (
            <div role="alert" className="mt-2 text-xs leading-1p5 text-destructive">
              {errorText}
            </div>
          ) : null}
        </div>

        <div
          className={cn(
            "flex min-h-11 items-center justify-between gap-3 border-t border-border/60",
            "px-3 py-2",
          )}
        >
          <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground/70">
            {questions.length > 1 ? (
              <>
                <button
                  type="button"
                  aria-label={t("chat.askUser.previousQuestion")}
                  disabled={safeActiveIndex === 0}
                  onClick={() => goToQuestion(safeActiveIndex - 1)}
                  className={cn(
                    "flex size-18px items-center justify-center rounded-md transition-colors",
                    "enabled:hover:bg-foreground/[0.05] enabled:hover:text-foreground disabled:opacity-30",
                  )}
                >
                  <ChevronUp className="size-3.5" />
                </button>
                <span className="inline-flex items-center text-xs font-medium tabular-nums leading-none">
                  {safeActiveIndex + 1} / {questions.length}
                </span>
                <button
                  type="button"
                  aria-label={t("chat.askUser.nextQuestion")}
                  disabled={safeActiveIndex === questions.length - 1}
                  onClick={() => goToQuestion(safeActiveIndex + 1)}
                  className={cn(
                    "flex size-18px items-center justify-center rounded-md transition-colors",
                    "enabled:hover:bg-foreground/[0.05] enabled:hover:text-foreground disabled:opacity-30",
                  )}
                >
                  <ChevronDown className="size-3.5" />
                </button>
              </>
            ) : null}
            {interactive && !showFinal ? (
              <span role="timer" className="truncate text-xs tabular-nums text-muted-foreground/60">
                {questions.length > 1 ? "· " : null}
                {formatCountdown(remainingMs)} {t("chat.askUser.timeoutHint")}
              </span>
            ) : null}
          </div>

          {cancelled ? (
            <span className="text-right text-xs leading-1p35 text-muted-foreground/70">
              {t("chat.askUser.cancelled")}
            </span>
          ) : timedOut && !isSettled ? (
            // K-brain no longer picks an option on timeout, so a timed-out card can carry no
            // answers; it is finished all the same and must say nothing was chosen.
            <span className="text-right text-xs leading-1p35 text-amber-600 dark:text-amber-400">
              {t("chat.askUser.timedOutNoSelection")}
            </span>
          ) : isSettled ? (
            timedOut ? (
              // Older backends and the local tool still auto-select on timeout.
              <span className="text-right text-xs leading-1p35 text-amber-600 dark:text-amber-400">
                {t("chat.askUser.timedOut")}
              </span>
            ) : (
              <Badge variant="success" className="text-xs">
                <Check className="size-3" />
                {t("chat.askUser.answered")}
              </Badge>
            )
          ) : interactive ? (
            <div className="flex shrink-0 items-center gap-1.5">
              {questions.length > 1 && safeActiveIndex < questions.length - 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!canInteract}
                  onClick={() => goToQuestion(safeActiveIndex + 1)}
                  className="h-7 rounded-full px-3 text-xs text-muted-foreground hover:text-foreground"
                >
                  {t("chat.askUser.skip")}
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                disabled={
                  safeActiveIndex === questions.length - 1
                    ? !allAnswered || !canInteract
                    : !isQuestionAnswered(activeQuestion) || !canInteract
                }
                onClick={() => {
                  if (safeActiveIndex === questions.length - 1) void submit();
                  else goToQuestion(safeActiveIndex + 1);
                }}
                className="h-7 gap-1.5 rounded-full px-3.5 text-xs"
              >
                {submitting
                  ? t("chat.askUser.submitting")
                  : safeActiveIndex === questions.length - 1
                    ? t("chat.askUser.submit")
                    : t("chat.askUser.continue")}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
