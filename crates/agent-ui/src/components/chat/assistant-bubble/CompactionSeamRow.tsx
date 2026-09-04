import { CompactionBand, CompactionMetaChip } from "@liveagent/ui/components/chat/CompactionBand";
import { LazyCollapse } from "@liveagent/ui/components/chat/LazyCollapse";
import { ChevronRight } from "@liveagent/ui/components/IconSet";
import { Markdown } from "@liveagent/ui/components/Markdown";
import { useLocale } from "@liveagent/ui/i18n/index";
import { formatTokenCount } from "@liveagent/ui/lib/chat/formatTokenCount";
import type { CompactionSeam } from "@liveagent/ui/lib/chat/replyContinuity";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type ReactNode, useState } from "react";

/**
 * A context compaction that happened *inside* a reply, rendered as one
 * milestone row of the processing trace. It reads as "the reply kept going
 * after the context was folded" rather than as a second reply. The summary
 * body only mounts on expand.
 *
 * A checkpoint that ends a run (idle manual compaction) is a different
 * thing — a divider between exchanges — and keeps the standalone
 * ContextCheckpointCard.
 */
export function CompactionSeamRow(props: {
  seam: CompactionSeam;
  readOnly?: boolean;
  workdir?: string;
}) {
  const { seam, readOnly = false, workdir } = props;
  const { locale, t } = useLocale();
  const [open, setOpen] = useState(false);
  const chips: ReactNode[] = [];
  if (seam.coveredMessageCount > 0) {
    chips.push(
      <CompactionMetaChip key="messages">
        {t("chat.contextCheckpoint.messageCount").replace(
          "{count}",
          String(seam.coveredMessageCount),
        )}
      </CompactionMetaChip>,
    );
  }
  if (typeof seam.contextUsageTokens === "number" && seam.contextUsageTokens > 0) {
    chips.push(
      <CompactionMetaChip key="tokens">
        {t("chat.contextCheckpoint.tokensAfter").replace(
          "{tokens}",
          formatTokenCount(seam.contextUsageTokens, locale),
        )}
      </CompactionMetaChip>,
    );
  }

  return (
    <div
      className="group/seam min-w-0 max-w-full pb-1"
      data-compaction-seam=""
      data-summary-id={seam.summaryId}
    >
      <CompactionBand
        as="button"
        buttonProps={{
          "aria-expanded": open,
          "aria-label": t("chat.contextCheckpoint.title"),
          className:
            "cursor-pointer select-none hover:bg-violet-500/[0.1] hover:border-violet-500/[0.28] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40 dark:hover:bg-violet-400/[0.11] dark:hover:border-violet-400/[0.26]",
          onClick: () => setOpen((previous) => !previous),
        }}
        label={t("chat.contextCheckpoint.seam")}
        meta={chips.length > 0 ? chips : undefined}
        trailing={
          <ChevronRight
            className={cn(
              "ml-auto h-3 w-3 shrink-0 text-violet-600/60 transition-transform duration-150 ease-out dark:text-violet-300/60",
              open ? "rotate-90" : "",
            )}
          />
        }
      />

      <LazyCollapse open={open}>
        {() => (
          <div className="overflow-hidden px-0.5 pb-1 pt-1.5">
            <div className="border-l-2 border-violet-500/25 pl-3 dark:border-violet-400/25">
              <div className="mb-1 text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground/70">
                {seam.generatedBy.providerId} · {seam.generatedBy.model}
              </div>
              <Markdown
                content={seam.content}
                className="font-chat thinking-markdown"
                readOnly={readOnly}
                workdir={workdir}
              />
            </div>
          </div>
        )}
      </LazyCollapse>
    </div>
  );
}
