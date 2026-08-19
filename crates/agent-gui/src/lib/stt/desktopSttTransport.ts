import type {
  SttRuntimeEvent,
  SttTransport,
  SttTransportOpenOptions,
} from "@liveagent/ui/lib/stt/types";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

class DesktopSttTransport implements SttTransport {
  private unlisten: UnlistenFn | null = null;
  private handler: ((event: SttRuntimeEvent) => void) | null = null;
  async requestPermission() {
    await invoke("stt_request_microphone_permission");
  }
  async open(options: SttTransportOpenOptions) {
    this.handler = options.onEvent;
    if (!this.unlisten)
      this.unlisten = await listen<SttRuntimeEvent>("stt:event", (event) =>
        this.handler?.(event.payload),
      );
    await invoke("stt_start", { sessionId: options.sessionId, provider: options.provider });
  }
  async sendAudio(sessionId: string, sequence: number, pcm: Uint8Array) {
    await invoke("stt_send_audio", { sessionId, sequence, pcm: Array.from(pcm) });
  }
  async stop(sessionId: string) {
    await invoke("stt_stop", { sessionId });
  }
  async cancel(sessionId: string) {
    await invoke("stt_cancel", { sessionId });
  }
  dispose() {
    this.handler = null;
    this.unlisten?.();
    this.unlisten = null;
  }
}

export const desktopSttTransport = new DesktopSttTransport();
