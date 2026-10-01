import { Toast as ToastPrimitive } from "@base-ui/react/toast";

// Base UI primitives are imported only through this shared boundary.
export const ToastProvider = ToastPrimitive.Provider;
export const ToastViewport = ToastPrimitive.Viewport;
export const ToastRoot = ToastPrimitive.Root;
export const ToastTitle = ToastPrimitive.Title;
export const ToastDescription = ToastPrimitive.Description;
export const ToastClose = ToastPrimitive.Close;
export const ToastAction = ToastPrimitive.Action;
export const useToastManager = ToastPrimitive.useToastManager;
export const createToastManager = ToastPrimitive.createToastManager;

export type ToastObject<Data extends object> = ToastPrimitive.Root.ToastObject<Data>;

export const ToastPortal = ToastPrimitive.Portal;
