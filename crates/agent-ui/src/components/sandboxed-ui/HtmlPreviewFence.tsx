// An "html preview" fenced block in a message: once K-brain has saved it (preview.created,
// or the session's preview list) the block renders as a preview card; until then, and on
// hosts without previews, it stays an ordinary HTML code block.

import { useSandboxedUiTranscriptHost } from "@liveagent/ui/components/sandboxed-ui/SandboxedUiHostContext";
import {
  getHtmlPreview,
  htmlPreviewIdCandidates,
  useHtmlPreviewsVersion,
} from "@liveagent/ui/lib/chat/htmlPreviews";
import { type ReactNode, useEffect, useState } from "react";
import { HtmlPreviewCard } from "./HtmlPreviewCard";

export type HtmlPreviewFenceProps = {
  code: string;
  /** The block rendered as HTML source: shown when there is no preview. */
  fallback: ReactNode;
};

export function HtmlPreviewFence({ code, fallback }: HtmlPreviewFenceProps) {
  const host = useSandboxedUiTranscriptHost();
  const enabled = Boolean(host?.htmlPreviews);
  const conversationId = host?.conversationId;
  const version = useHtmlPreviewsVersion(enabled ? conversationId : undefined);
  const [candidates, setCandidates] = useState<string[]>([]);

  useEffect(() => {
    if (!enabled || !code.trim()) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    void htmlPreviewIdCandidates(code).then(
      (ids) => {
        if (!cancelled) setCandidates(ids);
      },
      () => {
        if (!cancelled) setCandidates([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [code, enabled]);

  if (!enabled || !conversationId) return fallback;
  void version;
  const preview = candidates
    .map((id) => getHtmlPreview(conversationId, id))
    .find((item) => item !== undefined);
  if (!preview) return fallback;
  return <HtmlPreviewCard preview={preview} fallback={fallback} />;
}
