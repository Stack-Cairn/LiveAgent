import { AlertTriangle, CheckCircle2, X, XCircle } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { UI_MOTION_TRANSITION } from "@liveagent/ui/lib/shared/motion";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { AnimatePresence, domAnimation, LazyMotion, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { memo, useEffect } from "react";

export type NotifyItem = {
  id: string;
  type: "warning" | "error" | "success";
  message: string;
};

export const NotifyToast = memo(function NotifyToast(props: {
  items: NotifyItem[];
  onDismiss: (id: string) => void;
}) {
  const { items, onDismiss } = props;

  return (
    <div
      className={cn(
        "absolute top-full right-4 z-50 flex flex-col gap-2 pt-2",
        "pointer-events-none",
      )}
    >
      <LazyMotion features={domAnimation} strict>
        <AnimatePresence>
          {items.map((item) => (
            <ToastEntry key={item.id} item={item} onDismiss={onDismiss} />
          ))}
        </AnimatePresence>
      </LazyMotion>
    </div>
  );
});

const ToastEntry = memo(function ToastEntry(props: {
  item: NotifyItem;
  onDismiss: (id: string) => void;
}) {
  const { item, onDismiss } = props;
  const { t } = useLocale();
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    const timer = setTimeout(() => onDismiss(item.id), 5000);
    return () => clearTimeout(timer);
  }, [item.id, onDismiss]);

  const isWarning = item.type === "warning";
  const isSuccess = item.type === "success";
  const enterTransition = prefersReducedMotion
    ? UI_MOTION_TRANSITION.instant
    : UI_MOTION_TRANSITION.feedback;
  const exitTransition = prefersReducedMotion
    ? UI_MOTION_TRANSITION.instant
    : UI_MOTION_TRANSITION.feedbackExit;

  return (
    <m.div
      initial={{ opacity: 0, x: prefersReducedMotion ? 0 : 20 }}
      animate={{ opacity: 1, x: 0, transition: enterTransition }}
      exit={{ opacity: 0, x: prefersReducedMotion ? 0 : 20, transition: exitTransition }}
      role={item.type === "error" ? "alert" : "status"}
      aria-live={item.type === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      className={cn(
        "pointer-events-auto flex w-notification items-start gap-2.5 rounded-lg border",
        "px-3 py-2.5 text-sm shadow-lg backdrop-blur-xl",
        isWarning
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
      <p
        className={cn(
          "min-w-0 flex-1 whitespace-pre-wrap break-words leading-relaxed",
          isWarning
            ? "text-amber-800 dark:text-amber-200"
            : isSuccess
              ? "text-emerald-800 dark:text-emerald-200"
              : "text-red-800 dark:text-red-200",
        )}
      >
        {item.message}
      </p>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        aria-label={t("common.dismissNotification")}
        className={cn(
          "mt-0.5 shrink-0 rounded p-0.5 opacity-50 transition-opacity",
          "hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-offset-1 focus-visible:ring-offset-transparent",
        )}
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </m.div>
  );
});
