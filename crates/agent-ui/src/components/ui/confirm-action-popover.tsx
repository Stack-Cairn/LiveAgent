import { AlertTriangle } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { ReactNode } from "react";
import { Button } from "./button";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "./popover";

export function ConfirmActionPopover(props: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  // Popover edge to align with the trigger; "end" suits right-aligned action
  // rows (settings lists), "start" left-aligned ones (assistant reply row).
  align?: "start" | "end";
  // Preferred trigger side to open from; the positioner flips on collision.
  side?: "top" | "bottom";
  // Visual intent: "destructive" (default) for irreversible actions,
  // "default" for non-destructive confirmations (e.g. branching).
  tone?: "destructive" | "default";
  // Controlled mode (both or neither): callers that gate opening on extra
  // state (e.g. the usage ring's two-tap touch flow) own the open state.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: (open: () => void) => ReactNode;
}) {
  const {
    title,
    description,
    confirmLabel,
    onConfirm,
    align = "end",
    side = "bottom",
    tone = "destructive",
    open,
    onOpenChange,
    children,
  } = props;
  const { t } = useLocale();

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange ? (nextOpen) => onOpenChange(nextOpen) : undefined}
    >
      {/* Pass no-op — Popover.Trigger merges its own click handler via render prop */}
      <PopoverTrigger render={children(() => {}) as React.ReactElement} />
      <PopoverContent
        side={side}
        align={align}
        sideOffset={6}
        className="confirm-action-popover-popup w-64 p-0"
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="p-3">
          <div className="flex items-start gap-2.5">
            <div
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                tone === "destructive" ? "bg-destructive/10" : "bg-primary/10"
              }`}
            >
              <AlertTriangle
                className={`h-4 w-4 ${tone === "destructive" ? "text-destructive" : "text-primary"}`}
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{title}</p>
              <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {description}
              </div>
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <PopoverClose
              render={
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  onClick={(event) => event.stopPropagation()}
                />
              }
            >
              {t("settings.cancel")}
            </PopoverClose>
            <PopoverClose
              render={
                <Button
                  variant={tone === "destructive" ? "destructive" : "default"}
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  onClick={(event) => {
                    event.stopPropagation();
                    onConfirm();
                  }}
                />
              }
            >
              {confirmLabel}
            </PopoverClose>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ConfirmDeletePopover(props: {
  name: string;
  onConfirm: () => void;
  children: (open: () => void) => ReactNode;
}) {
  const { t } = useLocale();

  return (
    <ConfirmActionPopover
      title={t("settings.deleteConfirm")}
      description={
        <>
          {t("settings.deleteConfirmYes")}{" "}
          <span className="font-medium text-foreground">{props.name}</span>？
          {t("settings.deleteConfirmDesc")}
        </>
      }
      confirmLabel={t("settings.delete")}
      onConfirm={props.onConfirm}
    >
      {props.children}
    </ConfirmActionPopover>
  );
}
