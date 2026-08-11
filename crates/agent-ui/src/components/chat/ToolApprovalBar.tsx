// 集中式工具审批栏:策略为 ask 的工具在执行前挂起等待用户批准。渲染在输入框上方,
// 汇总当前会话所有待审批项——顶部一键「全部允许/全部拒绝」,下方逐条(单条允许/拒绝)。
// 取代此前埋在每个 Tool Activity 折叠项里的分散卡片(并行多个时逐个展开点击很繁琐)。
//
// 纯展示 + 决定回调;数据(pending 列表)与提交动作由各端注入:GUI 直连桌面审批服务,
// WebUI 走网关 tool_approval，端差异一律留在各端宿主。

import { Shield } from "@liveagent/app/components/icons";

import { useLocale } from "@liveagent/ui/i18n/index";
import { useEffect, useState } from "react";
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
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState("");
  const deadlines = pending
    .map((item) => item.deadlineAt)
    .filter((value): value is number => typeof value === "number");
  const remainingMs = useEarliestCountdown(pending.length > 0, deadlines);

  if (pending.length === 0) return null;

  const runGuarded = async (task: () => Promise<ToolApprovalSubmitOutcome | void>) => {
    if (submitting) return;
    setSubmitting(true);
    setErrorText("");
    try {
      const outcome = await task();
      if (outcome && !outcome.ok) {
        setErrorText(outcome.message || t("chat.toolApproval.failed"));
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : t("chat.toolApproval.failed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="tool-expand mx-auto mb-[-1px] w-[calc(100%-1.5rem)] max-w-[720px] overflow-hidden rounded-t-xl border border-b-0 border-amber-500/35 bg-amber-500/[0.06] backdrop-blur-2xl dark:border-amber-400/25 dark:bg-amber-400/[0.05]">
      <div className="flex flex-col gap-2 px-3 py-2.5">
        {/* 顶部:标题 + 全部允许/全部拒绝 + 倒计时 */}
        <div className="flex items-center gap-2">
          <Shield className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="min-w-0 flex-1 truncate text-[calc(12.5px*var(--zone-font-scale,1))] font-medium leading-[1.5] text-foreground/90">
            {t("chat.toolApproval.barTitle").replace("{count}", String(pending.length))}
          </span>
          <span className="shrink-0 text-[calc(11px*var(--zone-font-scale,1))] tabular-nums leading-none text-muted-foreground/55">
            {formatCountdown(remainingMs)} {t("chat.toolApproval.timeoutHint")}
          </span>
        </div>

        {/* 「全部允许/全部拒绝」仅在多于一个待审批时显示;单个时与逐条按钮重复,故隐藏。 */}
        {pending.length > 1 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={submitting}
              onClick={() => void runGuarded(() => onDecideAll("approve"))}
              className="rounded-lg bg-primary px-3 py-1.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium leading-none text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
            >
              {t("chat.toolApproval.approveAll")}
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void runGuarded(() => onDecideAll("deny"))}
              className="rounded-lg border border-border/60 px-3 py-1.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium leading-none text-red-600 transition-colors hover:bg-red-500/[0.06] disabled:pointer-events-none disabled:opacity-40 dark:border-white/[0.12] dark:text-red-400"
            >
              {t("chat.toolApproval.denyAll")}
            </button>
          </div>
        ) : null}

        {/* 逐条:顶行工具名 + 允许/拒绝按钮(固定,不被长命令挤走);下方命令块完整展示 */}
        <ul className="flex flex-col gap-1">
          {pending.map((item) => (
            <li
              key={item.toolCallId}
              className="flex flex-col gap-1.5 rounded-md border border-black/[0.05] bg-background/40 px-2 py-1.5 dark:border-white/[0.06]"
            >
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[calc(11px*var(--zone-font-scale,1))] font-medium leading-none text-foreground/80">
                  {item.toolName}
                </code>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void runGuarded(() => onDecide(item.toolCallId, "approve"))}
                  className="shrink-0 rounded-md px-2 py-1 text-[calc(10.5px*var(--zone-font-scale,1))] font-medium leading-none text-emerald-600 transition-colors hover:bg-emerald-500/[0.08] disabled:pointer-events-none disabled:opacity-40 dark:text-emerald-400"
                >
                  {t("chat.toolApproval.approve")}
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() =>
                    void runGuarded(() => onDecide(item.toolCallId, "approve_session"))
                  }
                  className="shrink-0 rounded-md px-2 py-1 text-[calc(10.5px*var(--zone-font-scale,1))] font-medium leading-none text-foreground/70 transition-colors hover:bg-foreground/[0.05] disabled:pointer-events-none disabled:opacity-40"
                >
                  {t("chat.toolApproval.approveSession")}
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void runGuarded(() => onDecide(item.toolCallId, "deny"))}
                  className="shrink-0 rounded-md px-2 py-1 text-[calc(10.5px*var(--zone-font-scale,1))] font-medium leading-none text-red-600 transition-colors hover:bg-red-500/[0.06] disabled:pointer-events-none disabled:opacity-40 dark:text-red-400"
                >
                  {t("chat.toolApproval.deny")}
                </button>
              </div>
              {item.summary ? (
                <pre className="chat-queue-scroll max-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded bg-foreground/[0.04] px-2 py-1.5 font-mono text-[calc(11px*var(--zone-font-scale,1))] leading-[1.45] text-foreground/70 dark:bg-white/[0.04]">
                  {item.summary}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>

        {errorText ? (
          <div className="text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5] text-red-500">
            {errorText}
          </div>
        ) : null}
      </div>
    </div>
  );
}
