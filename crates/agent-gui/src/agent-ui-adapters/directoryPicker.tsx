import { invoke } from "../lib/tauriBridge";

export function useDirectoryPicker() {
  return {
    async pickDirectory(initialPath: string): Promise<string | null> {
      return await invoke<string | null>("system_pick_folder", {
        initial_workdir: initialPath || undefined,
      });
    },
    directoryPickerElement: null,
  };
}
