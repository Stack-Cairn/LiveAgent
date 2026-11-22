// HTML preview card (K-brain capability `html_previews`): title, source and size, the page
// inline in the shared sandbox, fullscreen in a fresh sandboxed frame, the side panel, and
// reload. Previews get no host methods: their frames have no bridge, so every message they
// post is ignored.

import {
  AppWindow,
  Braces,
  Maximize2,
  PanelRightOpen,
  RefreshCw,
} from "@liveagent/ui/components/IconSet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { HtmlPreviewRecord } from "@liveagent/ui/lib/chat/htmlPreviews";
import { formatUploadedFileSize } from "@liveagent/ui/lib/chat/uploadedFiles";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type ReactNode, useEffect, useState } from "react";
import { SandboxedFrame } from "./SandboxedFrame";
import { useSandboxedUiTranscriptHost } from "./SandboxedUiHostContext";

const INLINE_PREVIEW_HEIGHT = 280;

type HtmlLoad =
  | { status: "loading" }
  | { status: "ready"; html: string }
  | { status: "error"; message: string };

/** Loads a preview's HTML through `load`; `reloadKey` forces a new fetch. */
export function useSandboxedHtml(
  url: string | undefined,
  load: ((url: string) => Promise<string>) | undefined,
  reloadKey = 0,
): HtmlLoad {
  const [state, setState] = useState<HtmlLoad>({ status: "loading" });
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey forces a fresh fetch.
  useEffect(() => {
    if (!url || !load) return;
    let cancelled = false;
    setState({ status: "loading" });
    load(url).then(
      (html) => {
        if (!cancelled) setState({ status: "ready", html });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [load, url, reloadKey]);
  return state;
}

function previewTitle(preview: HtmlPreviewRecord, fallback: string) {
  return preview.title.trim() || preview.path?.split(/[\\/]/).pop() || fallback;
}

function IconButton(props: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      title={props.label}
      aria-label={props.label}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function HtmlPreviewFrame(props: {
  preview: HtmlPreviewRecord;
  load: (url: string) => Promise<string>;
  reloadKey?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { t } = useLocale();
  const state = useSandboxedHtml(props.preview.url, props.load, props.reloadKey);
  if (state.status === "ready") {
    return (
      <SandboxedFrame
        key={props.reloadKey}
        title={previewTitle(props.preview, t("sandboxedUi.preview.untitled"))}
        srcDoc={state.html}
        className={cn("bg-white", props.className)}
        style={props.style}
      />
    );
  }
  return (
    <div
      className={cn("flex items-center px-3 py-2 text-xs text-muted-foreground", props.className)}
      style={props.style}
      title={state.status === "error" ? state.message : undefined}
    >
      {state.status === "error" ? t("sandboxedUi.preview.loadFailed") : t("sandboxedUi.loading")}
    </div>
  );
}

export type HtmlPreviewCardProps = {
  preview: HtmlPreviewRecord;
  /** Shown instead of the inline frame when the user collapses the card (fence source). */
  fallback?: ReactNode;
};

export function HtmlPreviewCard({ preview, fallback }: HtmlPreviewCardProps) {
  const host = useSandboxedUiTranscriptHost();
  const { t } = useLocale();
  const [reloadKey, setReloadKey] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [showSource, setShowSource] = useState(false);
  if (!host) return null;
  const title = previewTitle(preview, t("sandboxedUi.preview.untitled"));
  const source =
    preview.source === "file"
      ? t("sandboxedUi.preview.sourceFile")
      : t("sandboxedUi.preview.sourceMessage");

  return (
    <div
      className="my-2 overflow-hidden rounded-lg border border-border/60 bg-background"
      data-html-preview-card={preview.previewId}
      data-sandboxed-view=""
    >
      <div className="flex h-8 items-center gap-1.5 border-b border-border/50 px-2 text-xs">
        <AppWindow className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className="min-w-0 truncate font-medium text-foreground/85"
          title={preview.path ?? title}
        >
          {title}
        </span>
        <span className="shrink-0 text-muted-foreground">
          · {source} · {formatUploadedFileSize(preview.bytes)}
        </span>
        <span className="flex-1" />
        {fallback ? (
          <IconButton
            label={
              showSource
                ? t("sandboxedUi.preview.showPreview")
                : t("sandboxedUi.preview.showSource")
            }
            onClick={() => setShowSource((value) => !value)}
          >
            <Braces className="size-3.5" />
          </IconButton>
        ) : null}
        <IconButton label={t("sandboxedUi.reload")} onClick={() => setReloadKey((key) => key + 1)}>
          <RefreshCw className="size-3.5" />
        </IconButton>
        {host.openPreviewInSidePanel ? (
          <IconButton
            label={t("sandboxedUi.preview.openSidePanel")}
            onClick={() => host.openPreviewInSidePanel?.(preview)}
          >
            <PanelRightOpen className="size-3.5" />
          </IconButton>
        ) : null}
        <IconButton
          label={t("sandboxedUi.preview.openFullscreen")}
          onClick={() => setFullscreen(true)}
        >
          <Maximize2 className="size-3.5" />
        </IconButton>
      </div>
      {showSource && fallback ? (
        fallback
      ) : (
        <HtmlPreviewFrame
          preview={preview}
          load={host.loadPreviewHtml}
          reloadKey={reloadKey}
          style={{ height: INLINE_PREVIEW_HEIGHT }}
        />
      )}
      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogContent
          showCloseButton
          closeLabel={t("sandboxedUi.close")}
          className="flex h-[min(92vh,1000px)] max-w-[min(96vw,1400px)] flex-col overflow-hidden"
        >
          <DialogHeader>
            <DialogTitle className="truncate">{title}</DialogTitle>
          </DialogHeader>
          {fullscreen ? (
            // A new frame, so the inline one keeps its own state.
            <HtmlPreviewFrame
              preview={preview}
              load={host.loadPreviewHtml}
              reloadKey={reloadKey}
              className="min-h-0 flex-1 border-t border-border/50"
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
