import { Markdown } from "@liveagent/ui/components/Markdown";
import { useState } from "react";
import { useLocale } from "../../i18n/index";
import { cn } from "../../lib/shared/utils";
import { CheckCircle2, ChevronDown } from "../IconSet";

export function ContextCheckpointCard(props: {
  content: string;
  coveredMessageCount: number;
  generatedBy: { providerId: string; model: string };
  readOnly?: boolean;
  className?: string;
}) {
  const { content, coveredMessageCount, generatedBy, readOnly = false, className } = props;
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const messageCountLabel =
    coveredMessageCount > 0
      ? t("chat.contextCheckpoint.messageCount").replace("{count}", String(coveredMessageCount))
      : t("chat.contextCheckpoint.compressed");

  return (
    <div
      className={cn(
        "checkpoint-card w-full overflow-hidden rounded-xl border border-black/[0.06] bg-white/[0.85] shadow-[0_1px_3px_rgba(0,0,0,0.04),0_4px_12px_rgba(0,0,0,0.03)] dark:border-white/[0.1] dark:bg-white/[0.06] dark:shadow-[0_1px_3px_rgba(0,0,0,0.2),0_4px_12px_rgba(0,0,0,0.15)]",
        className,
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((previous) => !previous)}
        className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors duration-150 hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-black/[0.04] dark:bg-white/[0.08]">
          <CheckCircle2 size={16} strokeWidth={1.8} className="text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[calc(13px*var(--zone-font-scale,1))] font-medium text-foreground/90">
              {t("chat.contextCheckpoint.title")}
            </span>
            <span className="inline-flex items-center rounded-md bg-black/[0.05] px-1.5 py-[1px] text-[calc(11px*var(--zone-font-scale,1))] font-normal tabular-nums text-muted-foreground dark:bg-white/[0.08]">
              {messageCountLabel}
            </span>
          </div>
          <div className="mt-[2px] text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground/70">
            {generatedBy.providerId} · {generatedBy.model}
          </div>
        </div>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-200 ${expanded ? "rotate-0" : "-rotate-90"}`}
        />
      </button>
      {expanded ? (
        <div className="checkpoint-expand border-t border-black/[0.05] px-3.5 py-3 dark:border-white/[0.06]">
          <Markdown content={content} className="font-chat text-sm" readOnly={readOnly} />
        </div>
      ) : null}
    </div>
  );
}
