import { Empty, MarkdownBlock, SourceBlocks } from "../shared";
import type { DetailTabProps } from "../types";

export function RenderedTab(props: DetailTabProps) {
  const { record, t } = props;
  const primary = record.outputDetail ?? record.inputDetail;
  const hasThinking = typeof record.thinkingDetail === "string" && record.thinkingDetail !== "";
  const blocks = record.outputBlocks ?? record.sourceBlocks;
  const supplementalBlocks =
    primary === undefined
      ? blocks
      : blocks?.filter((block) => block.type !== "text" && block.type !== "thinking");
  if (
    (primary === undefined || primary === "") &&
    !hasThinking &&
    (supplementalBlocks === undefined || supplementalBlocks.length === 0)
  ) {
    return <Empty t={t} />;
  }
  return (
    <div className="space-y-4">
      {hasThinking && (
        <section className="space-y-1 rounded border border-border/50 bg-muted/20 p-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            thinking
          </p>
          <MarkdownBlock
            value={record.thinkingDetail}
            t={t}
            workdir={props.workdir}
            onOpenFileLink={props.onOpenFileLink}
          />
        </section>
      )}
      {primary !== undefined && (
        <MarkdownBlock
          value={primary}
          t={t}
          workdir={props.workdir}
          onOpenFileLink={props.onOpenFileLink}
        />
      )}
      {supplementalBlocks !== undefined && supplementalBlocks.length > 0 && (
        <SourceBlocks
          blocks={supplementalBlocks}
          t={t}
          workdir={props.workdir}
          onOpenFileLink={props.onOpenFileLink}
        />
      )}
    </div>
  );
}
