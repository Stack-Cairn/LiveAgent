import type { ReactNode } from "react";
import { createToastManager } from "./toast";

export type ToastPosition = "top-right" | "bottom-right" | "bottom-center";
export type ToastTone = "success" | "warning" | "error";
export type ToastOptions = {
  id?: string;
  position?: ToastPosition;
  description?: ReactNode;
  /** Zero keeps a result visible until dismissed. */
  duration?: number;
  appearance?: "notification" | "notice";
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
};
export type ToastData = {
  appearance: "notification" | "notice";
  action?: ToastOptions["action"];
};
export const appToastManagers = {
  "top-right": createToastManager<ToastData>(),
  "bottom-right": createToastManager<ToastData>(),
  "bottom-center": createToastManager<ToastData>(),
};
const positionsById = new Map<string, ToastPosition>();

type Entry = Parameters<(typeof appToastManagers)[ToastPosition]["add"]>[0];
const pending = new Map<string, Entry>();
let mounted = false;
let sequence = 0;

/** Called only by the root Toaster, after its Provider subscribes. */
export function connectAppToaster() {
  mounted = true;
  for (const [id, entry] of pending)
    appToastManagers[positionsById.get(id) ?? "top-right"].add(entry);
  pending.clear();
  return () => {
    mounted = false;
  };
}

function show(type: ToastTone, message: string, options: ToastOptions = {}) {
  const id = options.id ?? `app-toast-${++sequence}`;
  const previousPosition = positionsById.get(id);
  const position = options.position ?? previousPosition ?? "top-right";
  positionsById.set(id, position);
  if (mounted && previousPosition && previousPosition !== position) {
    appToastManagers[previousPosition].close(id);
  }
  const appearance = options.appearance ?? "notification";
  const entry: Entry = {
    id,
    type,
    title: options.description !== undefined ? message : undefined,
    description: options.description ?? message,
    priority: type === "error" ? "high" : "low",
    timeout: options.duration ?? 5000,
    onClose: () => {
      // Moving a live ID between positions must not dismiss the new notification.
      if (positionsById.get(id) !== position) return;
      positionsById.delete(id);
      options.onDismiss?.();
    },
    data: { appearance, action: options.action },
  };
  if (mounted) appToastManagers[position].add(entry);
  else pending.set(id, entry);
  return id;
}

export const toast = {
  success: (message: string, options?: ToastOptions) => show("success", message, options),
  warning: (message: string, options?: ToastOptions) => show("warning", message, options),
  error: (message: string, options?: ToastOptions) => show("error", message, options),
  dismiss(id?: string) {
    if (id === undefined) {
      for (const pendingId of pending.keys()) positionsById.delete(pendingId);
      pending.clear();
      if (mounted) for (const manager of Object.values(appToastManagers)) manager.close();
    } else {
      pending.delete(id);
      const position = positionsById.get(id);
      if (mounted && position) appToastManagers[position].close(id);
      positionsById.delete(id);
    }
  },
};
