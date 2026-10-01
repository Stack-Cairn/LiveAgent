import { useLocale } from "@liveagent/ui/i18n/index";
import { useDocumentHidden } from "@liveagent/ui/lib/shared/documentVisibility";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { Fragment, useEffect, useState } from "react";
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

type StatGroupKey = "scale" | "context" | "time" | "tokens" | "perf";

/**
 * 单行分组的收缩档位：undefined 恒显，否则按容器宽度分档显隐。
 * 抽成常量表，让指标定义只声明自己属于哪个分组。
 */
const GROUP_MIN_WIDTH: Record<StatGroupKey, "28rem" | "40rem" | "52rem" | undefined> = {
  // 恒显档：移动端容器宽度到不了 28rem 断点，这两组是窄屏下唯一还能露出的。
  scale: undefined,
  context: undefined,
  time: "28rem",
  tokens: "40rem",
  perf: "52rem",
};

/**
 * 一条读数同时服务三个出口，故每个指标带三种写法：
 * - `short`：单行工程缩写（`TTFT 20.9s`、`↑111M`），宽度优先；
 * - `label` + `value`：tooltip 两列表的本地化全称与带单位读数，可读性优先；
 * - aria-label 用 `label value` 拼接：箭头、TTFT 这类缩写屏读读不出人话。
 */
type StatMetric = {
  key: string;
  group: StatGroupKey;
  label: string;
  value: string;
  short: string;
};

type StatGroup = {
  key: StatGroupKey;
  minWidth?: "28rem" | "40rem" | "52rem";
  metrics: readonly StatMetric[];
};

