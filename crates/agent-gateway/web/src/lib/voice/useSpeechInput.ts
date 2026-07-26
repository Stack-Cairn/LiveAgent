import { useCallback, useEffect, useRef, useState } from "react";
import {
  appendSpeechChunk,
  createSpeechRecognition,
  isRecoverableSpeechRecognitionError,
  isSpeechRecognitionSupported,
  mapSpeechRecognitionError,
  type SpeechRecognitionLike,
} from "./speechRecognition";

export type SpeechInputPhase = "idle" | "listening" | "unsupported";

export type UseSpeechInputOptions = {
  /** BCP-47 language tag, e.g. zh-CN / en-US. */
  language: string;
  /** When false, the hook stays idle and reports unsupported. */
  enabled?: boolean;
  /** Called when recognition session actually starts. */
  onStart?: () => void;
  /**
   * Fired for interim and final hypotheses. `committed` is the concatenation
   * of all final chunks in this session; `interim` is the current non-final
   * hypothesis (empty after a final).
   */
  onUpdate?: (payload: { committed: string; interim: string }) => void;
  onError?: (messageKey: string) => void;
  onEnd?: () => void;
};

export type UseSpeechInputResult = {
  supported: boolean;
  phase: SpeechInputPhase;
  isListening: boolean;
  errorKey: string | null;
  committed: string;
  interim: string;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  toggle: () => void;
  clearError: () => void;
};

export function useSpeechInput(options: UseSpeechInputOptions): UseSpeechInputResult {
  const { language, enabled = true, onStart, onUpdate, onError, onEnd } = options;
  const supported = enabled && isSpeechRecognitionSupported();
  const [phase, setPhase] = useState<SpeechInputPhase>(supported ? "idle" : "unsupported");
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [committed, setCommitted] = useState("");
  const [interim, setInterim] = useState("");

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const wantListeningRef = useRef(false);
  const committedRef = useRef("");
  const languageRef = useRef(language);
  const onStartRef = useRef(onStart);
  const onUpdateRef = useRef(onUpdate);
  const onErrorRef = useRef(onError);
  const onEndRef = useRef(onEnd);

  languageRef.current = language;
  onStartRef.current = onStart;
  onUpdateRef.current = onUpdate;
  onErrorRef.current = onError;
  onEndRef.current = onEnd;

  const emitUpdate = useCallback((nextCommitted: string, nextInterim: string) => {
    committedRef.current = nextCommitted;
    setCommitted(nextCommitted);
    setInterim(nextInterim);
    onUpdateRef.current?.({ committed: nextCommitted, interim: nextInterim });
  }, []);

  const disposeRecognition = useCallback(() => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (!recognition) return;
    recognition.onstart = null;
    recognition.onend = null;
    recognition.onerror = null;
    recognition.onresult = null;
    try {
      recognition.abort();
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!enabled || !supported) {
      wantListeningRef.current = false;
      disposeRecognition();
      setPhase("unsupported");
      setInterim("");
      return;
    }
    setPhase((prev) => (prev === "listening" ? prev : "idle"));
  }, [disposeRecognition, enabled, supported]);

  const stop = useCallback(() => {
    wantListeningRef.current = false;
    const recognition = recognitionRef.current;
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        // ignore
      }
    }
    setPhase((prev) => (prev === "unsupported" ? prev : "idle"));
    setInterim("");
  }, []);

  const cancel = useCallback(() => {
    wantListeningRef.current = false;
    disposeRecognition();
    setPhase((prev) => (prev === "unsupported" ? prev : "idle"));
    setInterim("");
  }, [disposeRecognition]);

  const start = useCallback(() => {
    if (!supported) {
      setPhase("unsupported");
      setErrorKey("chat.voice.unsupported");
      onErrorRef.current?.("chat.voice.unsupported");
      return;
    }

    setErrorKey(null);
    wantListeningRef.current = true;
    committedRef.current = "";
    setCommitted("");
    setInterim("");

    disposeRecognition();
    const recognition = createSpeechRecognition();
    if (!recognition) {
      wantListeningRef.current = false;
      setPhase("unsupported");
      setErrorKey("chat.voice.unsupported");
      onErrorRef.current?.("chat.voice.unsupported");
      return;
    }

    recognition.lang = languageRef.current || "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let didNotifySessionStart = false;
    recognition.onstart = () => {
      setPhase("listening");
      if (!didNotifySessionStart) {
        didNotifySessionStart = true;
        onStartRef.current?.();
      }
    };

    recognition.onerror = (event) => {
      const code = typeof event?.error === "string" ? event.error : "unknown";
      // Continuous mode may emit no-speech between phrases; keep that session alive.
      if (isRecoverableSpeechRecognitionError(code) && wantListeningRef.current) {
        return;
      }
      // User-initiated abort/stop should not surface as an error toast.
      if (code === "aborted" && !wantListeningRef.current) {
        return;
      }
      const key = mapSpeechRecognitionError(code);
      wantListeningRef.current = false;
      setPhase("idle");
      setErrorKey(key);
      onErrorRef.current?.(key);
    };

    recognition.onresult = (event) => {
      let nextCommitted = committedRef.current;
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
      emitUpdate(nextCommitted, nextInterim);
    };

    recognition.onend = () => {
      // Some engines stop after a pause even with continuous=true; restart
      // while the user still wants the session open.
      if (wantListeningRef.current) {
        try {
          recognition.start();
          return;
        } catch {
          wantListeningRef.current = false;
          setErrorKey("chat.voice.failed");
          onErrorRef.current?.("chat.voice.failed");
        }
      }
      setPhase("idle");
      setInterim("");
      onEndRef.current?.();
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      wantListeningRef.current = false;
      setPhase("idle");
      setErrorKey("chat.voice.failed");
      onErrorRef.current?.("chat.voice.failed");
      disposeRecognition();
    }
  }, [disposeRecognition, emitUpdate, supported]);

  const toggle = useCallback(() => {
    if (wantListeningRef.current || phase === "listening") {
      stop();
      return;
    }
    start();
  }, [phase, start, stop]);

  const clearError = useCallback(() => setErrorKey(null), []);

  useEffect(() => {
    return () => {
      wantListeningRef.current = false;
      disposeRecognition();
    };
  }, [disposeRecognition]);

  return {
    supported,
    phase: supported ? phase : "unsupported",
    isListening: phase === "listening",
    errorKey,
    committed,
    interim,
    start,
    stop,
    cancel,
    toggle,
    clearError,
  };
}
