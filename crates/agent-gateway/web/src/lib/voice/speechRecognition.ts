// Thin wrapper around the browser Web Speech API (SpeechRecognition /
// webkitSpeechRecognition). Both the Tauri WebView and the Gateway WebUI use
// this path so recognition stays local to the surface that owns the mic.

export type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: ((this: SpeechRecognitionLike, ev: Event) => unknown) | null;
  onend: ((this: SpeechRecognitionLike, ev: Event) => unknown) | null;
  onerror: ((this: SpeechRecognitionLike, ev: SpeechRecognitionErrorEventLike) => unknown) | null;
  onresult: ((this: SpeechRecognitionLike, ev: SpeechRecognitionEventLike) => unknown) | null;
};

export type SpeechRecognitionErrorEventLike = {
  error: string;
  message?: string;
};

export type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0?: { transcript?: string };
  length: number;
};

export type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike> & {
    length: number;
  };
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

/**
 * Mobile browsers already ship IME/system dictation. Built-in Web Speech
 * voice buttons are for desktop WebView/desktop browser only.
 */
export function isMobileClient(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua)) {
    return true;
  }
  // iPadOS 13+ may report as Macintosh with multi-touch.
  if (
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 1 &&
    /Macintosh/i.test(ua)
  ) {
    return true;
  }
  return false;
}

export function createSpeechRecognition(): SpeechRecognitionLike | null {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

export function mapSpeechRecognitionError(errorCode: string): string {
  switch (errorCode) {
    case "not-allowed":
    case "service-not-allowed":
      return "chat.voice.permissionDenied";
    case "no-speech":
      return "chat.voice.noSpeech";
    case "audio-capture":
      return "chat.voice.noMicrophone";
    case "network":
      return "chat.voice.networkError";
    case "aborted":
      return "chat.voice.aborted";
    default:
      return "chat.voice.failed";
  }
}

const CJK_TAIL = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]$/;

function joinSpeechParts(left: string, right: string): string {
  const head = left.trimEnd();
  const next = right.trim();
  if (!head) return next;
  if (!next) return head;
  // Chinese/Japanese/Korean: no space between adjacent speech parts.
  return CJK_TAIL.test(head) ? `${head}${next}` : `${head} ${next}`;
}

/** Join pre-existing composer text with newly recognized speech. */
export function composeVoiceTranscript(base: string, committed: string, interim = ""): string {
  return joinSpeechParts(joinSpeechParts(base, committed), interim);
}

export function appendSpeechChunk(existing: string, chunk: string): string {
  return joinSpeechParts(existing, chunk);
}
