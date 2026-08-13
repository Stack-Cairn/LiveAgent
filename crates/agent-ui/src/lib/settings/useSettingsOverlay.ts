import { useCallback, useState } from "react";

export type SettingsOverlayState = "closed" | "entering" | "open" | "leaving";

export function useSettingsOverlay() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [overlay, setOverlay] = useState<SettingsOverlayState>("closed");

  const openSettingsOverlay = useCallback(() => {
    setSettingsOpen(true);
    setOverlay("entering");
    requestAnimationFrame(() => requestAnimationFrame(() => setOverlay("open")));
  }, []);
  const closeSettingsOverlay = useCallback(() => {
    setOverlay("leaving");
  }, []);
  const handleSettingsOverlayTransitionEnd = useCallback(() => {
    if (overlay === "leaving") {
      setSettingsOpen(false);
      setOverlay("closed");
    }
  }, [overlay]);
  const resetSettingsOverlay = useCallback(() => {
    setSettingsOpen(false);
    setOverlay("closed");
  }, []);

  return {
    settingsOpen,
    overlay,
    openSettingsOverlay,
    closeSettingsOverlay,
    handleSettingsOverlayTransitionEnd,
    resetSettingsOverlay,
  };
}
