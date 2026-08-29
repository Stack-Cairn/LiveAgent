type WebSocketConstructor = new (
  url: string | URL,
  protocols?: string | string[],
) => WebSocket;

type HeaderMap = Record<string, string>;
type WebSocketOptions = {
  headers?: HeaderMap;
};

type WebSocketWithOptionsConstructor = new (
  url: string | URL,
  options?: string | string[] | WebSocketOptions,
) => WebSocket;

const INSTALL_FLAG = "__liveagentCodexWebSocketProxyInstalled";

function isHeaderOptions(value: unknown): value is WebSocketOptions {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "headers" in value);
}

function rewriteLocalProxyUrl(rawUrl: string | URL): string {
  const url = new URL(String(rawUrl));
  if (url.pathname === "/proxy" || url.pathname.startsWith("/proxy/")) {
    url.pathname = url.pathname.replace(/^\/proxy(?=\/|$)/, "/proxy-ws");
  }
  return url.toString();
}

function createForwardedEvent(type: string, event: Event): Event {
  if (type === "message") {
    const source = event as MessageEvent;
    return new MessageEvent("message", { data: source.data, origin: source.origin });
  }
  if (type === "close") {
    const source = event as CloseEvent;
    return new CloseEvent("close", {
      code: source.code,
      reason: source.reason,
      wasClean: source.wasClean,
    });
  }
  const forwarded = new Event(type);
  const message = (event as Event & { message?: unknown }).message;
  if (typeof message === "string") {
    Object.defineProperty(forwarded, "message", { configurable: true, value: message });
  }
  return forwarded;
}

/**
 * Browser WebSocket does not accept custom headers, while pi-ai's Codex
 * transport uses the Node-style `new WebSocket(url, { headers })` form. This
 * shim preserves the browser WebSocket surface and sends the requested headers
 * in a one-time local-proxy handshake frame. Non-header WebSocket calls are
 * forwarded unchanged.
 */
export function installCodexWebSocketProxy(): void {
  const globalObject = globalThis as unknown as {
    WebSocket?: WebSocketWithOptionsConstructor & { [INSTALL_FLAG]?: boolean };
  };
  const NativeWebSocket = globalObject.WebSocket;
  if (!NativeWebSocket || NativeWebSocket[INSTALL_FLAG]) return;
  const NativeWebSocketConstructor = NativeWebSocket as WebSocketConstructor;

  class LiveAgentWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly CONNECTING = LiveAgentWebSocket.CONNECTING;
    readonly OPEN = LiveAgentWebSocket.OPEN;
    readonly CLOSING = LiveAgentWebSocket.CLOSING;
    readonly CLOSED = LiveAgentWebSocket.CLOSED;

    binaryType: BinaryType = "blob";
    bufferedAmount = 0;
    extensions = "";
    protocol = "";
    readonly url: string;
    readyState = LiveAgentWebSocket.CONNECTING;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;

    private readonly inner: WebSocket;
    private readonly headers?: HeaderMap;
    private handshakeSent = false;

    constructor(url: string | URL, protocolsOrOptions?: string | string[] | WebSocketOptions) {
      super();
      this.url = String(url);
      this.headers = isHeaderOptions(protocolsOrOptions)
        ? protocolsOrOptions.headers
        : undefined;
      const targetUrl = this.headers ? rewriteLocalProxyUrl(url) : String(url);
      const protocols = this.headers
        ? undefined
        : (protocolsOrOptions as string | string[] | undefined);
      this.inner = protocols === undefined
        ? new NativeWebSocketConstructor(targetUrl)
        : new NativeWebSocketConstructor(targetUrl, protocols);
      this.inner.binaryType = this.binaryType;

      for (const type of ["open", "message", "error", "close"] as const) {
        this.inner.addEventListener(type, (event) => this.forward(type, event));
      }
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      this.inner.send(data as Parameters<WebSocket["send"]>[0]);
    }

    close(code?: number, reason?: string): void {
      this.readyState = LiveAgentWebSocket.CLOSING;
      this.inner.close(code, reason);
    }

    private forward(type: "open" | "message" | "error" | "close", event: Event): void {
      if (type === "open") {
        this.readyState = LiveAgentWebSocket.OPEN;
        if (this.headers && !this.handshakeSent) {
          this.handshakeSent = true;
          this.inner.send(
            JSON.stringify({
              type: "liveagent.proxy.websocket.handshake",
              headers: this.headers,
            }),
          );
        }
      } else if (type === "close") {
        this.readyState = LiveAgentWebSocket.CLOSED;
      }

      const forwarded = createForwardedEvent(type, event);
      this.dispatchEvent(forwarded);
      if (type === "open") this.onopen?.(forwarded);
      if (type === "message") this.onmessage?.(forwarded as MessageEvent);
      if (type === "error") this.onerror?.(forwarded);
      if (type === "close") this.onclose?.(forwarded as CloseEvent);
    }
  }

  Object.defineProperty(LiveAgentWebSocket, INSTALL_FLAG, { value: true });
  globalObject.WebSocket = LiveAgentWebSocket as unknown as WebSocketWithOptionsConstructor & {
    [INSTALL_FLAG]?: boolean;
  };
}
