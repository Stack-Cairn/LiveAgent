import { AlertTriangle, CheckCircle2, X, XCircle } from "@liveagent/app/components/icons";
import { memo, useEffect, useRef } from "react";

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
  if (items.length === 0) return null;

  return (
    <div className="absolute top-full right-4 z-50 flex flex-col gap-2 pt-2 pointer-events-none">
      {items.map((item) => (
        <ToastEntry key={item.id} item={item} onDismiss={onDismiss} />
      ))}
    </div>
  );
});

const ToastEntry = memo(function ToastEntry(props: {
  item: NotifyItem;
  onDismiss: (id: string) => void;
}) {
  const { item, onDismiss } = props;
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      const el = elRef.current;
      if (el) {
        el.classList.add("notify-toast-exit");
        const onEnd = () => onDismiss(item.id);
        el.addEventListener("animationend", onEnd, { once: true });
        // fallback in case animationend doesn't fire
        setTimeout(onEnd, 400);
      } else {
        onDismiss(item.id);
      }
    }, 5000);
    return () => clearTimeout(timer);
  }, [item.id, onDismiss]);

  const isWarning = item.type === "warning";
  const isSuccess = item.type === "success";

  return (
    <div
      ref={elRef}
      className={`notify-toast-enter pointer-events-auto flex w-72 items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm shadow-lg backdrop-blur-xl ${
        isWarning
          ? "border-amber-500/30 bg-amber-50/95 dark:bg-amber-950/80 dark:border-amber-500/25"
          : isSuccess
            ? "border-emerald-500/30 bg-emerald-50/95 dark:bg-emerald-950/80 dark:border-emerald-500/25"
            : "border-red-500/30 bg-red-50/95 dark:bg-red-950/80 dark:border-red-500/25"
      }`}
    >
      {isWarning ? (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      ) : isSuccess ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
      )}
      <p
        className={`min-w-0 flex-1 leading-relaxed ${
          isWarning
            ? "text-amber-800 dark:text-amber-200"
            : isSuccess
              ? "text-emerald-800 dark:text-emerald-200"
              : "text-red-800 dark:text-red-200"
        }`}
      >
        {item.message}
      </p>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        className="mt-0.5 shrink-0 rounded p-0.5 opacity-50 hover:opacity-100 transition-opacity"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
});
