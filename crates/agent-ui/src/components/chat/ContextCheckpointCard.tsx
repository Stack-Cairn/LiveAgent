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
        "w-full overflow-hidden rounded-xl border border-glass-border/85 bg-glass shadow-ui-contextcheckpointcard-3",
        "dark:shadow-ui-contextcheckpointcard-4",
        className,
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((previous) => !previous)}
        className={cn(
          "flex w-full items-center gap-3 px-3.5 py-3 text-left",
          "transition-colors duration-150 hover:bg-surface-subtle",
        )}
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-glass-fill/90">
          <CheckCircle2 size={16} strokeWidth={1.8} className="text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground/90">
              {t("chat.contextCheckpoint.title")}
            </span>
            <span
              className={cn(
                "inline-flex items-center rounded-md bg-glass-fill px-1.5 py-1px text-xs font-normal",
                "tabular-nums text-muted-foreground",
              )}
            >
              {messageCountLabel}
            </span>
          </div>
          <div className="mt-2px text-xs text-muted-foreground/70">
            {generatedBy.providerId} · {generatedBy.model}
          </div>
        </div>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-200",
            expanded ? "rotate-0" : "-rotate-90",
          )}
        />
      </button>
      {expanded ? (
        <div className="overflow-hidden border-t border-glass-border/60 px-3.5 py-3">
          <Markdown content={content} className="font-chat text-sm" readOnly={readOnly} />
        </div>
      ) : null}
    </div>
  );
}
