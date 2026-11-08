import {
  type MetaTag,
  MetaTags,
  ToolScrollablePre,
  ToolSurface,
  ToolSurfaceLabel,
} from "@liveagent/ui/components/chat/ToolSurfaces";
import {
  formatTransferBytes,
  isSshManagerToolName,
  parseSshExecResult,
  parseSshTransferResult,
} from "@liveagent/ui/lib/chat/sshManagerDisplay";
import { previewText } from "@liveagent/ui/lib/chat/uiMessages";
import { cn } from "@liveagent/ui/lib/shared/utils";

const STREAM_PREVIEW_CHARS = 8000;

function StreamBlock({ label, text, tone }: { label: string; text: string; tone?: "error" }) {
  return (
    <ToolSurface>
      <ToolSurfaceLabel label={label} />
      <ToolScrollablePre
        className={cn(
          "max-h-56 bg-black/[0.02] font-mono dark:bg-white/[0.03]",
          tone === "error" && "text-red-700/85 dark:text-red-300/85",
        )}
      >
        {previewText(text.replace(/\n+$/, ""), STREAM_PREVIEW_CHARS)}
      </ToolScrollablePre>
    </ToolSurface>
  );
}

/**
 * A structured view of an SSHManager result when its text is one K-brain formats:
 * exec output, or an SFTP transfer. Anything else returns null and keeps the generic
 * "view return" text.
 */
export function getSshManagerResultView(toolName: string, text: string, isError?: boolean) {
  if (isError || !isSshManagerToolName(toolName)) return null;

  const exec = parseSshExecResult(text);
  if (exec) {
    const failed = exec.timedOut || (exec.exitCode !== "0" && exec.exitCode !== "unknown");
    const tags: MetaTag[] = [{ label: "exit", value: exec.exitCode }];
    if (exec.timedOut) tags.push({ label: "timed out", value: "true" });
    return (
      <div className="space-y-2" data-ssh-result="exec">
        <MetaTags tags={tags} />
        {exec.stdout ? <StreamBlock label="stdout" text={exec.stdout} /> : null}
        {exec.stderr ? (
          <StreamBlock label="stderr" text={exec.stderr} tone={failed ? "error" : undefined} />
        ) : null}
        {!exec.stdout && !exec.stderr ? (
          <div className="text-xs text-muted-foreground/60">(no output)</div>
        ) : null}
      </div>
    );
  }

  const transfer = parseSshTransferResult(text);
  if (transfer) {
    const tags: MetaTag[] = [{ label: transfer.direction || "transfer", value: transfer.status }];
    if (transfer.bytesTotal > 0 || transfer.bytesDone > 0) {
      tags.push({
        label: "bytes",
        value:
          transfer.bytesTotal > 0
            ? `${formatTransferBytes(transfer.bytesDone)} / ${formatTransferBytes(transfer.bytesTotal)}`
            : formatTransferBytes(transfer.bytesDone),
      });
    }
    if (transfer.filesTotal > 1) {
      tags.push({ label: "files", value: `${transfer.filesDone} / ${transfer.filesTotal}` });
    }
    tags.push({ label: "id", value: transfer.id });
    return (
      <div className="space-y-1.5" data-ssh-result="transfer">
        <MetaTags tags={tags} />
        {transfer.sourcePath || transfer.targetPath ? (
          <div className="break-all font-mono text-xs leading-1p55 text-foreground/70">
            {transfer.sourcePath} → {transfer.targetPath}
          </div>
        ) : null}
        {transfer.error ? (
          <div className="break-words text-xs text-red-700/85 dark:text-red-300/85">
            {transfer.error}
          </div>
        ) : null}
      </div>
    );
  }

  return null;
}
