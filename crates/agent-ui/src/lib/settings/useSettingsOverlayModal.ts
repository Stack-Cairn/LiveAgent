import { useCallback, useEffect, useRef } from "react";

/**
 * Applies modal semantics to an open overlay element: role=dialog + aria-modal
 * with a label, `inert` on its sibling elements (the chat behind it), focus
 * moved inside on open and handed back to the previously focused control on
 * close. Returns `close`, which undoes all of it.
 */
export function applySettingsOverlayModal(overlay: HTMLElement, label: string): () => void {
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", label);
  if (!overlay.hasAttribute("tabindex")) overlay.tabIndex = -1;

  const ownerDocument = overlay.ownerDocument;
  const previousFocus = ownerDocument.activeElement as HTMLElement | null;
  const inerted: Element[] = [];
  for (const sibling of Array.from(overlay.parentElement?.children ?? [])) {
    if (sibling === overlay || sibling.hasAttribute("inert")) continue;
    sibling.setAttribute("inert", "");
    inerted.push(sibling);
  }
  if (!overlay.contains(ownerDocument.activeElement)) overlay.focus({ preventScroll: true });

  return () => {
    for (const element of inerted) element.removeAttribute("inert");
    // React detaches the ref before removing the overlay, so focus that is still
    // inside it is about to be lost as well.
    const active = ownerDocument.activeElement;
    const focusLost =
      !active || active === ownerDocument.body || !active.isConnected || overlay.contains(active);
    if (focusLost && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  };
}

/** Ref callback for the settings overlay element; see `applySettingsOverlayModal`. */
export function useSettingsOverlayModal(label: string) {
  const overlayRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<(() => void) | null>(null);
  const labelRef = useRef(label);
  labelRef.current = label;

  // The settings page can switch the interface language while it is open.
  useEffect(() => {
    overlayRef.current?.setAttribute("aria-label", label);
  }, [label]);
  useEffect(() => () => closeRef.current?.(), []);

  return useCallback((overlay: HTMLElement | null) => {
    closeRef.current?.();
    closeRef.current = null;
    overlayRef.current = overlay;
    if (overlay) closeRef.current = applySettingsOverlayModal(overlay, labelRef.current);
  }, []);
}
