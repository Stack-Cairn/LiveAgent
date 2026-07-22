import { AlertDialog } from "@base-ui/react/alert-dialog";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, X } from "../icons";
import { Button } from "./button";

type ConfirmDialogTone = "warning" | "destructive";

export type ConfirmDialogOptions = {
  title: ReactNode;
  subtitle?: ReactNode;
  description?: ReactNode;
  detail?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  closeLabel?: string;
  tone?: ConfirmDialogTone;
};

type PendingConfirmDialog = ConfirmDialogOptions & {
  resolve: (confirmed: boolean) => void;
};

const toneClassNames: Record<
  ConfirmDialogTone,
  {
    icon: string;
    panel: string;
  }
> = {
  warning: {
    icon: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    panel: "border-amber-500/20 bg-amber-500/10",
  },
  destructive: {
    icon: "border-destructive/25 bg-destructive/10 text-destructive",
    panel: "border-destructive/20 bg-destructive/10",
  },
};

function ConfirmDialog(
  props: ConfirmDialogOptions & { onCancel: () => void; onConfirm: () => void },
) {
  const {
    title,
    subtitle,
    description,
    detail,
    confirmLabel,
    cancelLabel,
    closeLabel = cancelLabel,
    tone = "destructive",
    onCancel,
    onConfirm,
  } = props;
  const toneClasses = toneClassNames[tone];

  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-[120] bg-black/55 backdrop-blur-sm" />
        <AlertDialog.Viewport className="fixed inset-0 z-[120] flex items-center justify-center p-4">
          <AlertDialog.Popup className="relative w-full max-w-md overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl outline-none">
            <div className="flex items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
              <div className="flex min-w-0 items-start gap-3">
                <div
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border ${toneClasses.icon}`}
                >
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <AlertDialog.Title className="break-words text-base font-semibold text-foreground">
                    {title}
                  </AlertDialog.Title>
                  {subtitle ? (
                    <div className="mt-1 break-words text-xs leading-5 text-muted-foreground">
                      {subtitle}
                    </div>
                  ) : null}
                </div>
              </div>

              <AlertDialog.Close
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
                    title={closeLabel}
                    aria-label={closeLabel}
                  />
                }
              >
                <X className="h-4 w-4" />
              </AlertDialog.Close>
            </div>

            {description || detail ? (
              <AlertDialog.Description className="space-y-3 px-5 py-5" render={<div />}>
                {description ? (
                  <div
                    className={`rounded-xl border px-4 py-3 text-sm leading-6 ${toneClasses.panel}`}
                  >
                    {description}
                  </div>
                ) : null}
                {detail ? (
                  <div className="break-words rounded-xl border border-border/60 bg-muted/25 px-3 py-2 text-xs leading-5 text-muted-foreground">
                    {detail}
                  </div>
                ) : null}
              </AlertDialog.Description>
            ) : null}

            <div className="flex flex-col-reverse gap-2 border-t border-border/60 bg-muted/20 px-5 py-4 sm:flex-row sm:justify-end">
              <AlertDialog.Close
                render={
                  <Button type="button" variant="outline" autoFocus className="w-full sm:w-auto" />
                }
              >
                {cancelLabel}
              </AlertDialog.Close>
              <Button
                type="button"
                variant="destructive"
                onClick={onConfirm}
                className="w-full sm:w-auto"
              >
                {confirmLabel}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export function useConfirmDialog() {
  const [pending, setPending] = useState<PendingConfirmDialog | null>(null);
  const pendingRef = useRef<PendingConfirmDialog | null>(null);

  const close = useCallback((confirmed: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(confirmed);
  }, []);

  const confirm = useCallback((options: ConfirmDialogOptions) => {
    return new Promise<boolean>((resolve) => {
      pendingRef.current?.resolve(false);
      const next = { ...options, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  useEffect(() => {
    return () => {
      pendingRef.current?.resolve(false);
      pendingRef.current = null;
    };
  }, []);

  const dialog = pending ? (
    <ConfirmDialog
      title={pending.title}
      subtitle={pending.subtitle}
      description={pending.description}
      detail={pending.detail}
      confirmLabel={pending.confirmLabel}
      cancelLabel={pending.cancelLabel}
      closeLabel={pending.closeLabel}
      tone={pending.tone}
      onCancel={() => close(false)}
      onConfirm={() => close(true)}
    />
  ) : null;

  return { confirm, dialog };
}
