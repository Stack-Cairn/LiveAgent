// Thin wrapper around the browser Web Speech API (SpeechRecognition /
// webkitSpeechRecognition). The surface owns microphone permission and UI;
// the browser or operating system may still use a remote recognition service.

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

export type SpeechRecognitionSessionCallbacks = {
  /** Fires for every underlying engine start, including automatic restarts. */
  onRecognitionStart?: () => void;
  /** Fires once for an explicit listening session, never for automatic restarts. */
  onSessionStart?: () => void;
  onUpdate?: (payload: { committed: string; interim: string }) => void;
  onError?: (errorCode: string) => void;
  onEnd?: () => void;
};

export type SpeechRecognitionSession = {
  start: () => boolean;
  stop: () => void;
  dispose: () => void;
  isListeningRequested: () => boolean;
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

/** Web Speech microphone capture is blocked in non-secure browser contexts. */
export function isSpeechRecognitionSecureContext(): boolean {
  if (typeof window === "undefined") return true;
  return window.isSecureContext !== false;
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
      return "chat.voice.permissionDenied";
    case "service-not-allowed":
      return "chat.voice.serviceUnavailable";
    case "no-speech":
      return "chat.voice.noSpeech";
    case "audio-capture":
      return "chat.voice.noMicrophone";
    case "network":
      return "chat.voice.networkError";
    case "language-not-supported":
      return "chat.voice.languageUnsupported";
    case "aborted":
      return "chat.voice.aborted";
    default:
      return "chat.voice.failed";
  }
}

/**
 * Own one explicit dictation session. Some engines end after a pause even in
 * continuous mode, so the same recognition object is restarted without
 * replaying the consumer's session-start callback or clearing committed text.
 */
export function createSpeechRecognitionSession(
  recognition: SpeechRecognitionLike,
  callbacks: SpeechRecognitionSessionCallbacks,
): SpeechRecognitionSession {
  let wantsListening = false;
  let didNotifySessionStart = false;
  let committed = "";
  let disposed = false;

  const reportTerminalError = (errorCode: string) => {
    wantsListening = false;
    callbacks.onError?.(errorCode);
  };

  recognition.onstart = () => {
    callbacks.onRecognitionStart?.();
    if (!didNotifySessionStart) {
      didNotifySessionStart = true;
      callbacks.onSessionStart?.();
    }
  };

  recognition.onerror = (event) => {
    const code = typeof event?.error === "string" ? event.error : "unknown";
    if (isRecoverableSpeechRecognitionError(code) && wantsListening) return;
    if (code === "aborted" && !wantsListening) return;
    reportTerminalError(code);
  };

  recognition.onresult = (event) => {
    let nextCommitted = committed;
    let nextInterim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const piece = result?.[0]?.transcript ?? "";
      if (!piece) continue;
      if (result.isFinal) {
        nextCommitted = appendSpeechChunk(nextCommitted, piece);
        nextInterim = "";
      } else {
        nextInterim = appendSpeechChunk(nextInterim, piece);
      }
    }
    committed = nextCommitted;
    callbacks.onUpdate?.({ committed: nextCommitted, interim: nextInterim });
  };

  recognition.onend = () => {
    if (disposed) return;
    if (wantsListening) {
      try {
        recognition.start();
        return;
      } catch {
        reportTerminalError("unknown");
      }
    }
    callbacks.onEnd?.();
  };

  return {
    start: () => {
      if (disposed) return false;
      wantsListening = true;
      committed = "";
      try {
        recognition.start();
        return true;
      } catch {
        reportTerminalError("unknown");
        return false;
      }
    },
    stop: () => {
      if (disposed) return;
      wantsListening = false;
      try {
        recognition.stop();
      } catch {
        // ignore
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      wantsListening = false;
      recognition.onstart = null;
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      try {
        recognition.abort();
      } catch {
        // ignore
      }
    },
    isListeningRequested: () => wantsListening,
  };
}

/** Errors that may end a continuous session without invalidating it. */
export function isRecoverableSpeechRecognitionError(errorCode: string): boolean {
  return errorCode === "no-speech";
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

/** Build only the text appended by dictation, leaving existing editor DOM untouched. */
export function composeVoiceTranscriptSuffix(
  base: string,
  committed: string,
  interim = "",
): string {
  const speech = joinSpeechParts(committed, interim);
  if (!speech) return "";
  const head = base.trimEnd();
  if (!head || /\s$/.test(base) || CJK_TAIL.test(head)) return speech;
  return ` ${speech}`;
}

export function appendSpeechChunk(existing: string, chunk: string): string {
  return joinSpeechParts(existing, chunk);
}
