// crates/agent-ui/src/components/chat/clarify/ClarifyPanel.tsx
// 结构化澄清面板：模型每轮给出一批可点选的问题（单选/多选 + 「其他」自由
// 输入），用户点选后整轮提交；也可随时携带已选部分「直接生成提示词」。
// 已提交的轮次折叠为只读摘要，终稿轮以流式文本预览。
import {
  Check,
  CheckCircle2,
  Loader2,
  Pencil,
  RefreshCw,
  Sparkles,
  WandSparkles,
  X,
} from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { isClarifyListFollowing, pinClarifyListIfFollowing } from "./clarifyPanelScroll";
import type { ClarifyAnswer, ClarifyQuestion, ClarifyRound } from "./clarifyTypes";
import type { ClarifySessionState } from "./useClarifySession";

type ClarifyPanelProps = {
  state: ClarifySessionState;
  busy: boolean;
  onSubmitAnswers: (answers: ClarifyAnswer[]) => void;
  /** 就按已有回答直接生成终稿；携带当前轮已选的部分回答。 */
  onGenerateNow: (answers: ClarifyAnswer[]) => void;
  onRetry: () => void;
  onClose: () => void;
};

/** 待作答轮里单题的草稿选择。 */
type DraftAnswer = {
  labels: string[];
  custom: boolean;
  customText: string;
};

const EMPTY_DRAFT: DraftAnswer = { labels: [], custom: false, customText: "" };

/** 开放问题（模型未给选项）没有可点选行，自由输入即唯一回答方式。 */
function draftFor(question: ClarifyQuestion, answers: Record<string, DraftAnswer>): DraftAnswer {
  const existing = answers[question.id];
  if (existing) return existing;
  return question.options.length === 0 ? { ...EMPTY_DRAFT, custom: true } : EMPTY_DRAFT;
}

function isDraftAnswered(draft: DraftAnswer): boolean {
  return draft.labels.length > 0 || (draft.custom && draft.customText.trim().length > 0);
}

function RecommendedTag({ label }: { label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-gradient-to-r from-amber-400/25 to-amber-500/15 px-1.5 py-0.5 text-[calc(9px*var(--zone-font-scale,1))] font-semibold leading-none text-amber-700 ring-1 ring-inset ring-amber-500/25 dark:from-amber-300/[0.18] dark:to-amber-400/[0.10] dark:text-amber-300 dark:ring-amber-300/20">
      <Sparkles className="h-2.5 w-2.5" />
      {label}
    </span>
  );
}

/** 选中指示圈：单选圆形、多选圆角方形，与原生控件视觉习惯对齐。 */
function SelectionIndicator({ selected, multiple }: { selected: boolean; multiple?: boolean }) {
  return (
    <span
      className={cn(
        "mt-[2px] flex h-3.5 w-3.5 shrink-0 items-center justify-center border transition-colors",
        multiple ? "rounded-[4px]" : "rounded-full",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-muted-foreground/40 group-hover/option:border-muted-foreground/70",
      )}
    >
      {selected ? <Check className="h-2.5 w-2.5" /> : null}
    </span>
  );
}

/** 选项行公共外观：选中高亮、悬停描边、推荐项琥珀底色、只读降透明。 */
function choiceRowClassName(selected: boolean, interactive: boolean, recommended = false): string {
  return cn(
    "group/option flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors",
    selected
      ? "border-primary/45 bg-primary/[0.06] dark:border-primary/40 dark:bg-primary/[0.1]"
      : recommended
        ? "border-amber-400/45 bg-gradient-to-r from-amber-400/[0.09] to-amber-300/[0.03] dark:border-amber-300/30 dark:from-amber-300/[0.08] dark:to-amber-200/[0.02]"
        : "border-border/40 dark:border-white/[0.07]",
    interactive && !selected
      ? recommended
        ? "hover:border-amber-400/70 hover:from-amber-400/[0.14] dark:hover:border-amber-300/50"
        : "hover:border-border/70 hover:bg-foreground/[0.03] dark:hover:border-white/[0.14]"
      : "",
    interactive ? "cursor-pointer" : "cursor-default opacity-70",
  );
}

type ChoiceRowProps = {
  multiple: boolean;
  selected: boolean;
  interactive: boolean;
  recommended?: boolean;
  onSelect: () => void;
  children: ReactNode;
};

