// nativeNet.ts — 原生网络层。
// Tauri 的 WebView 会对跨域 fetch/WebSocket 强制 CORS 与 Origin 校验，而 Gateway
// 既不下发 CORS 头，也拒绝跨源 WebSocket 升级，导致登录页 “fail to fetch”。
// 这里把网关请求路由到 Tauri 原生网络栈（reqwest / tokio-tungstenite），绕开
// WebView 的同源策略；浏览器环境下则回落到标准 fetch / WebSocket 保持既有行为。
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import TauriWebSocket from "@tauri-apps/plugin-websocket";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// nativeFetch 在 Tauri 内走原生 HTTP（无 CORS），浏览器内回落到 window.fetch。
export async function nativeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (isTauriRuntime()) {
    return tauriFetch(input, init);
  }
  return window.fetch(input, init);
}

// Tauri 原生 WebSocket 消息（二进制以 number[] 表示）。
type TauriWsMessage =
  | { type: "Text"; data: string }
  | { type: "Binary"; data: number[] }
  | { type: "Ping"; data: number[] }
  | { type: "Pong"; data: number[] }
  | { type: "Close"; data: { code: number; reason: string } | null };

// NativeWebSocket 提供与浏览器 WebSocket 一致的 onopen/onmessage/onerror/onclose
// 与 readyState/send/close 接口；Tauri 内包装 tauri-plugin-websocket，浏览器内
// 直接委托给原生 WebSocket。
export class NativeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = NativeWebSocket.CONNECTING;
  readonly OPEN = NativeWebSocket.OPEN;
  readonly CLOSING = NativeWebSocket.CLOSING;
  readonly CLOSED = NativeWebSocket.CLOSED;

  readonly url: string;
  binaryType: BinaryType = "arraybuffer";

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  private browserSocket: globalThis.WebSocket | null = null;
  private tauriSocket: TauriWebSocket | null = null;
  private readyStateValue = NativeWebSocket.CONNECTING;
  private closed = false;

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = url.toString();
    if (isTauriRuntime()) {
      void this.connectTauri();
    } else {
      const socket = new globalThis.WebSocket(url, protocols);
      this.browserSocket = socket;
      socket.binaryType = "arraybuffer";
      socket.onopen = (event) => this.onopen?.(event);
      socket.onmessage = (event) => this.onmessage?.(event);
      socket.onerror = (event) => this.onerror?.(event);
      socket.onclose = (event) => this.onclose?.(event);
    }
  }

  get readyState(): number {
    return this.browserSocket ? this.browserSocket.readyState : this.readyStateValue;
  }

  private async connectTauri(): Promise<void> {
    try {
      const socket = await TauriWebSocket.connect(this.url);
      if (this.closed) {
        void socket.disconnect().catch(() => {});
        return;
      }
      this.tauriSocket = socket;
      this.readyStateValue = NativeWebSocket.OPEN;
      socket.addListener((message) => this.handleTauriMessage(message));
      this.onopen?.(new Event("open"));
    } catch {
      if (this.closed) {
        return;
      }
      this.readyStateValue = NativeWebSocket.CLOSED;
      this.onerror?.(new Event("error"));
      this.onclose?.(new CloseEvent("close", { code: 1006, wasClean: false }));
    }
  }

  private handleTauriMessage(message: TauriWsMessage): void {
    switch (message.type) {
      case "Text":
        this.onmessage?.(new MessageEvent("message", { data: message.data }));
        return;
      case "Binary": {
        const buffer = new Uint8Array(message.data).buffer;
        this.onmessage?.(new MessageEvent("message", { data: buffer }));
        return;
      }
      case "Close": {
        if (this.readyStateValue === NativeWebSocket.CLOSED) {
          return;
        }
        this.readyStateValue = NativeWebSocket.CLOSED;
        const code = message.data?.code ?? 1005;
        this.onclose?.(
          new CloseEvent("close", {
            code,
            reason: message.data?.reason ?? "",
            wasClean: code === 1000,
          }),
        );
        return;
      }
      default:
        // Ping/Pong 属于传输层心跳，不上抛给应用。
        return;
    }
  }

  send(data: string | ArrayBuffer | ArrayBufferView<ArrayBuffer> | Blob): void {
    if (this.browserSocket) {
      this.browserSocket.send(data);
      return;
    }
    if (this.readyStateValue !== NativeWebSocket.OPEN || !this.tauriSocket) {
      throw new Error("WebSocket is not open");
    }
    const bytes = toUint8Array(data);
    void this.tauriSocket.send(Array.from(bytes)).catch(() => {
      // 写失败通常伴随服务端关闭，由 onclose 统一驱动重连。
    });
  }

  close(code?: number, reason?: string): void {
    if (this.browserSocket) {
      this.browserSocket.close(code, reason);
      return;
    }
    if (this.readyStateValue === NativeWebSocket.CLOSED) {
      return;
    }
    this.closed = true;
    this.readyStateValue = NativeWebSocket.CLOSING;
    const socket = this.tauriSocket;
    if (socket) {
      void socket.disconnect().catch(() => this.finalizeTauriClose());
    } else {
      this.finalizeTauriClose();
    }
  }

  private finalizeTauriClose(): void {
    if (this.readyStateValue === NativeWebSocket.CLOSED) {
      return;
    }
    this.readyStateValue = NativeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code: 1000, wasClean: true }));
  }
}

function toUint8Array(
  data: string | ArrayBuffer | ArrayBufferView<ArrayBuffer> | Blob,
): Uint8Array {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new Error("Unsupported WebSocket message type");
}
