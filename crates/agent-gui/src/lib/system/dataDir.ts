import { invoke } from "@liveagent/app/shims/tauriCore";

export type DataDirStatus = {
  current: string;
  default: string;
  custom: boolean;
  /** Environment variable that pins the data location; relocation is disabled while set. */
  envOverride: string | null;
};

export type DataDirMigrateResult = {
  previous: string;
  target: string;
  files: number;
  bytes: number;
};

/** Folder created inside the directory the user picks, so picking a busy drive root still works. */
export const DATA_DIR_FOLDER_NAME = "LiveAgent";

export function dataDirTargetFor(picked: string, defaultRoot: string): string {
  const separator = defaultRoot.includes("\\") ? "\\" : "/";
  const trimmed = picked.replace(/[\\/]+$/, "");
  const last = trimmed.split(/[\\/]/).pop() ?? "";
  if (last === DATA_DIR_FOLDER_NAME) return trimmed;
  return `${trimmed}${separator}${DATA_DIR_FOLDER_NAME}`;
}

export function loadDataDirStatus(): Promise<DataDirStatus> {
  return invoke<DataDirStatus>("data_dir_status");
}

export function migrateDataDir(target: string): Promise<DataDirMigrateResult> {
  return invoke<DataDirMigrateResult>("data_dir_migrate", { target });
}

export function restartApp(): Promise<void> {
  return invoke<void>("app_restart");
}