/** 运行中每秒重渲染一次，把 *RunningSinceAt 折算进显示值；空闲时零定时器。 */
function useRunningHeartbeat(running: boolean): number {
  const hidden = useDocumentHidden();
  const [, setBeat] = useState(0);
  useEffect(() => {
    // 窗口不可见时不起心跳：这些帧用户看不到，代价却是每秒重渲染一次统计条
    // （连带重建其中的 formatter、以及在长会话里重排可见行邻域）。重新可见时
    // hidden 翻转会重启 effect，读数立刻回到当前值。
    if (!running || hidden) return;
    const timer = setInterval(() => setBeat((beat) => beat + 1), HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [hidden, running]);
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
  const hasContextWindow =
    typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0;

  // 指标平铺成一张表，分组只是它们的 groupBy 结果。token 类指标只算有 usage
  // 的 step，性能类指标只算有采样的 step；数据缺失时整条不入表，而不是显示假的 0（§7）。
  const metrics: StatMetric[] = [
    {
      key: "turns",
      group: "scale",
      label: t("chat.stats.turnsLabel"),
      // tooltip 左列已经是名称，右列再带一遍单位就成了「Turns 51 turns」；
      // 无量纲歧义的计数类读数因此只给裸数字。
      value: String(stats.turns),
      short: fill("chat.stats.turns", "{n}", String(stats.turns)),
    },
    {
      key: "steps",
      group: "scale",
      label: t("chat.stats.stepsLabel"),
      value: String(stats.steps),
      short: fill("chat.stats.steps", "{n}", String(stats.steps)),
    },
    // 与用量环用同一个 contextWindow 判空口径：没有模型上下文窗口信息（老会话/
    // text 模式）时该条整个不存在，而不是显示一个假的 0%。
    ...(hasContextWindow
      ? [
          {
            key: "context",
            group: "context" as const,
            label: t("chat.stats.contextUsageLabel"),
            value: fill("chat.stats.percentValue", "{p}", formatStatPercent(ratio)),
            short: fill("chat.stats.contextUsage", "{p}", formatStatPercent(ratio)),
          },
        ]
      : []),
    {
      key: "llmTime",
      group: "time",
      label: t("chat.stats.llmTimeLabel"),
      value: formatStatDuration(durations.llmMs),
      short: fill("chat.stats.llmTime", "{t}", formatStatDuration(durations.llmMs)),
    },
    {
      key: "toolTime",
      group: "time",
      label: t("chat.stats.toolTimeLabel"),
      value: formatStatDuration(durations.toolMs),
      short: fill("chat.stats.toolTime", "{t}", formatStatDuration(durations.toolMs)),
    },
    ...(stats.inputTokens > 0
      ? [
          {
            key: "inputTokens",
            group: "tokens" as const,
            label: t("chat.stats.inputTokensLabel"),
            value: fill(
              "chat.stats.tokenValue",
              "{n}",
              formatStatTokens(stats.inputTokens, locale),
            ),
            short: fill(
              "chat.stats.inputTokensShort",
              "{n}",
              formatStatTokens(stats.inputTokens, locale),
            ),
          },
        ]
      : []),
    ...(stats.outputTokens > 0
      ? [
          {
            key: "outputTokens",
            group: "tokens" as const,
            label: t("chat.stats.outputTokensLabel"),
            value: fill(
              "chat.stats.tokenValue",
              "{n}",
              formatStatTokens(stats.outputTokens, locale),
            ),
            short: fill(
              "chat.stats.outputTokensShort",
              "{n}",
              formatStatTokens(stats.outputTokens, locale),
            ),
          },
        ]
      : []),
    ...(stats.cacheHitRatio !== null
      ? [
          {
            key: "cacheHit",
            group: "tokens" as const,
            label: t("chat.stats.cacheHitLabel"),
            value: fill("chat.stats.percentValue", "{p}", formatStatPercent(stats.cacheHitRatio)),
            short: fill("chat.stats.cacheHit", "{p}", formatStatPercent(stats.cacheHitRatio)),
          },
        ]
      : []),
    ...(stats.ttftAvgMs !== null
      ? [
          {
            key: "ttft",
            group: "perf" as const,
            label: t("chat.stats.ttftAvgLabel"),
            value: formatStatLatency(stats.ttftAvgMs),
            short: fill("chat.stats.ttftAvg", "{t}", formatStatLatency(stats.ttftAvgMs)),
          },
        ]
      : []),
    ...(stats.decodeTokPerSec !== null
      ? [
          {
            key: "throughput",
            group: "perf" as const,
            label: t("chat.stats.throughputLabel"),
            value: fill(
              "chat.stats.throughput",
              "{n}",
              formatStatThroughput(stats.decodeTokPerSec),
            ),
            short: fill(
              "chat.stats.throughput",
              "{n}",
              formatStatThroughput(stats.decodeTokPerSec),
            ),
          },
        ]
      : []),
  ];

  const groups: StatGroup[] = (["scale", "context", "time", "tokens", "perf"] as const).flatMap(
    (key) => {
      const groupMetrics = metrics.filter((metric) => metric.group === key);
      if (groupMetrics.length === 0) return [];
      return [{ key, minWidth: GROUP_MIN_WIDTH[key], metrics: groupMetrics }];
    },
  );

  const prefix = stats.approximate ? `${t("chat.stats.approximate")} ` : "";
  // 屏读拿到的是全称版：单行的 `↑111M` / `TTFT 20.9s` 读出来是噪音。
  const fullText =
    prefix +
    groups
      .map((group) => group.metrics.map((m) => `${m.label} ${m.value}`).join(" · "))
      .join(" ｜ ");

  // tooltip 是状态栏的「完整版」：单行受容器分档只露出高优先级分组，且用的是
  // 工程缩写；这里改用仪表盘式的「分区小标题 + 逐指标一行」，每条都是
  // 本地化全称。相比把一组数字用 · 粘成一句，逐行才能让名称与读数各自
  // 成列；右列 tabular-nums 竖直对齐，气泡解除默认 max-w 并 nowrap，读数不被折断。
  const groupLabelKey: Record<StatGroupKey, string> = {
    scale: "chat.stats.groupScale",
    context: "chat.stats.groupContext",
    time: "chat.stats.groupTime",
    tokens: "chat.stats.groupTokens",
    perf: "chat.stats.groupPerf",
  };
  const tooltipSections = [
    ...groups.map((group) => ({
      key: group.key as string,
      label: t(groupLabelKey[group.key]),
      rows: group.metrics.map((metric) => ({
        key: metric.key,
        label: metric.label,
        value: metric.value,
      })),
    })),
    // 压缩次数只在此处露出：它描述的是历史被截断过几次，属于事后追溯信息，
    // 不值得占用单行宽度（§4.2）。
    ...(stats.compactions > 0
      ? [
          {
            key: "history",
            label: t("chat.stats.groupHistory"),
            rows: [
              {
                key: "compactions",
                label: t("chat.stats.compactionsLabel"),
                value: fill(
                  "chat.stats.compactionsValue",
                  "{n}",
                  formatStatCount(stats.compactions, locale),
                ),
              },
            ],
          },
        ]
      : []),
  ];
  const tooltipFootnotes = [
    ...(stats.approximate ? [t("chat.stats.approximateHint")] : []),
    ...(compactAvailable ? [t("chat.manualCompactHint")] : []),
  ];
  const tooltip = (
    <span className="flex min-w-48 flex-col gap-2">
      {tooltipSections.map((section) => (
        <span key={section.key} className="flex flex-col gap-1">
          <span className="text-tiny font-medium uppercase tracking-wide text-muted-foreground/70">
            {section.label}
          </span>
          <span className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 whitespace-nowrap">
            {section.rows.map((row) => (
              <Fragment key={row.key}>
                <span className="font-normal text-muted-foreground">{row.label}</span>
                <span className="text-right tabular-nums">{row.value}</span>
              </Fragment>
            ))}
          </span>
        </span>
      ))}
      {tooltipFootnotes.length > 0 ? (
        <span className="flex flex-col gap-0.5 border-t border-border/60 pt-1.5 font-normal text-muted-foreground">
          {tooltipFootnotes.map((note) => (
            <span key={note}>{note}</span>
          ))}
        </span>
      ) : null}
    </span>
  );

  // 读数经外层 role="status" 的 aria-label 播报，这里对辅助技术整体隐藏，
  // 避免同一串数字被读两遍。
  const row = (
    <div
      aria-hidden="true"
      className={cn(
        "flex min-w-0 items-center overflow-hidden",
        "text-tiny leading-none whitespace-nowrap text-muted-foreground/65 tabular-nums",
      )}
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
          {/* 分隔用 1px 竖线而不是全角「｜」：全角字形自带侧边留白且笔画偏重，
              一行里重复五次会把读数切成几段孤岛。竖线高度压到 0.625rem 只齐字腰，
              视觉分量退到读数之后。aria-label 仍用「｜」拼接，不受此处影响。 */}
          {index > 0 ? (
            <span aria-hidden="true" className="mx-2.5 h-2.5 w-px shrink-0 bg-border/70" />
          ) : null}
          <span>{group.metrics.map((metric) => metric.short).join(" · ")}</span>
        </span>
      ))}
    </div>
  );

  return (
    // role="status" 提供语义；数字变化不做 aria-live 播报（流式期间会刷屏）。
    <div role="status" aria-live="off" aria-label={fullText} className="relative h-5 w-full">
      {/* 毛玻璃裙边：读数浮在会滚动的正文上方，正文滚进输入区下面时会和底下的
          文字重叠到难以辨认，输入卡片圆角外侧的弧形缺口也会漏出正文。裙边与
          卡片同宽，上探 2rem（= 卡片 rounded-4xl 的半径）藏到卡片身后，把弧形
          缺口一并盖住；-z-10 让它压在卡片之下、正文之上。空态占位分支不带这层。 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-8 bottom-0 -z-10 bg-background/70 backdrop-blur-md"
      />
      {/* overflow-hidden 兜底：tooltip trigger 是 shrink-0，极窄时宁可裁剪也不撑破布局。 */}
      <div className="@container flex h-5 w-full items-center justify-center overflow-hidden">
        <LabelTooltip label={tooltip} contentClassName="max-w-none">
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
                  className={cn(
                    "flex min-w-0 cursor-pointer items-center rounded-full px-1.5 outline-hidden transition-[background-color]",
                    "hover:bg-muted/50 focus-visible:bg-muted/50",
                  )}
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
    </div>
  );
}
