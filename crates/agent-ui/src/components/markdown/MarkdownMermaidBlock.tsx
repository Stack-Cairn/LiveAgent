import { useLocale } from "@liveagent/ui/i18n/index";
import { useContext } from "react";
import { StreamdownContext } from "streamdown";
import { MermaidFullscreenButton } from "../MarkdownMermaidFullscreen";
import { CopyButton } from "../ui/copy-button";
import { MermaidDiagram } from "./MermaidDiagram";

export function MarkdownMermaidBlock({ chart, readOnly }: { chart: string; readOnly: boolean }) {
  const { t } = useLocale();
  const { isAnimating } = useContext(StreamdownContext);
  return (
    <div data-streamdown="mermaid-block" className="relative my-4 flex min-w-0 flex-col gap-2">
      <div className="flex h-8 items-center justify-between text-xs text-muted-foreground">
        <span className="ml-1 font-mono">mermaid</span>
        {!readOnly ? (
          <div className="flex items-center gap-1">
            <MermaidFullscreenButton chart={chart} />
            <CopyButton
              value={isAnimating ? "" : chart}
              label={t("chat.markdown.copyCode")}
              copiedLabel={t("chat.markdown.copied")}
            />
          </div>
        ) : null}
      </div>
      <MermaidDiagram chart={chart} interactive={!readOnly} />
    </div>
  );
}
