import type { ChatFileLink } from "../../../lib/chat/chatFileLinks";
import type { TrajectorySourceBlock } from "../../../lib/trajectory/types";
import { Markdown } from "../../Markdown";
import type { SectionState, Translate } from "./types";

export function Field(props: { label: string; value: string }) {
  return (
    <div className="flex gap-2 border-b border-border/40 py-1 last:border-0">
      <span className="w-24 shrink-0 text-muted-foreground">{props.label}</span>
      <span className="min-w-0 flex-1 break-words">{props.value}</span>
    </div>
  );
}

export function Empty(props: { t: Translate }) {
  return <p className="text-muted-foreground">{props.t("trajectory.details.noContent")}</p>;
}

export function TextBlock(props: { value: string | undefined; t: Translate; language?: string }) {
  if (props.value === undefined || props.value === "") return <Empty t={props.t} />;
  return (
    <pre
      data-language={props.language}
      className="max-h-full whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed"
    >
      {props.value}
    </pre>
  );
}

export function JsonBlock(props: { value: unknown; t: Translate }) {
  let serialized: string;
  try {
    serialized = JSON.stringify(props.value, null, 2);
  } catch {
    serialized = String(props.value);
  }
  return <TextBlock value={serialized} t={props.t} language="json" />;
}

export function MarkdownBlock(props: {
  value: string | undefined;
  t: Translate;
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  if (props.value === undefined || props.value === "") return <Empty t={props.t} />;
  return (
    <Markdown
      content={props.value}
      readOnly={props.onOpenFileLink === undefined}
      workdir={props.workdir}
      onOpenFileLink={props.onOpenFileLink}
      className="text-[12px] leading-relaxed [&_.chat-markdown]:text-[12px]"
    />
  );
}

export function SourceBlocks(props: {
  blocks: readonly TrajectorySourceBlock[] | undefined;
  t: Translate;
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  if (props.blocks === undefined || props.blocks.length === 0) return <Empty t={props.t} />;
  return (
    <div className="space-y-3">
      {props.blocks.map((block, index) => (
        <section key={`${block.type}:${block.callId ?? index}`} className="space-y-1">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {block.type}
            {block.toolName ? ` · ${block.toolName}` : ""}
            {block.callId ? ` · ${block.callId}` : ""}
          </p>
          {block.filePath && block.fileSource && props.onOpenFileLink ? (
            <button
              type="button"
              className="max-w-full truncate rounded border border-border/60 px-2 py-1 text-left text-[11px] font-medium text-primary hover:bg-muted/60"
              title={block.filePath}
              onClick={() => {
                const { filePath, fileSource } = block;
                if (filePath && fileSource) {
                  props.onOpenFileLink?.({ path: filePath, source: fileSource });
                }
              }}
            >
              {props.t("trajectory.details.openFile")} · {block.imageAlt ?? block.filePath}
            </button>
          ) : null}
          {block.imageSrc ? (
            <img
              src={block.imageSrc}
              alt={block.imageAlt ?? block.type}
              loading="lazy"
              className="max-h-72 max-w-full rounded border border-border/50 object-contain"
            />
          ) : block.type === "text" || block.type === "thinking" ? (
            <MarkdownBlock
              value={block.content}
              t={props.t}
              workdir={props.workdir}
              onOpenFileLink={props.onOpenFileLink}
            />
          ) : (
            <TextBlock value={block.content} t={props.t} />
          )}
        </section>
      ))}
    </div>
  );
}

export function SectionFailure(props: { state: SectionState; onRetry: () => void; t: Translate }) {
  if (props.state.status === "loading") {
    return <p className="text-muted-foreground">{props.t("trajectory.details.sectionLoading")}</p>;
  }
  if (props.state.status !== "failed") return null;
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground">{props.t("trajectory.details.sectionFailed")}</p>
      <button
        type="button"
        onClick={props.onRetry}
        className="rounded border border-border/60 px-2 py-0.5 text-[11px] hover:bg-muted/60"
      >
        {props.t("trajectory.details.retry")}
      </button>
    </div>
  );
}