/** 模型给出的选项行。role/aria-checked 用字面量分支书写，a11y 规则才能静态校验。 */
function OptionChoiceButton({
  multiple,
  selected,
  interactive,
  recommended,
  onSelect,
  children,
}: ChoiceRowProps) {
  const shared = {
    type: "button" as const,
    disabled: !interactive,
    onClick: onSelect,
    className: choiceRowClassName(selected, interactive, recommended),
  };
  if (multiple) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: 选项行含推荐角标/描述富内容，按 ARIA checkbox 模式保持单一可聚焦按钮。
      <button role="checkbox" aria-checked={selected} {...shared}>
        {children}
      </button>
    );
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: 选项行含推荐角标/描述富内容，按 ARIA radio 模式保持单一可聚焦按钮。
    <button role="radio" aria-checked={selected} {...shared}>
      {children}
    </button>
  );
}

/** 「其他（自行输入）」行：内嵌输入框，button 不能嵌套 input，故用 div role。 */
function CustomChoiceRow({ multiple, selected, interactive, onSelect, children }: ChoiceRowProps) {
  const tabIndex = interactive ? 0 : -1;
  const shared = {
    "aria-disabled": !interactive,
    onClick: () => {
      if (interactive) onSelect();
    },
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (interactive) onSelect();
      }
    },
    className: choiceRowClassName(selected, interactive),
  };
  if (multiple) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: 行内嵌自由输入框，原生 checkbox/button 会产生非法嵌套交互元素。
      <div role="checkbox" aria-checked={selected} tabIndex={tabIndex} {...shared}>
        {children}
      </div>
    );
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: 行内嵌自由输入框，原生 radio/button 会产生非法嵌套交互元素。
    <div role="radio" aria-checked={selected} tabIndex={tabIndex} {...shared}>
      {children}
    </div>
  );
}

/** 一道问题的选项容器：多选用 fieldset 的隐式 group 语义，单选补 radiogroup。 */
function ChoiceGroup({
  multiple,
  label,
  children,
}: {
  multiple: boolean;
  label: string;
  children: ReactNode;
}) {
  const className = "flex min-w-0 flex-col gap-1 border-0 p-0";
  if (multiple) {
    return (
      <fieldset aria-label={label} className={className}>
        {children}
      </fieldset>
    );
  }
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA in HTML 允许 fieldset 担任 radiogroup；子项 role="radio" 需要 radiogroup 上下文。
    <fieldset role="radiogroup" aria-label={label} className={className}>
      {children}
    </fieldset>
  );
}

/**
 * 已提交轮次的只读摘要卡片：轮次头（绿勾 + 轮次号）+ 逐题「Q 徽标 + 问题」，
 * 回答以 chips 呈现——点选项是主色胶囊、自由输入是虚线 sky 胶囊（笔形图标），
 * 未回答显示斜体占位。
 */
