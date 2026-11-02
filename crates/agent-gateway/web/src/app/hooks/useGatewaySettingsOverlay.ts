import { useSettingsOverlay } from "@liveagent/ui/lib/settings/useSettingsOverlay";
import { type Dispatch, type SetStateAction, useCallback, useRef, useState } from "react";

import type { SectionId } from "@/pages/settings/types";

import { isMobileSidebarLayout } from "../historyUtils";

export function useGatewaySettingsOverlay(setSidebarOpen: Dispatch<SetStateAction<boolean>>) {
  const {
    settingsOpen,
    overlay,
    openSettingsOverlay,
    closeSettingsOverlay,
    handleSettingsOverlayTransitionEnd,
    resetSettingsOverlay,
  } = useSettingsOverlay();
  const [settingsSection, setSettingsSection] = useState<SectionId>("system");
  const [settingsProviderId, setSettingsProviderId] = useState<string>();
  const leaveGuard = useRef<(() => boolean) | undefined>(undefined);
  const registerSettingsLeaveGuard = useCallback((guard: () => boolean) => {
    leaveGuard.current = guard;
    return () => {
      if (leaveGuard.current === guard) leaveGuard.current = undefined;
    };
  }, []);
  const closeSettings = useCallback(() => {
    if (leaveGuard.current && !leaveGuard.current()) return;
    closeSettingsOverlay();
  }, [closeSettingsOverlay]);

  const openSettings = useCallback(
    (section: SectionId = "system", providerId?: string) => {
      if (isMobileSidebarLayout()) setSidebarOpen(false);
      setSettingsSection(section);
      setSettingsProviderId(section === "providers" ? providerId : undefined);
      openSettingsOverlay();
    },
    [openSettingsOverlay, setSidebarOpen],
  );

  return {
    settingsOpen,
    overlay,
    openSettings,
    closeSettings,
    registerSettingsLeaveGuard,
    handleSettingsTransitionEnd: handleSettingsOverlayTransitionEnd,
    resetSettingsOverlay,
    settingsSection,
    settingsProviderId,
  };
}
