import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useEffect, useState } from "react";
import { canManualCompact, contextUsageRatio } from "../../lib/chat/contextUsage";
import {
  type ConversationStats,
  formatStatCount,
  formatStatDuration,
  formatStatLatency,
  formatStatPercent,
  formatStatThroughput,
  formatStatTokens,
  hasConversationStats,
  resolveStatDurations,
} from "../../lib/trajectory/stats";
import { ConfirmActionPopover } from "../ui/confirm-action-popover";
import { LabelTooltip } from "../ui/label-tooltip";

/** 心跳与 hook 的重建节流同频（docs/design/composer-context-stats-bar.md §4.2）。 */
const HEARTBEAT_MS = 1_000;

type StatGroup = {
  key: string;
  /** 收缩档位：undefined 恒显，否则按容器宽度分档显隐。 */
  minWidth?: "28rem" | "40rem" | "52rem";
  items: readonly string[];
};

/** 运行中每秒重渲染一次，把 *RunningSinceAt 折算进显示值；空闲时零定时器。 */
function useRunningHeartbeat(running: boolean): number {
  const [, setBeat] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setBeat((beat) => beat + 1), HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [running]);
  return Date.now();
}

/**
 * 输入卡片正下方的全会话累计统计单行（上下文占用 ｜ 会话规模 ｜ 时间开销 ｜ token 开销 ｜ 响应性能）。
 *
 * 纯展示：数据经 useConversationStats 聚合后由宿主注入。宽度分档收缩依赖自身的
 * `@container`——它与玻璃卡片同宽，档位阈值因此与卡片一致。上下文占用组与
 * 「规模」组同属恒显档：移动端容器宽度撑不到第一个断点（28rem），此前只剩
 * 轮·步，用量环又在低占用时隐身（hideBelowWarn），导致窄屏完全看不到上下文
 * 信息——故把占用百分比也放进这里恒显，与用量环的瞬时读数同源、不互斥
 * （原 §4.5 语义分工里「状态栏不含上下文占用」的决定按此反馈调整）。恒定
 * 高度占位（见下方空态分支），不随首条统计到达/消失而改变 composer 总高度。
 */
