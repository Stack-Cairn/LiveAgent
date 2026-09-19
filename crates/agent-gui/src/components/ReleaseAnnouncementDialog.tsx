import { ExternalLink, Sparkles } from "@liveagent/ui/components/IconSet";
import { Markdown } from "@liveagent/ui/components/Markdown";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { useLocale } from "@liveagent/ui/i18n/index";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ReleaseAnnouncementController } from "../lib/releaseAnnouncement";
import { releaseNotesBody, releaseTitle } from "../lib/releaseNotes";
import { formatReleaseDate } from "../pages/settings/aboutDate";

export function ReleaseAnnouncementDialog({
  controller,
}: {
  controller: ReleaseAnnouncementController;
}) {
  const { t } = useLocale();
  const announcement = controller.announcement;
  if (!announcement) return null;

  const title = releaseTitle(announcement) || `LiveAgent v${announcement.currentVersion}`;
  const releaseDate = formatReleaseDate(announcement.date);
  return (
    <Dialog
      open={controller.open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) controller.dismissForNow();
      }}
    >
      <DialogContent
        className="flex h-[min(42rem,calc(100dvh-3rem))] min-h-[420px] max-w-xl flex-col overflow-hidden p-0 max-[720px]:h-full max-[720px]:min-h-0"
        layout="fullscreen-mobile"
        showCloseButton
        closeLabel={t("appUpdate.announcementClose")}
      >
        <DialogHeader className="border-b border-border/50 bg-muted/15 px-5 py-4 max-[820px]:px-4 max-[820px]:py-3.5">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/10 text-primary">
              <Sparkles className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-tiny font-medium tracking-wide text-muted-foreground">
                {t("settings.aboutUpdateAnnouncement")}
              </div>
              <DialogTitle className="mt-1 truncate text-base leading-tight">{title}</DialogTitle>
              <DialogDescription className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                {controller.preview ? (
                  <span className="rounded-md border border-amber-500/20 bg-amber-500/[0.07] px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-300">
                    {t("appUpdate.announcementPreview")}
                  </span>
                ) : null}
                <span className="rounded-md border border-border/60 bg-background/70 px-1.5 py-0.5 font-medium text-foreground/75">
                  v{announcement.currentVersion}
                </span>
                {releaseDate ? (
                  <span className="text-muted-foreground/80">
                    {t("settings.aboutReleaseDate")} {releaseDate}
                  </span>
                ) : null}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogBody className="min-h-0 flex-1 bg-muted/10 px-4 py-3.5 max-[820px]:px-3.5 max-[820px]:py-3">
          <div className="rounded-xl border border-border/60 bg-background px-4 py-3.5 shadow-xs">
            <Markdown content={releaseNotesBody(announcement)} className="release-notes-markdown" />
          </div>
        </DialogBody>
        <DialogFooter className="border-t border-border/50 bg-background/95 min-[821px]:justify-between">
          {announcement.releaseUrl ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void openUrl(announcement.releaseUrl || "")}
            >
              <ExternalLink className="size-3.5" />
              {t("appUpdate.announcementOpenRelease")}
            </Button>
          ) : null}
          <DialogActions>
            {controller.preview ? (
              <Button type="button" size="sm" onClick={controller.dismissForNow}>
                {t("appUpdate.announcementClosePreview")}
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={controller.dismissForNow}
                >
                  {t("appUpdate.announcementLater")}
                </Button>
                <Button type="button" size="sm" onClick={controller.acknowledge}>
                  {t("appUpdate.announcementAcknowledge")}
                </Button>
              </>
            )}
          </DialogActions>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
