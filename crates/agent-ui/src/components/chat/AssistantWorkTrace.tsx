import { ChevronDown } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { LazyCollapse } from "./LazyCollapse";
import { useAttentionDisclosure } from "./useAttentionDisclosure";

const PIXEL_KEYS = [
  "top-start",
  "top",
  "top-end",
  "start",
  "center",
  "end",
  "bottom-start",
  "bottom",
  "bottom-end",
] as const;

const PIXEL_DELAYS = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});

type LoadingPixelStyle = CSSProperties & {
  "--chat-work-delay": `${number}ms`;
};

function WorkPixelGrid({ active }: { active: boolean }) {
  return (
    // 3×4px + 2×1.5px = 15px，比下方活动行的 12px 图标列宽：居中溢出到图标列
    // 宽度的盒子里，表头的像素格才和思考/工具图标共用同一条竖中轴。
    <span
      aria-hidden="true"
      className="flex w-3 shrink-0 items-center justify-center"
      data-chat-work-grid=""
    >
      <span className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
        {PIXEL_DELAYS.map((delay, index) => (
          <span
            key={PIXEL_KEYS[index]}
            className="chat-work-pixel size-1 bg-foreground"
            data-paused={active ? undefined : ""}
            style={{ "--chat-work-delay": `${delay}ms` } as LoadingPixelStyle}
          />
        ))}
      </span>
    </span>
  );
}

export function formatElapsedTime(elapsedMs: number) {
  const totalSeconds = Math.floor(elapsedMs / 1_000);
  if (totalSeconds < 1) return "";
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours > 0 ? `${hours}h` : "", minutes > 0 ? `${minutes}m` : "", `${seconds}s`]
    .filter(Boolean)
    .join("");
}

export function AssistantWorkTrace({
  children,
  collapsedTail,
  className,
  durationMs,
  hasDetails,
  attentionRequired = false,
  awaitingDecision = false,
  running,
  collapseAfterAnswer = false,
}: {
  children: ReactNode;
  /**
   * 当前正在进行的活动区块（运行中的工具组 / 思考中 / 正在流式输出的
   * 进度文本）。仅在「运行中且用户手动折叠了本区块」时渲染在折叠头下方，
   * 这样折叠后外面不至于空无一物；展开时内容本就可见，不再重复。
   */
  collapsedTail?: ReactNode;
  className?: string;
  durationMs?: number;
  hasDetails: boolean;
  attentionRequired?: boolean;
  /**
   * 回合停在用户决策上（提问 / 计划审批 / 工具审批）：进度还在，但没有任何
   * 东西在跑。此时像素格与标题冻结成静态，避免用闪烁把「等你」误报成「在忙」。
   */
  awaitingDecision?: boolean;
  running: boolean;
  /** 回复有总结文案（answer）时：回合结束（流停止）后自动折叠一次。 */
  collapseAfterAnswer?: boolean;
}) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useAttentionDisclosure(attentionRequired, running);

  // 有总结文案时，回合完成（running 变 false）后自动折叠「处理中」区块一次；
  // 之后 disclosure 所有权交还给用户，手动展开/折叠不再被强制收回，
  // 也不会和 attentionRequired（待用户交互的卡片）的强制展开打架。
  useEffect(() => {
    if (!running && !attentionRequired && collapseAfterAnswer) setExpanded(false);
  }, [running, attentionRequired, collapseAfterAnswer, setExpanded]);
  const [elapsedMs, setElapsedMs] = useState(durationMs ?? 0);
  const startedAtRef = useRef<number | null>(running ? Date.now() : null);

  useEffect(() => {
    if (!running) {
      if (durationMs !== undefined) {
        setElapsedMs(Math.max(0, durationMs));
      } else if (startedAtRef.current !== null) {
        setElapsedMs(Math.max(0, Date.now() - startedAtRef.current));
      }
      return;
    }

    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    const updateElapsed = () => {
      const startedAt = startedAtRef.current;
      if (startedAt !== null) setElapsedMs(Math.max(0, Date.now() - startedAt));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [durationMs, running]);

  const elapsedLabel = formatElapsedTime(elapsedMs);
  const label = `${running ? t("chat.work.running") : t("chat.work.activity")}${
    elapsedLabel ? ` ${elapsedLabel}` : ""
  }`;
  const header = (
    <>
      {running ? <WorkPixelGrid active={!awaitingDecision} /> : null}
      <span className={cn(running && !awaitingDecision ? "shimmer" : "text-foreground/65")}>
        {label}
      </span>
      {hasDetails ? (
        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 text-foreground/40 opacity-0 transition-[opacity,transform] duration-150 group-hover/work-trace:opacity-100 group-focus-visible/work-trace:opacity-100 motion-reduce:transition-none",
            !expanded && "-rotate-90",
          )}
        />
      ) : null}
      <span aria-hidden="true" className="h-px min-w-8 flex-1 bg-foreground/10" />
    </>
  );

  return (
    <section
      className={cn("my-0 text-foreground/60", className)}
      aria-label={t("chat.work.activity")}
      aria-busy={running && !awaitingDecision}
      data-chat-work-trace=""
    >
      {hasDetails ? (
        <button
          type="button"
          className="group/work-trace flex w-full items-center gap-2 rounded-lg py-1 text-[calc(13px*var(--zone-font-scale,1))] font-[450] transition-colors hover:text-foreground/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {header}
        </button>
      ) : (
        <div className="flex items-center gap-2 py-1 text-[calc(13px*var(--zone-font-scale,1))] font-[450]">
          {header}
        </div>
      )}

      {hasDetails ? (
        <LazyCollapse className="[contain:layout_paint]" open={expanded}>
          {() => <div className="mt-1 [scrollbar-gutter:stable]">{children}</div>}
        </LazyCollapse>
      ) : null}
      {running && hasDetails && !expanded && collapsedTail ? (
        <div className="mt-1" data-chat-work-collapsed-tail="">
          {collapsedTail}
        </div>
      ) : null}
    </section>
  );
}
