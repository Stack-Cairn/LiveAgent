// 集中式工具审批面板:策略为 ask 的工具在执行前挂起等待用户批准。待审批时直接替换
// 输入卡片；一次只呈现最早的一项，其余数量与批量动作收进极简的计数/下拉入口。
//
// 纯展示 + 决定回调;数据(pending 列表)与提交动作由各端注入:GUI 直连桌面审批服务,
// WebUI 走网关 tool_approval，端差异一律留在各端宿主。

import { EditDiffView } from "@liveagent/ui/components/chat/EditDiffView";
import { ChevronDown, Loader2, Terminal } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";

import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useEffect, useRef, useState } from "react";
import type {
  ToolApprovalAnswerOptions,
  ToolApprovalPreview,
  ToolApprovalRememberScope,
} from "../../lib/chat/toolApprovalArgs";

/** approve:本次放行;deny:本次拒绝;approve_session:请后端在本会话内记住这条授权范围。 */
export type ToolApprovalDecision = "approve" | "deny" | "approve_session";

export type ToolApprovalSubmitOutcome = { ok: boolean; message?: string };

export type PendingApprovalItem = {
  toolCallId: string;
  toolName: string;
  /** 命令/参数摘要(Bash 显示命令等);空则只显示工具名。 */
  summary?: string;
  /** 权威应答截止时间戳(毫秒);缺省或 null 表示一直等到用户决定,不显示倒计时(K-brain 审批)。 */
  deadlineAt?: number | null;
  /** 后端会记住本会话授权时为 true 才提供 approve_session;缺省不提供(远端旧数据同样不显示)。 */
  allowSession?: boolean;
  /** approve_session 生效的授权范围(如 call:click),显示在该选项里。 */
  sessionScope?: string;
  /** 本次允许即对本会话同类操作生效(如 Computer Use);正文与按钮据此说明。 */
  sessionWide?: boolean;
  /** 允许并记住会存的规则;非空时按 2 记到 defaultScope(和 Claude Code 一样不在卡片上选作用域)。 */
  rememberRules?: string[];
  defaultScope?: ToolApprovalRememberScope;
  /** Edit/Write 的改动预览。 */
  preview?: ToolApprovalPreview;
  /** 审批重新弹出的原因,如后端存不下记住的规则。 */
  notice?: string;
};

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    target.closest("button,input,textarea,select,[contenteditable=true],[role=menuitem]") !== null
  );
}

