import { useState } from "react";
import type { ApplicationViewId } from "./ApplicationView";

export function useApplicationViewState<TResourceProject>() {
  const [activeView, setActiveView] = useState<ApplicationViewId>("chat");
  const [projectSettingsProject, setProjectSettingsProject] = useState<TResourceProject | null>(
    null,
  );
  const [rightDockOpen, setRightDockOpen] = useState(false);

  return {
    activeView,
    setActiveView,
    projectSettingsProject,
    setProjectSettingsProject,
    rightDockOpen,
    setRightDockOpen,
  };
}
