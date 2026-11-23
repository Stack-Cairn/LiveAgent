/**
 * Speech-to-text failures raised by the capture, transport and composer layers.
 * Each code has a `chat.stt.error.<code>` message (see i18n/translations/sttTranslations.ts);
 * the layers stay free of UI text and the composer translates the code for the user.
 */
export type SttErrorCode =
  | "invalidSampleRate"
  | "microphoneUnsupported"
  | "microphoneDisconnected"
  | "microphonePermissionDenied"
  | "microphoneNotFound"
  | "microphoneBusy"
  | "microphoneConstraints"
  | "microphoneStartFailed"
  | "gatewayTimeout"
  | "gatewayNetwork"
  | "gatewayProtocol"
  | "gatewayAuth"
  | "gatewayClosed"
  | "gatewayNotConnected"
  | "sendAudioFailed"
  | "sendAudioTimeout"
  | "bufferFull"
  | "finalTimeout"
  | "stopFailed"
  | "stopMicrophoneFailed"
  | "recognitionFailed"
  | "connectionClosed"
  | "providerIncomplete"
  | "composerLocked"
  | "connectTimeout"
  | "startFailed";

export class SttError extends Error {
  readonly code: SttErrorCode;

  /** `detail` is a technical, untranslated note for logs; the UI shows the code's message. */
  constructor(code: SttErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "SttError";
    this.code = code;
  }
}

/**
 * The text to show for an STT failure: a coded failure is translated, a message
 * that came from the backend or the speech provider is shown as is, and anything
 * else falls back to the given code's message.
 */
export function sttErrorMessage(
  cause: unknown,
  fallback: SttErrorCode,
  t: (key: string) => string,
): string {
  if (cause instanceof SttError) return t(`chat.stt.error.${cause.code}`);
  if (cause instanceof Error && cause.message.trim()) return cause.message.trim();
  if (typeof cause === "string" && cause.trim()) return cause.trim();
  return t(`chat.stt.error.${fallback}`);
}

/**
 * An STT settings request that failed without user-facing text (an HTTP status
 * and body, a missing response section). The settings page shows its localized
 * message for the operation and appends this technical detail.
 */
export class SttSettingsRequestError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`STT settings request failed: ${detail}`);
    this.name = "SttSettingsRequestError";
    this.detail = detail;
  }
}
