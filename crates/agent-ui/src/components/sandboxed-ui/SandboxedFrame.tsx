// The one iframe used for plugin panels, MCP App views and HTML previews: sandbox
// "allow-scripts" only (never allow-same-origin, popups, forms, modals or top
// navigation), no referrer, no permissions policy grants. A bridge, when given, only ever
// sees messages whose event.source is this frame's own window.

import { useLocale } from "@liveagent/ui/i18n/index";
import {
  type JsonRpcNotification,
  type JsonRpcResponse,
  listenToSandboxedFrame,
  SANDBOXED_UI_SANDBOX,
  type SandboxedUiBridge,
} from "@liveagent/ui/lib/sandboxed-ui/protocol";
import {
  observeDocumentThemeMode,
  readDocumentThemeMode,
  type SandboxedUiThemeMode,
} from "@liveagent/ui/lib/sandboxed-ui/theme";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type CSSProperties, useEffect, useRef, useState } from "react";

export type SandboxedFramePost = (message: JsonRpcResponse | JsonRpcNotification) => void;

export type SandboxedFrameProps = {
  title: string;
  /** Capability URL of a plugin page (absolute). Exactly one of src/srcDoc. */
  src?: string;
  /** Fetched HTML that already carries the backend's CSP meta tag. */
  srcDoc?: string;
  className?: string;
  style?: CSSProperties;
  /**
   * Builds the host bridge for this frame. Called again (and the old bridge disposed)
   * only when the frame content (src/srcDoc) changes: a page that already initialized
   * keeps its bridge, so the latest function is read at that point. Omit for content
   * that gets no host methods.
   */
  createBridge?: (post: SandboxedFramePost) => SandboxedUiBridge;
  onLoad?: () => void;
};

export function SandboxedFrame(props: SandboxedFrameProps) {
  const { title, src, srcDoc, className, style, createBridge, onLoad } = props;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const createBridgeRef = useRef(createBridge);
  createBridgeRef.current = createBridge;
  const hasBridge = Boolean(createBridge);

  // biome-ignore lint/correctness/useExhaustiveDependencies: one bridge per frame content.
  useEffect(() => {
    const build = createBridgeRef.current;
    if (!build || typeof window === "undefined") return;
    const frame = frameRef.current;
    if (!frame) return;
    const bridge = build((message) => {
      // Target origin "*" is the only one an opaque-origin page matches; nothing secret
      // is ever sent through this bridge.
      frame.contentWindow?.postMessage(message, "*");
    });
    const stop = listenToSandboxedFrame(
      window,
      () => frameRef.current?.contentWindow,
      bridge.receive,
    );
    return () => {
      stop();
      bridge.dispose();
    };
  }, [hasBridge, src, srcDoc]);

  return (
    <iframe
      ref={frameRef}
      title={title}
      sandbox={SANDBOXED_UI_SANDBOX}
      referrerPolicy="no-referrer"
      {...(srcDoc !== undefined ? { srcDoc } : { src })}
      className={cn("block w-full border-0 bg-transparent", className)}
      style={style}
      onLoad={onLoad}
      data-sandboxed-frame=""
    />
  );
}

/** The document's light/dark mode, updated when the user switches themes. */
export function useDocumentThemeMode(): SandboxedUiThemeMode {
  const [mode, setMode] = useState<SandboxedUiThemeMode>(() => readDocumentThemeMode());
  useEffect(() => observeDocumentThemeMode(setMode), []);
  return mode;
}

/** The current UI locale tag handed to pages ("en-US" or "zh-CN"). */
export function useSandboxedUiLocale() {
  const { locale } = useLocale();
  return locale;
}
