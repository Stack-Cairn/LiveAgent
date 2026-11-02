import { AlertTriangle, Trash2 } from "@liveagent/ui/components/IconSet";
import {
  AlertDialog,
  AlertDialogActions,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@liveagent/ui/components/ui/alert-dialog";
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
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useEffect, useMemo, useState } from "react";
import { type MemoryQuotaSummaryResponse, memoryQuotaSummary } from "../../../lib/memory/api";
import { deriveQuotaLadder } from "../../../lib/memory/organizer/quota";
import { BackendMemoryOrganizer } from "./BackendMemoryOrganizer";
import { memoryScopeLabel } from "./panelModel";

export function MemorySettingsDrawer(props: {
  storagePath?: string;
  workdir?: string;
  saving: boolean;
  t: (key: string) => string;
  onClose: () => void;
  onRequestWipe: () => void | Promise<void>;
  backendManaged?: boolean;
  kbrain?: boolean;
}) {
  const { workdir, saving, t, onClose, onRequestWipe, backendManaged = false } = props;
  const [drawerWipeConfirmOpen, setDrawerWipeConfirmOpen] = useState(false);
  const [quotaSummary, setQuotaSummary] = useState<MemoryQuotaSummaryResponse | null>(null);
  const quotaLadder = useMemo(() => deriveQuotaLadder(quotaSummary), [quotaSummary]);

  useEffect(() => {
    if (backendManaged) return;
    let cancelled = false;
    void memoryQuotaSummary({ workdir })
      .then((summary) => {
        if (!cancelled) setQuotaSummary(summary);
      })
      .catch(() => {
        // The banner is best-effort; a failed summary just renders nothing.
      });
    return () => {
      cancelled = true;
    };
  }, [backendManaged, workdir]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex h-[min(46rem,calc(100dvh-2rem))] max-w-xl flex-col p-0"
        closeLabel={t("settings.memorySettingsClose")}
        layout="fullscreen-mobile"
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle>{t("settings.memorySettingsTitle")}</DialogTitle>
          <DialogDescription>{t("settings.memoryBackendOwned")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="divide-y divide-foreground/[0.08]">
            {quotaLadder.level !== "normal" &&
            quotaLadder.bannerKey &&
            quotaLadder.tightestScope ? (
              <div
                className={cn(
                  "flex items-start gap-2 rounded-2xl border px-4 py-3",
                  "text-xs leading-relaxed",
                  quotaLadder.level === "critical" || quotaLadder.level === "exhausted"
                    ? "border-red-500/25 bg-red-500/[0.06] text-red-700 dark:text-red-300"
                    : "border-amber-500/25 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300",
                )}
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {t(quotaLadder.bannerKey)
                    .replace("{scope}", memoryScopeLabel(quotaLadder.tightestScope.scope, t))
                    .replace("{used}", String(quotaLadder.tightestScope.used))
                    .replace("{limit}", String(quotaLadder.tightestScope.limit))}
                </span>
              </div>
            ) : null}

            {props.kbrain && !backendManaged ? (
              <BackendMemoryOrganizer workdir={workdir} t={t} />
            ) : (
              <section className="py-5">
                <p className="text-sm text-muted-foreground" role="status">
                  {t("settings.memoryOrganizerUnsupported")}
                </p>
              </section>
            )}

            <div className="py-4 break-all font-mono text-xs text-muted-foreground">
              {props.storagePath}
            </div>
            <section className="py-5 last:pb-0">
              <div className="mb-3 flex items-center gap-1.5 text-xs font-medium text-destructive/80">
                <AlertTriangle className="size-3" />
                {t("settings.memorySettingsDangerZone")}
              </div>
              <div className="rounded-lg border border-destructive/20 bg-destructive/[0.04] p-4">
                <div className="text-xs leading-relaxed text-muted-foreground">
                  {t("settings.memorySettingsWipeDescription")}
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  className="mt-3 w-full"
                  onClick={() => setDrawerWipeConfirmOpen(true)}
                  disabled={backendManaged || saving}
                >
                  <Trash2 className="size-3.5" />
                  {t("settings.memoryWipeAll")}
                </Button>
              </div>
            </section>
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogActions>
            <Button size="sm" onClick={onClose}>
              {t("settings.close")}
            </Button>
          </DialogActions>
        </DialogFooter>
      </DialogContent>
      {drawerWipeConfirmOpen ? (
        <AlertDialog open onOpenChange={setDrawerWipeConfirmOpen}>
          <AlertDialogContent className="max-w-md p-0">
            <AlertDialogHeader className="flex-row items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
                <AlertTriangle className="size-4 text-destructive" />
              </div>
              <div className="min-w-0 flex-1">
                <AlertDialogTitle className="text-sm">
                  {t("settings.memoryWipeConfirmTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription className="mt-1 text-xs leading-relaxed">
                  {t("settings.memoryWipeConfirmDescription")}
                </AlertDialogDescription>
              </div>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogActions>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDrawerWipeConfirmOpen(false)}
                  disabled={saving}
                >
                  {t("settings.memoryCancel")}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    setDrawerWipeConfirmOpen(false);
                    void onRequestWipe();
                  }}
                  disabled={backendManaged || saving}
                >
                  {t("settings.memoryWipeAll")}
                </Button>
              </AlertDialogActions>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </Dialog>
  );
}
