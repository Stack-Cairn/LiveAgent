import {
  openUrl as tauriOpenUrl,
  revealItemInDir as tauriRevealItemInDir,
} from "@tauri-apps/plugin-opener";
import { isKBrainBrowserHost, isTauriHost } from "../lib/host";

export async function openUrl(url: string): Promise<void> {
  if (isKBrainBrowserHost() || !isTauriHost()) {
    if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await tauriOpenUrl(url);
}

export async function revealItemInDir(path: string): Promise<void> {
  if (isKBrainBrowserHost() || !isTauriHost()) {
    throw new Error("Opening a file location requires the desktop host");
  }
  await tauriRevealItemInDir(path);
}