export function ConversationStatsBar(props: {
  stats: ConversationStats | null;
  /**
   * 提供且当前上下文占用 ≥50%（canManualCompact）时整条可点击，弹出确认后
   * 触发手动压缩，门槛与 ContextUsageRing 同源；不满足条件时纯展示。
   */
  onManualCompactConfirm?: (() => void) | (() => Promise<unknown>);
  /** 压缩正在进行等场景下临时关闭点击入口，即使占用达标也不可点。 */
  manualCompactBlocked?: boolean;
  /** 当前会话上下文占用 token（与用量环同源）；与 contextWindow 一并提供时才显示。 */
  contextUsageTokens?: number;
  contextWindow?: number;
}) {
  const { stats, onManualCompactConfirm, manualCompactBlocked, contextUsageTokens, contextWindow } =
    props;
  const { t, locale } = useLocale();
  const running =
    stats !== null && (stats.llmRunningSinceAt !== null || stats.toolRunningSinceAt !== null);
  const now = useRunningHeartbeat(running);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const ratio = contextUsageRatio(contextUsageTokens, contextWindow);
  const compactAvailable =
    canManualCompact(ratio) && !manualCompactBlocked && Boolean(onManualCompactConfirm);
  // 确认弹层只在可压缩分支渲染；可压缩状态可能在弹层打开期间翻回 false
  //（他端开始压缩、占用回落阈值下），渲染期归位避免残留 true 导致状态恢复
  // 后弹层无操作自动弹开（与 ContextUsageRing 同一处理，见该文件注释）。
  if (!compactAvailable && confirmOpen) {
    setConfirmOpen(false);
  }

  // 占位容器：暂无可展示数据时也保留同样高度，不返回 null。首条消息发送前
  // 统计恒为空，若此时不占位，assistant 回复落地统计浮现的那一刻 composer/
  // transcript 会整体位移一次，观感是布局"跳了一下"；常驻占位换来的是零跳动。
  if (!hasConversationStats(stats) || stats === null) {
    return (
      <div
        aria-hidden="true"
        className="@container flex h-5 w-full items-center justify-center overflow-hidden"
      />
    );
  }

  const durations = resolveStatDurations(stats, now);
  const fill = (key: string, token: string, value: string) => t(key).replace(token, value);

  // token 类指标只算有 usage 的 step；全都没有时对应分组隐藏（§7）。
  const tokenItems = [
    ...(stats.inputTokens > 0
      ? [fill("chat.stats.inputTokens", "{n}", formatStatTokens(stats.inputTokens, locale))]
      : []),
    ...(stats.outputTokens > 0
      ? [fill("chat.stats.outputTokens", "{n}", formatStatTokens(stats.outputTokens, locale))]
      : []),
  ];
  const perfItems = [
    ...(stats.ttftAvgMs !== null
      ? [fill("chat.stats.ttftAvg", "{t}", formatStatLatency(stats.ttftAvgMs))]
      : []),
    ...(stats.decodeTokPerSec !== null
      ? [fill("chat.stats.throughput", "{n}", formatStatThroughput(stats.decodeTokPerSec))]
      : []),
    ...(stats.cacheHitRatio !== null
      ? [fill("chat.stats.cacheHit", "{p}", formatStatPercent(stats.cacheHitRatio))]
      : []),
  ];
  // 与用量环用同一个 contextWindow 判空口径：没有模型上下文窗口信息（老会话/
  // text 模式）时该分组整个不存在，而不是显示一个假的 0%。
  const contextUsageItems =
    typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? [fill("chat.stats.contextUsage", "{p}", formatStatPercent(ratio))]
      : [];
  // 注解写在字面量上：写在 .filter() 结果上会让 minWidth 先宽化成 string。
  const allGroups: StatGroup[] = [
    {
      key: "scale",
      items: [
        fill("chat.stats.turns", "{n}", String(stats.turns)),
        fill("chat.stats.steps", "{n}", String(stats.steps)),
      ],
    },
    // 恒显档，与 scale 同级：移动端容器宽度到不了 28rem 断点，这是窄屏下
    // 除轮·步外唯一还能露出的分组。
    { key: "context", items: contextUsageItems },
    {
      key: "time",
      minWidth: "28rem",
      items: [
        fill("chat.stats.llmTime", "{t}", formatStatDuration(durations.llmMs)),
        fill("chat.stats.toolTime", "{t}", formatStatDuration(durations.toolMs)),
      ],
    },
    { key: "tokens", minWidth: "40rem", items: tokenItems },
    { key: "perf", minWidth: "52rem", items: perfItems },
  ];
  const groups = allGroups.filter((group) => group.items.length > 0);

  const prefix = stats.approximate ? `${t("chat.stats.approximate")} ` : "";
  const fullText = prefix + groups.map((group) => group.items.join(" · ")).join(" ｜ ");

  // tooltip 给出被容器查询收缩掉的分组，外加只在此处露出的压缩次数与 ≈ 释义。
  const tooltipLines = [
    ...groups.map((group) => ({ key: group.key, text: group.items.join(" · ") })),
    ...(stats.compactions > 0
      ? [
          {
            key: "compactions",
            text: fill("chat.stats.compactions", "{n}", formatStatCount(stats.compactions, locale)),
          },
        ]
      : []),
  ];
  const tooltip = (
    <span className="flex flex-col gap-0.5">
      {tooltipLines.map((line) => (
        <span key={line.key}>{line.text}</span>
      ))}
      {stats.approximate ? (
        <span className="text-muted-foreground">{t("chat.stats.approximateHint")}</span>
      ) : null}
      {compactAvailable ? (
        <span className="text-muted-foreground">{t("chat.manualCompactTitle")}</span>
      ) : null}
    </span>
  );

  // 读数经外层 role="status" 的 aria-label 播报，这里对辅助技术整体隐藏，
  // 避免同一串数字被读两遍。
  const row = (
    <div
      aria-hidden="true"
      className="flex min-w-0 items-center overflow-hidden text-[calc(11px*var(--zone-font-scale,1))] leading-none whitespace-nowrap text-muted-foreground/70 tabular-nums"
    >
      {prefix === "" ? null : <span className="mr-1">{t("chat.stats.approximate")}</span>}
      {groups.map((group, index) => (
        <span
          key={group.key}
          data-stats-group={group.key}
          className={cn(
            "items-center",
            group.minWidth === undefined && "flex",
            group.minWidth === "28rem" && "hidden @min-[28rem]:flex",
            group.minWidth === "40rem" && "hidden @min-[40rem]:flex",
            group.minWidth === "52rem" && "hidden @min-[52rem]:flex",
          )}
        >
          {index > 0 ? <span className="px-1.5 text-muted-foreground/40">｜</span> : null}
          <span>{group.items.join(" · ")}</span>
        </span>
      ))}
    </div>
  );

  return (
    // role="status" 提供语义；数字变化不做 aria-live 播报（流式期间会刷屏）。
    // overflow-hidden 兜底：tooltip trigger 是 shrink-0，极窄时宁可裁剪也不撑破布局。
    <div
      role="status"
      aria-live="off"
      aria-label={fullText}
      className="@container flex h-5 w-full items-center justify-center overflow-hidden"
    >
      <LabelTooltip label={tooltip}>
        {compactAvailable ? (
          <ConfirmActionPopover
            title={t("chat.manualCompactTitle")}
            description={t("chat.manualCompactDescription")}
            confirmLabel={t("chat.manualCompactConfirm")}
            tone="default"
            side="top"
            align="center"
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            onConfirm={() => void onManualCompactConfirm?.()}
          >
            {(open) => (
              <button
                type="button"
                onClick={open}
                aria-label={t("chat.manualCompactTitle")}
                className="flex min-w-0 cursor-pointer items-center rounded-full px-1.5 outline-hidden transition-[background-color] hover:bg-muted/50 focus-visible:bg-muted/50"
              >
                {row}
              </button>
            )}
          </ConfirmActionPopover>
        ) : (
          row
        )}
      </LabelTooltip>
    </div>
  );
}
