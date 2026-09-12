import { useReducedMotion } from "motion/react";
import { memo, useEffect } from "react";
import { useLocale } from "../../i18n/index";
import { UI_MOTION_TRANSITION } from "../../lib/shared/motion";
import { cn } from "../../lib/shared/utils";
import { AlertTriangle, CheckCircle2, X, XCircle } from "../IconSet";
import {
  ToastAction,
  ToastClose,
  ToastDescription,
  type ToastObject,
  ToastPortal,
  ToastProvider,
  ToastRoot,
  ToastTitle,
  ToastViewport,
  useToastManager,
} from "./toast";
import {
  appToastManagers,
  connectAppToaster,
  type ToastData,
  type ToastPosition,
  toast,
} from "./toast-manager";

const POSITION_CLASSES: Record<ToastPosition, string> = {
  "top-right": "right-4 top-4 items-end",
  "bottom-right": "bottom-5 right-4 items-end sm:right-6",
  "bottom-center":
    "bottom-4 left-1/2 -translate-x-1/2 items-center max-sm:bottom-safe-bottom-offset",
};

export function Toaster() {
  useEffect(connectAppToaster, []);
  return (
    <>
      {(Object.keys(appToastManagers) as ToastPosition[]).map((position) => (
        <ToastProvider
          key={position}
          toastManager={appToastManagers[position]}
          limit={Number.POSITIVE_INFINITY}
        >
          <ToastPortal>
            <ToastList position={position} />
          </ToastPortal>
        </ToastProvider>
      ))}
    </>
  );
}

function ToastList({ position }: { position: ToastPosition }) {
  const { toasts } = useToastManager<ToastData>();
  return (
    <ToastViewport
      data-toast-position={position}
      className={cn(
        "layer-toast pointer-events-none fixed flex max-h-[calc(100dvh-2rem)] flex-col gap-2 overflow-y-auto",
        POSITION_CLASSES[position],
      )}
    >
      {[...toasts].reverse().map((notification) => (
        <ToastEntry key={notification.id} toast={notification} />
      ))}
    </ToastViewport>
  );
}

const ToastEntry = memo(function ToastEntry(props: { toast: ToastObject<ToastData> }) {
  const { toast: notification } = props;
  const item = { type: notification.type, message: notification.description };
  const notice = notification.data?.appearance === "notice";
  const { t } = useLocale();
  const prefersReducedMotion = useReducedMotion();

  const isWarning = item.type === "warning";
  const isSuccess = item.type === "success";
  const enterTransition = prefersReducedMotion
    ? UI_MOTION_TRANSITION.instant
    : UI_MOTION_TRANSITION.feedback;
  const exitTransition = prefersReducedMotion
    ? UI_MOTION_TRANSITION.instant
    : UI_MOTION_TRANSITION.feedbackExit;

  const transition = notification.transitionStatus === "ending" ? exitTransition : enterTransition;

  return (
    <ToastRoot
      toast={notification}
      swipeDirection={[]}
      style={{
        transitionDuration: `${transition.duration}s`,
        transitionTimingFunction: prefersReducedMotion
          ? undefined
          : `cubic-bezier(${(notification.transitionStatus === "ending" ? UI_MOTION_TRANSITION.feedbackExit : UI_MOTION_TRANSITION.feedback).ease.join(",")})`,
      }}
      className={cn(
        "pointer-events-auto flex shrink-0 items-start gap-2.5 rounded-lg border",
        notice ? "w-96 max-w-[calc(100vw-2rem)]" : "w-notification",
        "px-3 py-2.5 text-sm",
        notice ? "bg-background" : "shadow-lg backdrop-blur-xl",
        "transition-[opacity,translate] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
        !prefersReducedMotion &&
          "data-[starting-style]:translate-x-5 data-[ending-style]:translate-x-5",
        notice
          ? isWarning
            ? "border-amber-500/30"
            : isSuccess
              ? "border-emerald-500/30"
              : "border-destructive/30"
          : isWarning
            ? "border-amber-500/30 bg-amber-50/95 dark:bg-amber-950/80 dark:border-amber-500/25"
            : isSuccess
              ? "border-emerald-500/30 bg-emerald-50/95 dark:bg-emerald-950/80 dark:border-emerald-500/25"
              : "border-red-500/30 bg-red-50/95 dark:bg-red-950/80 dark:border-red-500/25",
      )}
    >
      {isWarning ? (
        <AlertTriangle
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
        />
      ) : isSuccess ? (
        <CheckCircle2
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
        />
      ) : (
        <XCircle
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400"
        />
      )}
      <div className="min-w-0 flex-1">
        {notification.title ? (
          <ToastTitle className="font-medium text-foreground">{notification.title}</ToastTitle>
        ) : null}
        <ToastDescription
          className={cn(
            "whitespace-pre-wrap break-words leading-relaxed",
            notice
              ? notification.title
                ? "mt-0.5 max-h-40 overflow-y-auto text-xs text-muted-foreground"
                : "text-foreground"
              : isWarning
                ? "text-amber-800 dark:text-amber-200"
                : isSuccess
                  ? "text-emerald-800 dark:text-emerald-200"
                  : "text-red-800 dark:text-red-200",
          )}
        />
        {notification.data?.action ? (
          <ToastAction
            className="mt-2 rounded-md border border-border bg-secondary px-2.5 py-1 text-xs text-secondary-foreground"
            onClick={() => {
              notification.data?.action?.onClick();
              toast.dismiss(notification.id);
            }}
          >
            {notification.data.action.label}
          </ToastAction>
        ) : null}
      </div>
      <ToastClose
        type="button"
        aria-label={t("common.dismissNotification")}
        className={cn(
          "mt-0.5 shrink-0 rounded p-0.5 opacity-50 transition-opacity",
          "hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-offset-1 focus-visible:ring-offset-transparent",
        )}
      >
        <X aria-hidden="true" className="size-3.5" />
      </ToastClose>
    </ToastRoot>
  );
});
