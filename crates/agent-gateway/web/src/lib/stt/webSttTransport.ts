import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type {
  SttRuntimeEvent,
  SttTransport,
  SttTransportOpenOptions,
} from "@liveagent/ui/lib/stt/types";
import {
  SttAudioSchema,
  type SttClientFrame,
  SttClientFrameSchema,
  SttClientHelloSchema,
  type SttServerFrame,
  SttServerFrameSchema,
  SttSessionControlSchema,
  SttStartSchema,
} from "@/lib/proto/gen/proto/v2/gateway_ws_pb";
import { loadToken } from "@/lib/storage";

const STT_SUBPROTOCOL = "liveagent.v2.pb";

type SttClientPayload = SttClientFrame["payload"];

class WebSttTransport implements SttTransport {
  private socket: WebSocket | null = null;
  private handler: ((event: SttRuntimeEvent) => void) | null = null;

  async open(options: SttTransportOpenOptions) {
    this.dispose();
    this.handler = options.onEvent;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws/v2/stt`, STT_SUBPROTOCOL);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        settled = true;
        socket.close();
        reject(new Error("Gateway STT 连接超时"));
      }, 10_000);
      const settleError = (message: string) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(new Error(message));
      };

      socket.onopen = () => {
        this.sendFrame({
          case: "hello",
          value: create(SttClientHelloSchema, {
            protocolVersion: 2,
            token: loadToken(),
          }),
        });
      };
      socket.onerror = () => settleError("Gateway STT 网络连接失败");
      socket.onmessage = (message) => {
        if (!(message.data instanceof ArrayBuffer)) return;
        let frame: SttServerFrame;
        try {
          frame = fromBinary(SttServerFrameSchema, new Uint8Array(message.data));
        } catch {
          settleError("Gateway STT 返回了无效协议帧");
          return;
        }
        const payload = frame.payload;
        if (payload.case === "hello") {
          if (!payload.value.ok) {
            settleError(payload.value.message || "Gateway STT 鉴权失败");
            return;
          }
          if (!settled) {
            settled = true;
            window.clearTimeout(timer);
            this.sendFrame({
              case: "start",
              value: create(SttStartSchema, {
                sessionId: options.sessionId,
                provider: options.provider,
              }),
            });
            resolve();
          }
          return;
        }
        if (payload.case === "ready") {
          this.handler?.({ type: "ready", sessionId: payload.value.sessionId });
        } else if (payload.case === "partial") {
          this.handler?.({
            type: "partial",
            sessionId: payload.value.sessionId,
            text: payload.value.text,
          });
        } else if (payload.case === "final") {
          this.handler?.({
            type: "final",
            sessionId: payload.value.sessionId,
            text: payload.value.text,
          });
        } else if (payload.case === "error") {
          this.handler?.({
            type: "error",
            sessionId: payload.value.sessionId,
            code: payload.value.code,
            message: payload.value.message,
          });
        } else if (payload.case === "closed") {
          this.handler?.({ type: "closed", sessionId: payload.value.sessionId });
        }
      };
      socket.onclose = () => {
        settleError("Gateway STT 连接已关闭");
        this.handler?.({ type: "closed", sessionId: options.sessionId });
      };
    });
  }

  async sendAudio(sessionId: string, sequence: number, pcm: Uint8Array) {
    this.sendFrame({
      case: "audio",
      value: create(SttAudioSchema, { sessionId, sequence, pcm }),
    });
  }

  async stop(sessionId: string) {
    this.sendControl("stop", sessionId);
  }

  async cancel(sessionId: string) {
    this.sendControl("cancel", sessionId);
  }

  private sendControl(type: "stop" | "cancel", sessionId: string) {
    this.sendFrame({
      case: type,
      value: create(SttSessionControlSchema, { sessionId }),
    });
  }

  private sendFrame(payload: SttClientPayload) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gateway STT 未连接");
    }
    socket.send(toBinary(SttClientFrameSchema, create(SttClientFrameSchema, { payload })));
  }

  dispose() {
    this.handler = null;
    this.socket?.close();
    this.socket = null;
  }
}

export const webSttTransport = new WebSttTransport();
