import type {
  FileToolFieldPreview,
  FileToolPreview,
} from "../../../../lib/chat/messages/toolPreview";
import { EditDiffView } from "./EditDiffView";
import {
  MetaTags,
  PathDisplay,
  ToolScrollablePre,
  ToolSurface,
  ToolSurfaceLabel,
} from "./ToolResultDisplay";

// Streaming args display for the file-writing tools (Write / Edit /
// NotebookEdit): live-updating path, true char/line counts and a bounded
// content preview, all derived once by deriveFileToolPreview.

function StreamingArgPlaceholder({ label }: { label: string }) {
  return (
    <ToolSurface>
      <div className="text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.6] text-muted-foreground/62">
        {label}
      </div>
    </ToolSurface>
  );
}

function StreamingTextPreviewSurface({
  label,
  emptyLabel,
  preview,
}: {
  label: string;
  emptyLabel: string;
  preview: FileToolFieldPreview;
}) {
  return (
    <ToolSurface className="overflow-hidden px-0 py-0">
      <div className="px-2.5 pt-2">
        <ToolSurfaceLabel label={label} />
      </div>
      {preview.has ? (
        preview.text ? (
          <ToolScrollablePre className="max-h-56 rounded-none bg-black/[0.02] dark:bg-white/[0.03]">
            {preview.text}
          </ToolScrollablePre>
        ) : (
          <div className="px-2.5 pb-2 text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.6] text-muted-foreground/62">
            {emptyLabel}
          </div>
        )
      ) : (
        <div className="px-2.5 pb-2 text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.6] text-muted-foreground/62">
          Waiting for {label}...
        </div>
      )}
    </ToolSurface>
  );
}

function PathSurface({ path }: { path: string }) {
  return (
    <ToolSurface>
      <ToolSurfaceLabel label="path" />
      <PathDisplay
        path={path}
        className="block min-w-0 break-all font-mono text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.6]"
      />
    </ToolSurface>
  );
}

export function FileToolArgsDisplay({ preview }: { preview: FileToolPreview }) {
  if (preview.kind === "write") {
    if (!preview.path && !preview.content.has) {
      return <StreamingArgPlaceholder label="Waiting for file content..." />;
    }
    const fieldLabel = preview.field === "new_source" ? "new source" : "content";
    return (
      <div className="tool-expand flex flex-col gap-2">
        {preview.path ? <PathSurface path={preview.path} /> : null}
        {preview.content.has ? (
          <MetaTags
            tags={[
              ...(preview.name === "Write" ? [{ label: "mode", value: "rewrite" }] : []),
              { label: "chars", value: String(preview.content.chars) },
              { label: "lines", value: String(preview.content.lines) },
              ...(preview.content.truncated ? [{ label: "preview", value: "partial" }] : []),
            ]}
          />
        ) : null}
        <StreamingTextPreviewSurface
          label={fieldLabel}
          emptyLabel={`(empty ${fieldLabel})`}
          preview={preview.content}
        />
      </div>
    );
  }

  if (!preview.path && !preview.oldString.has && !preview.newString.has) {
    return <StreamingArgPlaceholder label="Waiting for replacement strings..." />;
  }
  return (
    <div className="tool-expand flex flex-col gap-2">
      {preview.path ? <PathSurface path={preview.path} /> : null}
      <MetaTags
        tags={[
          ...(typeof preview.expectedReplacements === "number"
            ? [{ label: "expected", value: String(preview.expectedReplacements) }]
            : []),
          ...(preview.replaceAll ? [{ label: "all", value: "true" }] : []),
          ...(preview.oldString.has
            ? [
                { label: "old", value: `${preview.oldString.chars} chars` },
                { label: "old lines", value: String(preview.oldString.lines) },
              ]
            : []),
          ...(preview.newString.has
            ? [
                { label: "new", value: `${preview.newString.chars} chars` },
                { label: "new lines", value: String(preview.newString.lines) },
              ]
            : []),
        ]}
      />
      {preview.oldString.has && preview.newString.has ? (
        <EditDiffView
          beforeText={preview.oldString.text}
          afterText={preview.newString.text}
          filePath={preview.path}
        />
      ) : (
        <>
          <StreamingTextPreviewSurface
            label="old string"
            emptyLabel="(empty old string)"
            preview={preview.oldString}
          />
          <StreamingTextPreviewSurface
            label="new string"
            emptyLabel="(empty replacement)"
            preview={preview.newString}
          />
        </>
      )}
    </div>
  );
}