function SettledRoundSummary({
  round,
  roundLabel,
  skippedLabel,
}: {
  round: ClarifyRound;
  roundLabel: string;
  skippedLabel: string;
}) {
  const answersById = new Map((round.answers ?? []).map((answer) => [answer.questionId, answer]));
  return (
    <div className="overflow-hidden rounded-xl border border-black/[0.05] bg-white/45 dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex items-center gap-1.5 border-b border-black/[0.04] bg-muted/35 px-2.5 py-1 dark:border-white/[0.05] dark:bg-white/[0.03]">
        <CheckCircle2 className="h-3 w-3 text-emerald-500" />
        <span className="text-[calc(10px*var(--zone-font-scale,1))] font-medium uppercase tracking-wide text-muted-foreground/75">
          {roundLabel}
        </span>
      </div>
      <div className="flex flex-col gap-2.5 px-2.5 py-2">
        {round.questions.map((question, index) => {
          const answer = answersById.get(question.id);
          const labels = (answer?.selectedLabels ?? []).filter((label) => label.trim().length > 0);
          const custom = answer?.customText?.trim();
          const answered = labels.length > 0 || Boolean(custom);
          return (
            <div key={question.id} className="flex flex-col gap-1">
              <div className="flex items-start gap-1.5">
                <span className="mt-[1px] inline-flex h-4 shrink-0 items-center justify-center rounded-[5px] bg-foreground/[0.05] px-1 text-[calc(9px*var(--zone-font-scale,1))] font-semibold leading-none text-muted-foreground/80 dark:bg-white/[0.07]">
                  Q{index + 1}
                </span>
                <span className="min-w-0 text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5] text-muted-foreground">
                  {question.prompt}
                </span>
              </div>
              <div className="ml-[22px] flex flex-wrap items-center gap-1">
                {labels.map((label) => (
                  <span
                    key={label}
                    className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/25 bg-primary/[0.08] px-1.5 py-0.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium leading-[1.4] text-foreground/85 dark:border-primary/30 dark:bg-primary/[0.12]"
                  >
                    <Check className="h-2.5 w-2.5 shrink-0 text-primary" />
                    <span className="min-w-0 break-words">{label}</span>
                  </span>
                ))}
                {custom ? (
                  <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-dashed border-sky-500/35 bg-sky-500/[0.07] px-1.5 py-0.5 text-[calc(11px*var(--zone-font-scale,1))] leading-[1.4] text-foreground/80 dark:border-sky-300/30 dark:bg-sky-300/[0.08]">
                    <Pencil className="h-2.5 w-2.5 shrink-0 text-sky-600 dark:text-sky-300" />
                    <span className="min-w-0 break-words">{custom}</span>
                  </span>
                ) : null}
                {!answered ? (
                  <span className="text-[calc(11px*var(--zone-font-scale,1))] italic leading-[1.4] text-muted-foreground/55">
                    {skippedLabel}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 浮在输入卡片正上方的澄清面板：草稿引用 + 轮次问答 + 底部操作栏。 */
export function ClarifyPanel(props: ClarifyPanelProps) {
  const { state, busy, onSubmitAnswers, onGenerateNow, onRetry, onClose } = props;
  const { t } = useLocale();
  const listRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  const pendingIndex = state.rounds.length - 1;
  const lastRound = state.rounds.at(-1);
  const pendingRound =
    state.status === "awaitingInput" && lastRound && lastRound.answers === null ? lastRound : null;

  // 待作答轮的草稿选择 + 当前激活的 tab，按轮次序号建档；轮次推进时在渲染期
  // 一并重置（React 官方「adjusting state during render」派生状态模式，
  // 避免 useEffect 造成一帧陈旧草稿闪现）。
  const [draftState, setDraftState] = useState<{
    round: number;
    answers: Record<string, DraftAnswer>;
    activeIndex: number;
  }>({ round: -1, answers: {}, activeIndex: 0 });
  // 切题方向（首次渲染为 null 不播动画）；keyed 内容区据此选滑入方向。
  const [switchDirection, setSwitchDirection] = useState<"forward" | "backward" | null>(null);
  if (pendingRound && draftState.round !== pendingIndex) {
    setDraftState({ round: pendingIndex, answers: {}, activeIndex: 0 });
    setSwitchDirection(null);
  }
  const draftAnswers = draftState.answers;
  const questionCount = pendingRound?.questions.length ?? 0;
  const safeActiveIndex = Math.min(draftState.activeIndex, Math.max(0, questionCount - 1));
  const activeQuestion = pendingRound?.questions[safeActiveIndex] ?? null;

  // 带方向切题：内容区按 question.id 重挂载并向对应方向滑入。
  const goToQuestion = (index: number) => {
    if (index === safeActiveIndex || index < 0 || index >= questionCount) return;
    setSwitchDirection(index > safeActiveIndex ? "forward" : "backward");
    setDraftState((current) => ({ ...current, activeIndex: index }));
  };

  const updateDraft = (
    question: ClarifyQuestion,
    updater: (current: DraftAnswer) => DraftAnswer,
  ) => {
    setDraftState((current) => ({
      ...current,
      answers: {
        ...current.answers,
        [question.id]: updater(draftFor(question, current.answers)),
      },
    }));
  };

  const selectOption = (question: ClarifyQuestion, label: string) => {
    if (question.allowMultiple) {
      updateDraft(question, (current) => {
        const selected = current.labels.includes(label);
        return {
          ...current,
          labels: selected
            ? current.labels.filter((item) => item !== label)
            : [...current.labels, label],
        };
      });
      return;
    }
    // 单选：落定本题后自动跳到下一道未作答的题，减少手动切 tab。
    const nextAnswers: Record<string, DraftAnswer> = {
      ...draftAnswers,
      [question.id]: {
        ...draftFor(question, draftAnswers),
        labels: [label],
        custom: false,
      },
    };
    const nextUnanswered =
      pendingRound?.questions.findIndex(
        (item, index) => index !== safeActiveIndex && !isDraftAnswered(draftFor(item, nextAnswers)),
      ) ?? -1;
    if (nextUnanswered >= 0) {
      setSwitchDirection(nextUnanswered > safeActiveIndex ? "forward" : "backward");
    }
    setDraftState((current) => ({
      ...current,
      answers: nextAnswers,
      activeIndex: nextUnanswered >= 0 ? nextUnanswered : current.activeIndex,
    }));
  };

  const selectCustom = (question: ClarifyQuestion) => {
    updateDraft(question, (current) => {
      if (question.allowMultiple) return { ...current, custom: !current.custom };
      return { labels: [], custom: true, customText: current.customText };
    });
  };

  const setCustomText = (question: ClarifyQuestion, text: string) => {
    updateDraft(question, (current) => ({ ...current, customText: text }));
  };

  const buildAnswers = (): ClarifyAnswer[] => {
    if (!pendingRound) return [];
    return pendingRound.questions.map((question) => {
      const draft = draftFor(question, draftAnswers);
      const custom = draft.custom ? draft.customText.trim() : "";
      return {
        questionId: question.id,
        prompt: question.prompt,
        selectedLabels: draft.labels.slice(),
        ...(custom ? { customText: custom } : {}),
      };
    });
  };

  const interactive = state.status === "awaitingInput" && Boolean(pendingRound);
  const answeredCount = pendingRound
    ? pendingRound.questions.filter((question) => isDraftAnswered(draftFor(question, draftAnswers)))
        .length
    : 0;
  const totalCount = pendingRound?.questions.length ?? 0;
  const allAnswered = totalCount > 0 && answeredCount === totalCount;

  const submit = () => {
    if (!interactive || !allAnswered) return;
    onSubmitAnswers(buildAnswers());
  };

  const generateNow = () => {
    if (busy || state.status === "done") return;
    onGenerateNow(buildAnswers());
  };

  // 流式增量必须在绘制前钉底，否则最新行会闪一帧裁切。max-h 钳制后滚动
  // 容器自身不再长高，ResizeObserver 盯内部内容盒（换行/页脚挤占）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 轮次/流式/状态是钉底触发信号，effect 体只写 scrollTop。
  useLayoutEffect(() => {
    pinClarifyListIfFollowing(listRef.current, followRef.current);
  }, [state.rounds, state.streamingText, state.status, state.error, busy]);

  useLayoutEffect(() => {
    const viewport = listRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const content = viewport.firstElementChild;
    const observer = new ResizeObserver(() => {
      pinClarifyListIfFollowing(viewport, followRef.current);
    });
    observer.observe(viewport);
    if (content instanceof Element) observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const progressText = t("chat.clarify.progress")
    .replace("{answered}", String(answeredCount))
    .replace("{total}", String(totalCount));

  return (
    // 独立浮层：宽度与队列面板对齐（左右各收 0.75rem），与输入卡片留出
    // 1.5rem 间隙——卡片上缘是 rounded-3xl 圆角，贴合式（border-b-0 +
    // mb-[-1px]）只适合队列那种直角底边。shrink-0 兜展开态——外层列是
    // flex-col justify-end，卡片 flex-1 吸收伸缩，面板高度只受 max-h-[50vh]
    // 钳制，不参与压缩。
    <div
      data-clarify-panel=""
      className="relative z-30 mx-auto mb-1.5 flex max-h-[50vh] min-h-0 w-[calc(100%-1.5rem)] max-w-[720px] shrink-0 flex-col overflow-hidden rounded-2xl border border-black/[0.055] bg-white/80 shadow-[0_8px_24px_-18px_rgba(15,23,42,0.24),inset_0_1px_0_rgba(255,255,255,0.72)] backdrop-blur-2xl backdrop-saturate-[165%] dark:border-white/[0.10] dark:bg-white/[0.06] dark:shadow-[0_8px_24px_-18px_rgba(0,0,0,0.72),inset_0_1px_0_rgba(255,255,255,0.08)]"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium text-muted-foreground">
          <WandSparkles className="h-3.5 w-3.5" />
          {t("chat.clarify.title")}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("chat.clarify.close")}
          title={t("chat.clarify.close")}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div
        ref={listRef}
        data-clarify-messages=""
        className="chat-queue-scroll min-h-0 overflow-y-auto px-3 pb-2 [overflow-anchor:none]"
        onScroll={() => {
          const el = listRef.current;
          if (!el) return;
          followRef.current = isClarifyListFollowing(el);
        }}
      >
        <div className="flex flex-col gap-2">
          {state.draftText ? (
            <div className="rounded-xl bg-primary/10 px-2.5 py-1.5">
              <span className="mr-1.5 text-[calc(10px*var(--zone-font-scale,1))] font-medium uppercase tracking-wide text-muted-foreground/70">
                {t("chat.clarify.draftLabel")}
              </span>
              <span className="line-clamp-2 whitespace-pre-wrap break-words text-[calc(11px*var(--zone-font-scale,1))] leading-relaxed text-foreground/80">
                {state.draftText}
              </span>
            </div>
          ) : null}

          {state.rounds.map((round, roundIndex) =>
            round.answers !== null ? (
              <SettledRoundSummary
                // biome-ignore lint/suspicious/noArrayIndexKey: 轮次列表只追加不重排，索引 key 稳定唯一。
                key={roundIndex}
                round={round}
                roundLabel={t("chat.clarify.roundLabel").replace("{round}", String(roundIndex + 1))}
                skippedLabel={t("chat.clarify.skipped")}
              />
            ) : null,
          )}

          {pendingRound && activeQuestion
            ? (() => {
                const draft = draftFor(activeQuestion, draftAnswers);
                const hasOptions = activeQuestion.options.length > 0;
                const customVisible = draft.custom;
                return (
                  <div className="flex flex-col gap-2 pt-0.5">
                    {/* 一次只展示一道题：多题时顶部 tabs 切换，已作答题带对勾。 */}
                    {questionCount > 1 ? (
                      <div className="flex items-center gap-1 overflow-x-auto border-b border-black/[0.05] pb-1.5 dark:border-white/[0.06]">
                        {pendingRound.questions.map((question, index) => {
                          const isActive = index === safeActiveIndex;
                          const isAnswered = isDraftAnswered(draftFor(question, draftAnswers));
                          return (
                            <button
                              key={question.id}
                              type="button"
                              onClick={() => goToQuestion(index)}
                              className={cn(
                                "flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[calc(11px*var(--zone-font-scale,1))] font-medium leading-none transition-colors",
                                isActive
                                  ? "bg-foreground/[0.07] text-foreground dark:bg-white/[0.09]"
                                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground/80",
                              )}
                            >
                              {isAnswered ? <Check className="h-3 w-3 text-emerald-500" /> : null}
                              {question.header || `${t("chat.clarify.tabFallback")} ${index + 1}`}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}

                    {/* key 触发重挂载，切题时按方向播放轻量滑入动画。 */}
                    <div
                      key={activeQuestion.id}
                      className={cn(
                        "flex flex-col gap-1.5",
                        switchDirection === "forward" ? "ask-question-enter-forward" : "",
                        switchDirection === "backward" ? "ask-question-enter-backward" : "",
                      )}
                    >
                      <div className="text-[calc(12.5px*var(--zone-font-scale,1))] font-medium leading-[1.55] text-foreground/90">
                        {activeQuestion.prompt}
                        {activeQuestion.allowMultiple ? (
                          <span className="ml-1.5 text-[calc(10px*var(--zone-font-scale,1))] font-normal text-muted-foreground/70">
                            {t("chat.clarify.multiHint")}
                          </span>
                        ) : null}
                      </div>

                      <ChoiceGroup
                        multiple={Boolean(activeQuestion.allowMultiple)}
                        label={activeQuestion.prompt}
                      >
                        {activeQuestion.options.map((option) => {
                          const isSelected = draft.labels.includes(option.label);
                          return (
                            <OptionChoiceButton
                              key={option.label}
                              multiple={Boolean(activeQuestion.allowMultiple)}
                              selected={isSelected}
                              interactive={interactive}
                              recommended={Boolean(option.recommended)}
                              onSelect={() => selectOption(activeQuestion, option.label)}
                            >
                              <SelectionIndicator
                                selected={isSelected}
                                multiple={activeQuestion.allowMultiple}
                              />
                              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="flex flex-wrap items-center gap-1.5">
                                  <span className="text-[calc(12px*var(--zone-font-scale,1))] font-medium leading-[1.5] text-foreground/85">
                                    {option.label}
                                  </span>
                                  {option.recommended ? (
                                    <RecommendedTag label={t("chat.clarify.recommended")} />
                                  ) : null}
                                </span>
                                {option.description ? (
                                  <span className="text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5] text-muted-foreground/80">
                                    {option.description}
                                  </span>
                                ) : null}
                              </span>
                            </OptionChoiceButton>
                          );
                        })}

                        {/* UI 合成的「其他（自行输入）」行：固定在选项底部，不属于模型
                            options；选中即展开输入框。开放问题（无选项）直接渲染
                            输入框，不再套一层「其他」行。选项行是 button 而 input
                            不能嵌套其中，故此行用 div role。 */}
                        {hasOptions ? (
                          <CustomChoiceRow
                            multiple={Boolean(activeQuestion.allowMultiple)}
                            selected={draft.custom}
                            interactive={interactive}
                            onSelect={() => selectCustom(activeQuestion)}
                          >
                            <SelectionIndicator
                              selected={draft.custom}
                              multiple={activeQuestion.allowMultiple}
                            />
                            <span className="flex min-w-0 flex-1 flex-col gap-1">
                              <span className="text-[calc(12px*var(--zone-font-scale,1))] font-medium leading-[1.5] text-foreground/85">
                                {t("chat.clarify.customOption")}
                              </span>
                              {customVisible ? (
                                <input
                                  autoFocus
                                  value={draft.customText}
                                  disabled={!interactive}
                                  placeholder={t("chat.clarify.customPlaceholder")}
                                  onClick={(event) => event.stopPropagation()}
                                  onKeyDown={(event) => {
                                    event.stopPropagation();
                                    if (event.key === "Enter" && allAnswered) {
                                      event.preventDefault();
                                      submit();
                                    }
                                  }}
                                  onChange={(event) =>
                                    setCustomText(activeQuestion, event.currentTarget.value)
                                  }
                                  className="ask-custom-input-enter h-7 w-full rounded-lg border border-black/[0.08] bg-white/65 px-2 text-[calc(12px*var(--zone-font-scale,1))] text-foreground outline-none transition-[border-color,background-color] placeholder:text-muted-foreground/45 focus:border-primary/45 focus:bg-white/80 dark:border-white/[0.1] dark:bg-white/[0.05] dark:focus:border-primary/40 dark:focus:bg-white/[0.08]"
                                />
                              ) : null}
                            </span>
                          </CustomChoiceRow>
                        ) : (
                          <input
                            value={draft.customText}
                            disabled={!interactive}
                            placeholder={t("chat.clarify.customPlaceholder")}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" && allAnswered) {
                                event.preventDefault();
                                submit();
                              }
                            }}
                            onChange={(event) =>
                              setCustomText(activeQuestion, event.currentTarget.value)
                            }
                            className="h-8 w-full rounded-lg border border-black/[0.08] bg-white/65 px-2.5 text-[calc(12px*var(--zone-font-scale,1))] text-foreground outline-none transition-[border-color,background-color] placeholder:text-muted-foreground/45 focus:border-primary/45 focus:bg-white/80 dark:border-white/[0.1] dark:bg-white/[0.05] dark:focus:border-primary/40 dark:focus:bg-white/[0.08]"
                          />
                        )}
                      </ChoiceGroup>
                    </div>
                  </div>
                );
              })()
            : null}

          {busy && state.streamingText ? (
            <div className="max-w-[92%] self-start whitespace-pre-wrap rounded-xl bg-muted/60 px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] leading-relaxed text-foreground/90">
              {state.streamingText}
            </div>
          ) : null}
          {state.status === "asking" && !state.streamingText ? (
            <div className="flex items-center gap-1.5 self-start rounded-xl bg-muted/60 px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("chat.clarify.thinking")}
            </div>
          ) : null}
          {state.status === "error" && state.error ? (
            <div className="flex items-center gap-2 self-start rounded-xl bg-destructive/10 px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] text-destructive">
              <span className="min-w-0 flex-1">
                {t("chat.clarify.errorPrefix")}: {state.error}
              </span>
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors hover:bg-destructive/15"
              >
                <RefreshCw className="h-3 w-3" />
                {t("chat.clarify.retry")}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {interactive ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-black/[0.05] px-2.5 py-1.5 dark:border-white/[0.08]">
          <span className="min-w-0 truncate text-[calc(11px*var(--zone-font-scale,1))] tabular-nums text-muted-foreground/70">
            {progressText}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={generateNow}
              title={t("chat.clarify.generate")}
              className="inline-flex h-7 items-center gap-1 rounded-full border border-black/[0.06] px-2.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground dark:border-white/[0.12]"
            >
              <WandSparkles className="h-3 w-3" />
              <span className="whitespace-nowrap">{t("chat.clarify.generate")}</span>
            </button>
            <button
              type="button"
              disabled={!allAnswered}
              onClick={submit}
              className="inline-flex h-7 items-center rounded-full bg-primary px-3 text-[calc(11px*var(--zone-font-scale,1))] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
            >
              {t("chat.clarify.submit")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
