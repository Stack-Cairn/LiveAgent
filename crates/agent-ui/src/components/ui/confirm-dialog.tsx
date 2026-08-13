import { AlertTriangle, X } from "@liveagent/ui/components/IconSet";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "./alert-dialog";
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
  hideCancel?: boolean;
  /** Give the safe cancel action primary emphasis and render confirmation as destructive text. */
  preferCancel?: boolean;
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
    hideCancel = false,
    preferCancel = false,
    onCancel,
    onConfirm,
  } = props;
  const toneClasses = toneClassNames[tone];

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent className="max-w-md">
        <div className="flex items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border ${toneClasses.icon}`}
            >
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <AlertDialogTitle className="break-words text-base leading-normal">
                {title}
              </AlertDialogTitle>
              {subtitle ? (
                <div className="mt-1 break-words text-xs leading-5 text-muted-foreground">
                  {subtitle}
                </div>
              ) : null}
            </div>
          </div>

          <AlertDialogClose
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
          </AlertDialogClose>
        </div>

        {description || detail ? (
          <AlertDialogDescription className="space-y-3 px-5 py-5" render={<div />}>
            {description ? (
              <div className={`rounded-xl border px-4 py-3 text-sm leading-6 ${toneClasses.panel}`}>
                {description}
              </div>
            ) : null}
            {detail ? (
              <div className="break-words rounded-xl border border-border/60 bg-muted/25 px-3 py-2 text-xs leading-5 text-muted-foreground">
                {detail}
              </div>
            ) : null}
          </AlertDialogDescription>
        ) : null}

        <div className="flex flex-col-reverse gap-2 border-t border-border/60 bg-muted/20 px-5 py-4 sm:flex-row sm:justify-end">
          {hideCancel ? null : (
            <AlertDialogClose
              render={
                <Button
                  type="button"
                  variant={preferCancel ? "default" : "outline"}
                  autoFocus
                  className="w-full sm:w-auto"
                />
              }
            >
              {cancelLabel}
            </AlertDialogClose>
          )}
          <Button
            type="button"
            variant={preferCancel ? "ghost" : "destructive"}
            onClick={onConfirm}
            className={`w-full sm:w-auto ${
              preferCancel ? "text-destructive hover:bg-destructive/10 hover:text-destructive" : ""
            }`}
          >
            {confirmLabel}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
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
      hideCancel={pending.hideCancel}
      preferCancel={pending.preferCancel}
      onCancel={() => close(false)}
      onConfirm={() => close(true)}
    />
  ) : null;

  return { confirm, dialog };
}
