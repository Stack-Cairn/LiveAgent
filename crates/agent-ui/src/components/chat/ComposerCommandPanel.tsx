import { AlertCircle, Clock3, Info, Repeat, X } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  type ComposerCommandPanelState,
  describeLoopInterval,
} from "@liveagent/ui/lib/chat/composerCommands";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { ReactNode } from "react";

const NOTICE_TONES = {
  info: { icon: Info, surface: "bg-foreground/[0.04]", iconColor: "text-muted-foreground" },
  warning: {
    icon: Clock3,
    surface: "bg-amber-500/[0.10] dark:bg-amber-400/[0.12]",
    iconColor: "text-amber-700 dark:text-amber-400",
  },
  error: { icon: AlertCircle, surface: "bg-destructive/[0.08]", iconColor: "text-destructive" },
} as const;

/**
 * “/”指令的本地结果面板（提示、错误、/loop 结果）：渲染在输入框内、正文上方，
 * 可关闭，不进入转录区，也不发给模型。每种结果都是同一条提示条：语气图标 +
 * 指令标签 + 文案 + 关闭；/loop 的补充内容（取消方式、任务列表）放在条内第二行。
 * 标题只作为无障碍名称，不再单独占一行。
 */
export function ComposerCommandPanel({
  panel,
  onClose,
}: {
  panel: ComposerCommandPanelState;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const title =
    panel.type === "loops"
      ? t("chat.commands.loopsTitle")
      : panel.type === "loopCreated"
        ? t("chat.commands.loopCreated")
        : panel.type === "notice"
          ? t("chat.commands.title")
          : t("chat.commands.failed");
  const tone = panel.type === "error" ? (panel.tone ?? "error") : "info";
  const isLoop = panel.type === "loops" || panel.type === "loopCreated";
  const ToneIcon = isLoop ? Repeat : NOTICE_TONES[tone].icon;
  const command = panel.type === "error" ? panel.command : isLoop ? "loop" : undefined;

  let headline: string;
  let details: ReactNode = null;
  if (panel.type === "loopCreated") {
    headline = `${t("chat.commands.loopCreated")} · ${describeLoopInterval(panel.loop.interval, t)}`;
    // 提示词没有长度上限（需写全上下文）：单行截断、悬停看全文，取消命令始终可见。
    details = (
      <>
        <p className="truncate text-foreground/80" title={panel.loop.prompt}>
          {panel.loop.prompt}
        </p>
        <p>
          {t("chat.commands.loopHint")}{" "}
          <code className="whitespace-nowrap font-mono text-foreground/80">
            /loop cancel {panel.loop.id}
          </code>
        </p>
      </>
    );
  } else if (panel.type === "loops") {
    headline =
      panel.loops.length === 0
        ? t("chat.commands.loopsEmpty")
        : `${t("chat.commands.loopsTitle")} · ${panel.loops.length}`;
    details =
      panel.loops.length === 0 ? null : (
        <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
          {panel.loops.map((loop) => (
            <li key={loop.id} className="flex min-w-0 gap-2">
              <span className="shrink-0 font-mono text-foreground/80">{loop.id}</span>
              <span className="shrink-0 tabular-nums">
                {describeLoopInterval(loop.interval, t)}
              </span>
              <span
                className={cn("min-w-0 truncate", !loop.enabled && "line-through")}
                title={loop.prompt}
              >
                {loop.prompt}
              </span>
            </li>
          ))}
        </ul>
      );
  } else {
    headline = panel.message;
  }

  return (
    <section
      role={tone === "error" ? "alert" : "status"}
      aria-label={title}
      data-composer-command-panel={panel.type}
      data-tone={tone}
      className={cn(
        "mb-2 flex min-w-0 flex-col gap-1 rounded-lg py-1.5 pl-2 pr-1 text-xs leading-4",
        NOTICE_TONES[tone].surface,
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <ToneIcon className={cn("mt-px size-3.5 shrink-0", NOTICE_TONES[tone].iconColor)} />
        {command ? (
          // 用户模板的指令名没有长度上限：标签最多占四成宽度，超出截断，悬停看全名。
          <code
            title={`/${command}`}
            className="min-w-0 max-w-[40%] truncate rounded-md bg-background/70 px-1.5 font-mono text-tiny leading-4 text-foreground/85"
          >
            /{command}
          </code>
        ) : null}
        <p className="min-w-0 flex-1 break-words text-foreground/90">{headline}</p>
        <button
          type="button"
          aria-label={t("chat.commands.closePanel")}
          title={t("chat.commands.closePanel")}
          className="-my-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClose}
        >
          <X className="size-3" />
        </button>
      </div>
      {details ? (
        // 与图标后的文字起点对齐（图标 14px + 间距 8px），右侧让出关闭按钮。
        <div className="min-w-0 break-words pl-[22px] pr-6 text-muted-foreground">{details}</div>
      ) : null}
    </section>
  );
}
