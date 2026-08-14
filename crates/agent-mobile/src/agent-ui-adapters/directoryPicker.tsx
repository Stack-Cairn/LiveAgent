import { useRemotePathPicker } from "../components/RemotePathPickerModal";

export function useDirectoryPicker() {
  const { pickPath, pathPickerElement } = useRemotePathPicker();
  return {
    suspendsParentModal: true as boolean,
    async pickDirectory(initialPath: string): Promise<string | null> {
      return await pickPath({ mode: "directory", initialPath });
    },
    directoryPickerElement: pathPickerElement,
  };
}
