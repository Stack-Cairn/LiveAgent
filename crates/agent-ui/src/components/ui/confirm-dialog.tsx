import { cn } from "@liveagent/ui/lib/shared/utils";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogActions,
  AlertDialogBody,
  AlertDialogClose,
  AlertDialogCloseButton,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";
import { Button } from "./button";

export type ConfirmDialogOptions = {
  title: ReactNode;
  subtitle?: ReactNode;
  description?: ReactNode;
  detail?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  closeLabel?: string;
  hideCancel?: boolean;
  /** Give the safe cancel action primary emphasis and render confirmation as destructive text. */
  preferCancel?: boolean;
};

type PendingConfirmDialog = ConfirmDialogOptions & {
  resolve: (confirmed: boolean) => void;
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
    hideCancel = false,
    preferCancel = false,
    onCancel,
    onConfirm,
  } = props;

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader className="pr-14">
          <AlertDialogTitle className="break-words">{title}</AlertDialogTitle>
          {subtitle ? (
            <div className="break-words text-xs leading-relaxed text-muted-foreground">
              {subtitle}
            </div>
          ) : null}
          <AlertDialogCloseButton
            label={closeLabel}
            className="absolute right-4 top-4 z-10 text-muted-foreground hover:text-foreground"
          />
        </AlertDialogHeader>

        {description || detail ? (
          <AlertDialogBody>
            <AlertDialogDescription className="space-y-2.5" render={<div />}>
              {description ? (
                <div className="text-sm leading-relaxed text-foreground">{description}</div>
              ) : null}
              {detail ? (
                <div className="break-all rounded-md bg-muted/50 px-2.5 py-1.5 font-mono text-[calc(12px*var(--zone-font-scale,1))] leading-5 text-muted-foreground">
                  {detail}
                </div>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogBody>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogActions>
            {hideCancel ? null : (
              <AlertDialogClose
                render={
                  <Button
                    type="button"
                    variant={preferCancel ? "default" : "outline"}
                    className="h-8"
                    autoFocus
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
              className={cn(
                "h-8",
                preferCancel && "text-destructive hover:bg-destructive/10 hover:text-destructive",
              )}
            >
              {confirmLabel}
            </Button>
          </AlertDialogActions>
        </AlertDialogFooter>
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
      hideCancel={pending.hideCancel}
      preferCancel={pending.preferCancel}
      onCancel={() => close(false)}
      onConfirm={() => close(true)}
    />
  ) : null;

  return { confirm, dialog };
}
