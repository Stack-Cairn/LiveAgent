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
  /**
   * "destructive" (default) paints the confirm button red; "default" is for
   * confirmations that do not delete or discard anything irreversible.
   */
  tone?: "destructive" | "default";
  /**
   * A second, broader confirmation (e.g. "Allow for this session") shown between cancel
   * and confirm; only `choose` reports it separately, `confirm` treats it as confirmed.
   */
  secondaryConfirmLabel?: string;
};

export type ConfirmDialogChoice = "confirm" | "secondary" | "cancel";

type PendingConfirmDialog = ConfirmDialogOptions & {
  resolve: (choice: ConfirmDialogChoice) => void;
};

function ConfirmDialog(
  props: ConfirmDialogOptions & {
    onCancel: () => void;
    onConfirm: () => void;
    onSecondaryConfirm: () => void;
  },
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
    tone = "destructive",
    secondaryConfirmLabel,
    onCancel,
    onConfirm,
    onSecondaryConfirm,
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
                <div
                  className={cn(
                    "break-all rounded-md bg-muted/50 px-2.5 py-1.5",
                    "font-mono text-xs leading-5 text-muted-foreground",
                  )}
                >
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
                    data-confirm-dialog-action="cancel"
                  />
                }
              >
                {cancelLabel}
              </AlertDialogClose>
            )}
            {secondaryConfirmLabel ? (
              <Button
                type="button"
                variant="outline"
                className="h-8"
                onClick={onSecondaryConfirm}
                data-confirm-dialog-action="secondary"
              >
                {secondaryConfirmLabel}
              </Button>
            ) : null}
            <Button
              type="button"
              variant={preferCancel ? "ghost" : tone === "default" ? "default" : "destructive"}
              onClick={onConfirm}
              // Without a cancel button the only action takes focus; otherwise
              // focus starts on the safe choice so Enter never confirms by accident.
              autoFocus={hideCancel}
              data-confirm-dialog-action="confirm"
              data-tone={tone}
              className={cn(
                "h-8",
                preferCancel &&
                  tone === "destructive" &&
                  "text-destructive hover:bg-destructive/10 hover:text-destructive",
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

  const close = useCallback((choice: ConfirmDialogChoice) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(choice);
  }, []);

  const choose = useCallback((options: ConfirmDialogOptions) => {
    return new Promise<ConfirmDialogChoice>((resolve) => {
      pendingRef.current?.resolve("cancel");
      const next = { ...options, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  const confirm = useCallback(
    async (options: ConfirmDialogOptions) => (await choose(options)) !== "cancel",
    [choose],
  );

  useEffect(() => {
    return () => {
      pendingRef.current?.resolve("cancel");
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
      tone={pending.tone}
      secondaryConfirmLabel={pending.secondaryConfirmLabel}
      onCancel={() => close("cancel")}
      onConfirm={() => close("confirm")}
      onSecondaryConfirm={() => close("secondary")}
    />
  ) : null;

  return { confirm, choose, dialog };
}
