import type { ImageExportHandler } from "./client";
import type { ImageStudioClient } from "./types";

type SaveFilePicker = (options: { suggestedName: string }) => Promise<{
  createWritable(): Promise<{
    write(blob: Blob): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }>;
}>;

/** A completed write is observable; an anchor click cannot confirm saved/cancelled. */
export function createBrowserImageDownload(
  readAsset: ImageStudioClient["readAsset"],
  picker: SaveFilePicker | undefined = (
    globalThis as typeof globalThis & {
      showSaveFilePicker?: SaveFilePicker;
    }
  ).showSaveFilePicker?.bind(globalThis),
): ImageExportHandler | undefined {
  if (!picker) return undefined;
  return async (id, signal) => {
    signal?.throwIfAborted();
    let handle: Awaited<ReturnType<SaveFilePicker>>;
    try {
      // Open during the user gesture, before downloading the authenticated asset.
      handle = await picker({ suggestedName: `image-${id}` });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return { saved: false };
      throw error;
    }
    const blob = await readAsset(id, "original", signal);
    signal?.throwIfAborted();
    const writable = await handle.createWritable();
    try {
      signal?.throwIfAborted();
      await writable.write(blob);
      signal?.throwIfAborted();
      await writable.close();
      return { saved: true };
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
  };
}
