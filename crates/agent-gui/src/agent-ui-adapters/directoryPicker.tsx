import { invoke } from "@tauri-apps/api/core";

export function useDirectoryPicker() {
  return {
    suspendsParentModal: false as boolean,
    async pickDirectory(initialPath: string): Promise<string | null> {
      return await invoke<string | null>("system_pick_folder", {
        initial_workdir: initialPath || undefined,
      });
    },
    directoryPickerElement: null,
  };
}