function formatCountdown(remainingMs: number) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// 倒计时取列表中最早的 deadline(最紧迫者驱动整栏)。没有任何 deadline 时(K-brain
// 审批一直等到用户决定)返回 null,不显示倒计时。超时后桌面按“拒绝”落定,pending
// 消失,本栏随之隐藏。
function useEarliestCountdown(active: boolean, deadlines: number[]) {
  const earliest = deadlines.length > 0 ? Math.min(...deadlines) : null;
  const [remainingMs, setRemainingMs] = useState(() =>
    earliest === null ? null : earliest - Date.now(),
  );
  useEffect(() => {
    if (!active || earliest === null) {
      setRemainingMs(null);
      return;
    }
    const tick = () => setRemainingMs(earliest - Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [active, earliest]);
  // The deadline set can change between renders; never show a stale countdown for it.
  if (earliest === null) return null;
  return remainingMs ?? earliest - Date.now();
}

export function ToolApprovalBar({
  pending,
  onDecide,
  onDecideAll,
}: {
  pending: PendingApprovalItem[];
  onDecide: (
    toolCallId: string,
    decision: ToolApprovalDecision,
    options?: ToolApprovalAnswerOptions,
  ) => Promise<ToolApprovalSubmitOutcome>;
  onDecideAll: (decision: "approve" | "deny") => Promise<void>;
}) {
  const { t } = useLocale();
  const [submittingAction, setSubmittingAction] = useState<string | null>(null);
  const [submissionError, setSubmissionError] = useState<{
    toolCallId: string;
    text: string;
  } | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const deadlines = pending
    .map((item) => item.deadlineAt)
    .filter((value): value is number => typeof value === "number");
  const remainingMs = useEarliestCountdown(pending.length > 0, deadlines);
  const submitting = submittingAction !== null;
  const currentToolCallId = pending[0]?.toolCallId ?? "";

  useEffect(() => {
    if (!currentToolCallId) return;
    // Approvals arrive mid-turn, whenever the model happens to call a tool — so
    // this can land while the user is mid-word in a rename field or the
    // new-group draft. Grabbing focus there drops their keystrokes and, for the
    // sidebar's blur-to-commit inputs, silently discards the row. The keyboard
    // shortcuts this focus enables are worth less than not stealing an active
    // caret; the user can Tab or click into the bar.
    //
    // The composer is the exception: this bar replaces it (ChatComposerBar
    // hides the card), so there is no caret left to protect there. Focus still
    // sits on the hidden textarea at commit time — the browser's focus fixup
    // runs later — so an editable activeElement only counts when it is still
    // rendered; otherwise Enter/Escape would silently stop working right after
    // sending a message, which is the common case.
    const active = document.activeElement as HTMLElement | null;
    // Someone typing in the composer (say, what to do after a deny) keeps their caret: an
    // approval that lands mid-sentence must not turn the next "2" or Enter into an answer.
    // The shortcuts work once they click or Tab into the bar.
    if (active?.closest("[data-composer-draft]")) return;
    const activeIsEditable =
      active !== null &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
    if (activeIsEditable && active.getClientRects().length > 0) {
      return;
    }
    panelRef.current?.focus({ preventScroll: true });
  }, [currentToolCallId]);

  if (pending.length === 0) return null;

  const current = pending[0];
  const displayToolName =
    current.toolName.toLowerCase() === "bash" ? t("chat.toolApproval.terminal") : current.toolName;
  const errorText = submissionError?.toolCallId === current.toolCallId ? submissionError.text : "";
  const offerSession = current.allowSession === true;
  // With rules to remember the card shows its own remember option; the menu keeps the
  // old session item only for backends without rules (Computer Use grants).
  const rememberRules = offerSession ? (current.rememberRules ?? []) : [];
  const offerRemember = rememberRules.length > 0;
  const offerLegacySession = offerSession && !offerRemember;
  const hasMoreActions = offerLegacySession || pending.length > 1;
  const rememberScope = current.defaultScope ?? "session";
  const sessionTarget = current.sessionScope
    ? `${displayToolName} · ${current.sessionScope}`
    : displayToolName;

  const runGuarded = async (
    action: string,
    task: (() => Promise<ToolApprovalSubmitOutcome>) | (() => Promise<void>),
  ) => {
    if (submitting) return;
    setMoreOpen(false);
    setSubmittingAction(action);
    setSubmissionError(null);
    try {
      const outcome = await task();
      if (outcome && !outcome.ok) {
        setSubmissionError({
          toolCallId: current.toolCallId,
          text: outcome.message || t("chat.toolApproval.failed"),
        });
      }
    } catch (error) {
      setSubmissionError({
        toolCallId: current.toolCallId,
        text: error instanceof Error ? error.message : t("chat.toolApproval.failed"),
      });
    } finally {
      setSubmittingAction(null);
    }
  };

  const approveOnce = () =>
    void runGuarded(`approve:${current.toolCallId}`, () => onDecide(current.toolCallId, "approve"));
  const remember = () => {
    if (offerRemember) {
      void runGuarded(`session:${current.toolCallId}`, () =>
        onDecide(current.toolCallId, "approve_session", { scope: rememberScope }),
      );
    } else if (offerLegacySession) {
      void runGuarded(`session:${current.toolCallId}`, () =>
        onDecide(current.toolCallId, "approve_session"),
      );
    }
  };
  // One deny, like Claude Code's "No, and tell Claude what to do differently": the user
  // says what to do next in the composer, which gets the caret back once the bar is gone.
  const deny = () =>
    void runGuarded(`deny:${current.toolCallId}`, () => onDecide(current.toolCallId, "deny"));

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      aria-label={t("chat.toolApproval.title")}
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          event.repeat ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          submitting ||
          moreOpen
        ) {
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          deny();
          return;
        }
        // Keys on a button or menu item are that control's own.
        if (isEditableTarget(event.target)) return;
        const handlers: Record<string, () => void> = {
          Enter: approveOnce,
          "1": approveOnce,
          "2": remember,
          "3": deny,
        };
        const handle = handlers[event.key];
        if (!handle || (event.key === "2" && !offerRemember && !offerLegacySession)) return;
        event.preventDefault();
        event.stopPropagation();
        handle();
      }}
      className={cn(
        "@container relative flex min-h-32 w-full flex-col",
        "rounded-3xl border border-black/[0.055] bg-white/72 shadow-ui-toolapprovalbar-18 outline-none backdrop-blur-2xl backdrop-saturate-[165%]",
        "dark:border-white/[0.10] dark:bg-white/[0.06] dark:shadow-ui-toolapprovalbar-19",
      )}
    >
      <div className="min-h-0 flex-auto overflow-hidden px-4 pt-3">
        <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <Terminal className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-xs leading-none">{displayToolName}</span>
          {remainingMs === null ? (
            pending.length > 1 ? (
              <span className="shrink-0 text-tiny tabular-nums text-muted-foreground/65">
                {`1 / ${pending.length}`}
              </span>
            ) : null
          ) : (
            <span
              role="timer"
              title={`${formatCountdown(remainingMs)} ${t("chat.toolApproval.timeoutHint")}`}
              className="shrink-0 text-tiny tabular-nums text-muted-foreground/65"
            >
              {pending.length > 1 ? `1 / ${pending.length} · ` : null}
              {formatCountdown(remainingMs)}
            </span>
          )}
        </div>

        {/* Wraps instead of truncating: on phones the session-wide explanation must stay readable. */}
        <p className="mt-2 break-words text-sm font-medium leading-1p5 text-foreground/92">
          {current.sessionWide
            ? t("chat.toolApproval.sessionWideBody")
            : t("chat.toolApproval.body").replace("{tool}", displayToolName)}
        </p>

        {/* The whole command, wrapped and scrollable: approving what one cut line shows
            is approving blind. */}
        {current.summary ? (
          <pre
            data-approval-command=""
            className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-1p45 text-muted-foreground"
          >
            {current.summary}
          </pre>
        ) : null}

        {current.preview ? (
          <>
            {/* Above the scroll box, so a long preview cannot push it out of view. */}
            {current.preview.truncated ? (
              <p className="mt-2 text-tiny text-muted-foreground">
                {t("chat.toolApproval.previewTruncated")}
              </p>
            ) : null}
            <div data-approval-preview="" className="mt-2 max-h-56 overflow-auto">
              {current.preview.split ? (
                // Two separately cut sides: a diff of them would hide or invent changes.
                <div className="space-y-2">
                  {current.preview.path ? (
                    <p className="break-all font-mono text-xs text-foreground">
                      {current.preview.path}
                    </p>
                  ) : null}
                  {(
                    [
                      ["before", current.preview.before],
                      ["after", current.preview.after],
                    ] as const
                  ).map(([side, text]) => (
                    <div key={side} data-approval-preview-side={side}>
                      <p className="text-tiny text-muted-foreground">
                        {t(`chat.toolApproval.preview.${side}`)}
                      </p>
                      <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-xs leading-1p45 text-foreground">
                        {text}
                      </pre>
                    </div>
                  ))}
                </div>
              ) : (
                <EditDiffView
                  beforeText={current.preview.before}
                  afterText={current.preview.after}
                  filePath={current.preview.path}
                />
              )}
            </div>
          </>
        ) : null}

        {current.notice ? (
          <p
            data-approval-notice=""
            role="status"
            className="mt-2 break-words text-tiny text-amber-700 dark:text-amber-400"
          >
            {t("chat.toolApproval.rememberRefused").replace("{reason}", current.notice)}
          </p>
        ) : null}

        {offerRemember ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 break-all font-mono">
              {t("chat.toolApproval.rememberRules").replace("{rules}", rememberRules.join(", "))}
              {" · "}
              <span data-remember-scope="" className="font-sans">
                {t(`chat.toolApproval.scope.${rememberScope}`)}
              </span>
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={submitting}
              aria-busy={submittingAction === `session:${current.toolCallId}`}
              aria-keyshortcuts="2"
              onClick={remember}
              className="h-7 shrink-0 px-3 text-xs"
            >
              {submittingAction === `session:${current.toolCallId}` ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : null}
              {t("chat.toolApproval.remember")}
              <ShortcutChip>2</ShortcutChip>
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex min-h-9 shrink-0 flex-wrap items-center justify-end gap-1.5 px-3 pb-2">
        {errorText ? (
          <span role="alert" className="mr-auto min-w-0 flex-1 truncate text-tiny text-destructive">
            {errorText}
          </span>
        ) : null}

        <Button
          variant="outline"
          size="sm"
          disabled={submitting}
          aria-busy={submittingAction === `deny:${current.toolCallId}`}
          aria-keyshortcuts="Escape 3"
          onClick={deny}
          className="h-7 shrink-0 px-3 text-xs"
        >
          {submittingAction === `deny:${current.toolCallId}` ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : null}
          {t("chat.toolApproval.deny")}
          <span
            aria-hidden="true"
            className={cn(
              "rounded bg-muted px-1 py-0.5",
              "font-sans text-tiny font-normal leading-none text-muted-foreground",
            )}
          >
            Esc
          </span>
        </Button>

        <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
          <div className="flex shrink-0">
            <Button
              size="sm"
              disabled={submitting}
              aria-busy={submittingAction === `approve:${current.toolCallId}`}
              aria-keyshortcuts="Enter"
              title={t("chat.toolApproval.approveShortcutHint")}
              onClick={approveOnce}
              className={cn("h-7 px-3 text-xs shadow-none", hasMoreActions && "rounded-r-none")}
            >
              {submittingAction === `approve:${current.toolCallId}` ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : null}
              {t(
                current.sessionWide
                  ? "chat.toolApproval.approveForSession"
                  : "chat.toolApproval.approve",
              )}
              <span
                aria-hidden="true"
                className={cn(
                  "rounded bg-primary-foreground/10 px-1 py-0.5",
                  "font-sans text-tiny font-normal leading-none text-primary-foreground/75",
                )}
              >
                ↵
              </span>
            </Button>
            {hasMoreActions ? (
              <DropdownMenuTrigger
                render={
                  <Button
                    size="sm"
                    disabled={submitting}
                    className="h-7 w-6 rounded-l-none border-l border-primary-foreground/20 px-0 shadow-none"
                  />
                }
                aria-label={t("chat.toolApproval.moreActions")}
              >
                <ChevronDown className="size-3" />
              </DropdownMenuTrigger>
            ) : null}
          </div>
          <DropdownMenuContent variant="soft" side="top" align="end" className="min-w-32">
            {offerLegacySession ? (
              <DropdownMenuItem disabled={submitting} onSelect={remember}>
                {t("chat.toolApproval.approveSession").replace("{tool}", sessionTarget)}
              </DropdownMenuItem>
            ) : null}
            {pending.length > 1 ? (
              <>
                <DropdownMenuItem
                  disabled={submitting}
                  onSelect={() => void runGuarded("approve-all", () => onDecideAll("approve"))}
                >
                  {t("chat.toolApproval.approveAll")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={submitting}
                  onSelect={() => void runGuarded("deny-all", () => onDecideAll("deny"))}
                  className="text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
                >
                  {t("chat.toolApproval.denyAll")}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </section>
  );
}

function ShortcutChip({ children }: { children: string }) {
  return (
    <span
      aria-hidden="true"
      className="rounded bg-muted px-1 py-0.5 font-sans text-tiny font-normal leading-none text-muted-foreground"
    >
      {children}
    </span>
  );
}
