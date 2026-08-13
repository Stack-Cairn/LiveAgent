import { useCallback } from "react";
import { useRemotePathPicker } from "../components/RemotePathPickerModal";

export function useDirectoryPicker() {
  const { pickPath, pathPickerElement } = useRemotePathPicker();
  const pickDirectory = useCallback(
    async (initialPath: string): Promise<string | null> =>
      await pickPath({ mode: "directory", initialPath }),
    [pickPath],
  );
  return {
    pickDirectory,
    directoryPickerElement: pathPickerElement,
  };
}
