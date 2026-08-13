import {
  type AppSettings,
  getRightDockFileTreeState,
  getRightDockProjectState,
  getSshProjectHostIds,
  isRightDockSingletonTabOpen,
  type RightDockFileTreeStatePatch,
  type RightDockProjectState,
  updateChatTranscriptWidth,
  updateRightDockFileTreeState,
  updateRightDockProjectState,
  updateRightDockWidth,
  updateSshProjectHostIds,
} from "@liveagent/app/lib/settings";
import { useCallback, useMemo } from "react";

type UseRightDockSettingsParams = {
  settings: AppSettings;
  setSettings: (updater: (previousSettings: AppSettings) => AppSettings) => void;
  terminalProjectPathKey: string;
};

export function useRightDockSettings(params: UseRightDockSettingsParams) {
  const { settings, setSettings, terminalProjectPathKey } = params;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the persisted right-dock slice is read, so unrelated custom settings keep memoized references stable.
  const rightDockProjectState = useMemo(
    () => getRightDockProjectState(settings.customSettings, terminalProjectPathKey),
    [settings.customSettings.rightDock, terminalProjectPathKey],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the persisted right-dock slice is read, so unrelated custom settings keep memoized references stable.
  const rightDockFileTreeState = useMemo(
    () => getRightDockFileTreeState(settings.customSettings, terminalProjectPathKey),
    [settings.customSettings.rightDock, terminalProjectPathKey],
  );
  const rightDockFileTreeOpen = isRightDockSingletonTabOpen(
    settings.customSettings,
    terminalProjectPathKey,
    "fileTree",
  );
  const associatedSshHostIds = useMemo(
    () => getSshProjectHostIds(settings.ssh, terminalProjectPathKey),
    [settings.ssh, terminalProjectPathKey],
  );
  const handleChatTranscriptWidthChange = useCallback(
    (nextWidth: number) => {
      setSettings((previousSettings) => updateChatTranscriptWidth(previousSettings, nextWidth));
    },
    [setSettings],
  );
  const handleRightDockWidthChange = useCallback(
    (nextWidth: number) => {
      setSettings((previousSettings) => updateRightDockWidth(previousSettings, nextWidth));
    },
    [setSettings],
  );
  const handleRightDockProjectStateChange = useCallback(
    (updater: (current: RightDockProjectState) => RightDockProjectState) => {
      setSettings((previousSettings) =>
        updateRightDockProjectState(previousSettings, terminalProjectPathKey, updater),
      );
    },
    [setSettings, terminalProjectPathKey],
  );
  const handleRightDockFileTreeStateChange = useCallback(
    (patch: RightDockFileTreeStatePatch) => {
      setSettings((previousSettings) =>
        updateRightDockFileTreeState(previousSettings, terminalProjectPathKey, patch),
      );
    },
    [setSettings, terminalProjectPathKey],
  );
  const handleSshProjectHostIdsChange = useCallback(
    (hostIds: string[]) => {
      setSettings((previousSettings) =>
        updateSshProjectHostIds(previousSettings, terminalProjectPathKey, hostIds),
      );
    },
    [setSettings, terminalProjectPathKey],
  );

  return {
    rightDockProjectState,
    rightDockFileTreeState,
    rightDockFileTreeOpen,
    associatedSshHostIds,
    handleChatTranscriptWidthChange,
    handleRightDockWidthChange,
    handleRightDockProjectStateChange,
    handleRightDockFileTreeStateChange,
    handleSshProjectHostIdsChange,
  };
}
