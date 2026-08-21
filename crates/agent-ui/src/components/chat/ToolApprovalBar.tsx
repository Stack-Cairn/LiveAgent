// 集中式工具审批面板:策略为 ask 的工具在执行前挂起等待用户批准。待审批时直接替换
// 输入卡片；一次只呈现最早的一项，其余数量与批量动作收进极简的计数/下拉入口。
//
// 纯展示 + 决定回调;数据(pending 列表)与提交动作由各端注入:GUI 直连桌面审批服务,
// WebUI 走网关 tool_approval，端差异一律留在各端宿主。

import { ChevronDown, Loader2, Terminal } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";

import { useLocale } from "@liveagent/ui/i18n/index";
import { useEffect, useRef, useState } from "react";
import { ASK_USER_QUESTION_TIMEOUT_MS } from "../../lib/chat/askUserQuestion";

/** approve:本次放行;deny:本次拒绝;approve_session:本会话内该工具后续免审。 */
export type ToolApprovalDecision = "approve" | "deny" | "approve_session";

export type ToolApprovalSubmitOutcome = { ok: boolean; message?: string };

export type PendingApprovalItem = {
  toolCallId: string;
  toolName: string;
  /** 命令/参数摘要(Bash 显示命令等);空则只显示工具名。 */
  summary?: string;
  /** 权威应答截止时间戳(毫秒);缺省以挂载时刻近似。 */
  deadlineAt?: number;
};

function formatCountdown(remainingMs: number) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// 倒计时取列表中最早的 deadline(最紧迫者驱动整栏)。缺失时以挂载时刻近似。
// 超时后桌面按“拒绝”落定,pending 消失,本栏随之隐藏。
function useEarliestCountdown(active: boolean, deadlines: number[]) {
  const [fallbackDeadline] = useState(() => Date.now() + ASK_USER_QUESTION_TIMEOUT_MS);
  const earliest = deadlines.length > 0 ? Math.min(...deadlines) : fallbackDeadline;
  const [remainingMs, setRemainingMs] = useState(() => earliest - Date.now());
  useEffect(() => {
    if (!active) return;
    const tick = () => setRemainingMs(earliest - Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [active, earliest]);
  return remainingMs;
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
    panelRef.current?.focus({ preventScroll: true });
  }, [currentToolCallId]);

  if (pending.length === 0) return null;

  const current = pending[0];
  const displayToolName =
    current.toolName.toLowerCase() === "bash" ? t("chat.toolApproval.terminal") : current.toolName;
  const errorText = submissionError?.toolCallId === current.toolCallId ? submissionError.text : "";

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
          void runGuarded(`deny:${current.toolCallId}`, () => onDecide(current.toolCallId, "deny"));
          return;
        }
        const target = event.target;
        if (
          event.key !== "Enter" ||
          (target instanceof Element &&
            target.closest("button,input,textarea,select,[contenteditable=true],[role=menuitem]"))
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void runGuarded(`approve:${current.toolCallId}`, () =>
          onDecide(current.toolCallId, "approve"),
        );
      }}
      className="tool-expand @container relative flex h-32 w-full flex-col rounded-3xl border border-black/[0.055] bg-white/72 shadow-[0_12px_40px_-14px_rgba(15,23,42,0.22),0_2px_6px_-2px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.74)] outline-none backdrop-blur-2xl backdrop-saturate-[165%] dark:border-white/[0.10] dark:bg-white/[0.06] dark:shadow-[0_12px_40px_-14px_rgba(0,0,0,0.72),0_2px_6px_-2px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.08)]"
    >
      <div className="min-h-0 flex-1 overflow-hidden px-4 pt-3">
        <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <Terminal className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[calc(11.5px*var(--zone-font-scale,1))] leading-none">
            {displayToolName}
          </span>
          <span
            role="timer"
            title={`${formatCountdown(remainingMs)} ${t("chat.toolApproval.timeoutHint")}`}
            className="shrink-0 text-[calc(10.5px*var(--zone-font-scale,1))] tabular-nums text-muted-foreground/65"
          >
            {pending.length > 1 ? `1 / ${pending.length} · ` : null}
            {formatCountdown(remainingMs)}
          </span>
        </div>

        <p className="mt-2 truncate text-[calc(13px*var(--zone-font-scale,1))] font-medium leading-[1.5] text-foreground/92">
          {t("chat.toolApproval.body").replace("{tool}", displayToolName)}
        </p>

        {current.summary ? (
          <pre
            title={current.summary}
            className="mt-1.5 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.45] text-muted-foreground"
          >
            {current.summary}
          </pre>
        ) : null}
      </div>

      <div className="flex h-9 shrink-0 items-center justify-end gap-1.5 px-3 pb-2">
        {errorText ? (
          <span
            role="alert"
            className="mr-auto min-w-0 flex-1 truncate text-[calc(10.5px*var(--zone-font-scale,1))] text-red-600 dark:text-red-400"
          >
            {errorText}
          </span>
        ) : null}

        <Button
          variant="outline"
          size="sm"
          disabled={submitting}
          aria-busy={submittingAction === `deny:${current.toolCallId}`}
          aria-keyshortcuts="Escape"
          onClick={() =>
            void runGuarded(`deny:${current.toolCallId}`, () =>
              onDecide(current.toolCallId, "deny"),
            )
          }
          className="h-7 shrink-0 px-3 text-[calc(11px*var(--zone-font-scale,1))]"
        >
          {submittingAction === `deny:${current.toolCallId}` ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : null}
          {t("chat.toolApproval.deny")}
          <span
            aria-hidden="true"
            className="rounded bg-muted px-1 py-0.5 font-sans text-[9px] font-normal leading-none text-muted-foreground"
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
              onClick={() =>
                void runGuarded(`approve:${current.toolCallId}`, () =>
                  onDecide(current.toolCallId, "approve"),
                )
              }
              className="h-7 rounded-r-none px-3 text-[calc(11px*var(--zone-font-scale,1))] shadow-none"
            >
              {submittingAction === `approve:${current.toolCallId}` ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t("chat.toolApproval.approve")}
              <span
                aria-hidden="true"
                className="rounded bg-primary-foreground/10 px-1 py-0.5 font-sans text-[10px] font-normal leading-none text-primary-foreground/75"
              >
                ↵
              </span>
            </Button>
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
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
          </div>
          <DropdownMenuContent side="top" align="end" className="min-w-32">
            <DropdownMenuItem
              disabled={submitting}
              onSelect={() =>
                void runGuarded(`session:${current.toolCallId}`, () =>
                  onDecide(current.toolCallId, "approve_session"),
                )
              }
              className="text-xs"
            >
              {t("chat.toolApproval.approveSession").replace("{tool}", displayToolName)}
            </DropdownMenuItem>
            {pending.length > 1 ? (
              <>
                <DropdownMenuItem
                  disabled={submitting}
                  onSelect={() => void runGuarded("approve-all", () => onDecideAll("approve"))}
                  className="text-xs"
                >
                  {t("chat.toolApproval.approveAll")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={submitting}
                  onSelect={() => void runGuarded("deny-all", () => onDecideAll("deny"))}
                  className="text-xs text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
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
