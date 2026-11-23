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
            "cursor-pointer select-none hover:bg-compaction/10 hover:border-compaction/28 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-compaction/40",
          onClick: () => setOpen((previous) => !previous),
        }}
        label={t("chat.contextCheckpoint.seam")}
        meta={chips.length > 0 ? chips : undefined}
        trailing={
          <ChevronRight
            className={cn(
              "ml-auto size-3 shrink-0 text-compaction-icon/60 transition-transform duration-150 ease-out",
              open ? "rotate-90" : "",
            )}
          />
        }
      />

      <LazyCollapse open={open}>
        {() => (
          <div className="overflow-hidden px-0.5 pb-1 pt-1.5">
            <div className="border-l border-compaction/25 pl-3">
              <div className="mb-1 text-xs text-muted-foreground/70">
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
