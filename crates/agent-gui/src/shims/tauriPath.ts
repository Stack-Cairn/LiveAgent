import { homeDir as tauriHomeDir } from "@tauri-apps/api/path";
import { isKBrainBrowserHost, isTauriHost } from "../lib/host";

export async function homeDir(): Promise<string> {
  if (isKBrainBrowserHost() || !isTauriHost()) return "";
  return tauriHomeDir();
}
