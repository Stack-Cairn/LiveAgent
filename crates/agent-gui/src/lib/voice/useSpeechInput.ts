import { useCallback, useEffect, useRef, useState } from "react";
import {
  createSpeechRecognition,
  createSpeechRecognitionSession,
  isSpeechRecognitionSupported,
  mapSpeechRecognitionError,
  type SpeechRecognitionSession,
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

  const sessionRef = useRef<SpeechRecognitionSession | null>(null);
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
    setCommitted(nextCommitted);
    setInterim(nextInterim);
    onUpdateRef.current?.({ committed: nextCommitted, interim: nextInterim });
  }, []);

  const disposeSession = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    session?.dispose();
  }, []);

  useEffect(() => {
    if (!enabled || !supported) {
      disposeSession();
      setPhase("unsupported");
      setInterim("");
      return;
    }
    setPhase((prev) => (prev === "listening" ? prev : "idle"));
  }, [disposeSession, enabled, supported]);

  const stop = useCallback(() => {
    sessionRef.current?.stop();
    setPhase((prev) => (prev === "unsupported" ? prev : "idle"));
    setInterim("");
  }, []);

  const cancel = useCallback(() => {
    disposeSession();
    setPhase((prev) => (prev === "unsupported" ? prev : "idle"));
    setInterim("");
  }, [disposeSession]);

  const start = useCallback(() => {
    if (!supported) {
      setPhase("unsupported");
      setErrorKey("chat.voice.unsupported");
      onErrorRef.current?.("chat.voice.unsupported");
      return;
    }

    setErrorKey(null);
    setCommitted("");
    setInterim("");

    disposeSession();
    const recognition = createSpeechRecognition();
    if (!recognition) {
      setPhase("unsupported");
      setErrorKey("chat.voice.unsupported");
      onErrorRef.current?.("chat.voice.unsupported");
      return;
    }

    recognition.lang = languageRef.current || "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    const session = createSpeechRecognitionSession(recognition, {
      onRecognitionStart: () => setPhase("listening"),
      onSessionStart: () => onStartRef.current?.(),
      onUpdate: ({ committed: nextCommitted, interim: nextInterim }) => {
        emitUpdate(nextCommitted, nextInterim);
      },
      onError: (code) => {
        const key = mapSpeechRecognitionError(code);
        setPhase("idle");
        setErrorKey(key);
        onErrorRef.current?.(key);
      },
      onEnd: () => {
        setPhase("idle");
        setInterim("");
        onEndRef.current?.();
      },
    });
    sessionRef.current = session;
    if (!session.start()) {
      disposeSession();
    }
  }, [disposeSession, emitUpdate, supported]);

  const toggle = useCallback(() => {
    if (sessionRef.current?.isListeningRequested() || phase === "listening") {
      stop();
      return;
    }
    start();
  }, [phase, start, stop]);

  const clearError = useCallback(() => setErrorKey(null), []);

  useEffect(() => {
    return () => {
      disposeSession();
    };
  }, [disposeSession]);

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
