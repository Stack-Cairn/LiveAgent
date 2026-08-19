import type { AppSettings, SttProviderId, SttProviderSettings } from "@liveagent/app/lib/settings";

export type SttUiState =
  | "idle"
  | "requesting-permission"
  | "buffering"
  | "recognizing"
  | "stopping"
  | "error";
export type SttRuntimeEvent =
  | { type: "ready"; sessionId: string }
  | { type: "partial"; sessionId: string; text: string }
  | { type: "final"; sessionId: string; text: string }
  | { type: "error"; sessionId: string; code: string; message: string }
  | { type: "closed"; sessionId: string };

export type SttTransportOpenOptions = {
  sessionId: string;
  provider: SttProviderId;
  onEvent: (event: SttRuntimeEvent) => void;
};

export interface SttTransport {
  requestPermission?: () => Promise<void>;
  open: (options: SttTransportOpenOptions) => Promise<void>;
  sendAudio: (sessionId: string, sequence: number, pcm: Uint8Array) => Promise<void>;
  stop: (sessionId: string) => Promise<void>;
  cancel: (sessionId: string) => Promise<void>;
  dispose?: () => void;
}

export type SttConnectionTestResult =
  | "connected"
  | "connected_no_speech"
  | "authentication_failed"
  | "protocol_failed"
  | "network_failed"
  | "timeout";

export type SttConnectionTestResponse = {
  result: SttConnectionTestResult;
  message?: string;
};

export type SttSecretField = Extract<
  keyof SttProviderSettings,
  "apiKey" | "secretId" | "secretKey" | "accessToken" | "baiduApiKey"
>;

export type SttSecretRevealMode = "value" | "field-name";

export interface SttSettingsService {
  runtimeLabel?: string;
  /**
   * Desktop reveals the locally stored value on demand. WebUI deliberately
   * reveals only the field label and never requests a credential value.
   */
  secretRevealMode?: SttSecretRevealMode;
  revealSecret?: (provider: SttProviderId, field: SttSecretField) => Promise<string>;
  get: () => Promise<AppSettings["stt"]>;
  update: (settings: AppSettings["stt"]) => Promise<AppSettings["stt"]>;
  test: (provider: SttProviderId) => Promise<SttConnectionTestResponse>;
}
