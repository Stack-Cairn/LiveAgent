import { Maximize2 } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useCallback, useState } from "react";
import { cn } from "../lib/shared/utils";
import { MermaidDiagram } from "./markdown/MermaidDiagram";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

function MermaidFullscreenDialog({ chart, onClose }: { chart: string; onClose: () => void }) {
  const { t } = useLocale();
  return (
    <Dialog open disablePointerDismissal onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className={cn(
          "fixed inset-0 m-0 flex h-full w-screen max-w-none overflow-hidden",
          "rounded-none border-0 bg-background p-0 shadow-none transition-none",
        )}
        closeLabel={t("chat.imageViewer.exitFullscreen")}
        data-liveagent-mermaid-fullscreen="true"
        showCloseButton
        style={{ opacity: 1, scale: "none", transform: "none" }}
      >
        <DialogTitle className="sr-only">{t("chat.imageViewer.fullscreen")}</DialogTitle>
        <MermaidDiagram chart={chart} fullscreen />
      </DialogContent>
    </Dialog>
  );
}

export function MermaidFullscreenButton({
  chart,
  className,
}: {
  chart: string;
  className?: string;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        type="button"
        aria-label={t("chat.imageViewer.fullscreen")}
        title={t("chat.imageViewer.fullscreen")}
        onClick={() => setOpen(true)}
        className={cn(
          "flex size-6 items-center justify-center rounded p-1 text-muted-foreground transition-colors",
          "hover:bg-muted hover:text-foreground",
          className,
        )}
      >
        <Maximize2 className="size-3.5" />
      </button>
      {open ? <MermaidFullscreenDialog chart={chart} onClose={close} /> : null}
    </>
  );
}
