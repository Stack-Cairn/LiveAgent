import type { SttProviderId } from "@liveagent/app/lib/settings";
import type { MentionComposerHandle } from "@liveagent/ui/components/chat/MentionComposer";
import type { PcmChunk, SttAudioCapture, SttPcmFifo } from "@liveagent/ui/lib/stt/audio";
import { SttError, type SttErrorCode, sttErrorMessage } from "@liveagent/ui/lib/stt/errors";
import type { SttRuntimeEvent, SttTransport, SttUiState } from "@liveagent/ui/lib/stt/types";
import type { MutableRefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// Microphone capture loads when voice input starts, not with the composer.
type SttAudio = typeof import("@liveagent/ui/lib/stt/audio");
const loadSttAudio = (): Promise<SttAudio> => import("@liveagent/ui/lib/stt/audio");

type ActiveSttSession = {
  id: string;
  audio: SttAudio;
  capture: SttAudioCapture;
  fifo: SttPcmFifo;
  ready: boolean;
  stopping: boolean;
  tailQueued: boolean;
  finishSent: boolean;
  lastText: string;
  sequence: number;
  queue: Promise<void>;
  connectTimer: number;
  finalTimer: number | null;
};

export function useComposerStt(options: {
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  provider: SttProviderId | null;
  providerConfigured?: boolean;
  transport?: SttTransport;
  disabled: boolean;
  /** 当前会话或视图身份；变化时取消进行中的识别，避免写进已切换的输入框。 */
  sessionKey?: string;
  /** 输入区被挂起（如轨迹页）时取消识别，避免用户无法点停止。 */
  hidden?: boolean;
  /** 错误上报回调（如麦克风不可用），消息已按 `t` 本地化；由宿主决定展示方式（toast 等）。 */
  onError?: (message: string) => void;
  /** Translates the `chat.stt.error.*` messages of coded failures. */
  t: (key: string) => string;
  /** 供应商缺少必要配置；与运行时错误分流，供界面展示配置引导。 */
  onConfigurationRequired?: () => void;
}) {
  const {
    composerRef,
    provider,
    providerConfigured,
    transport,
    disabled,
    sessionKey,
    hidden = false,
    onError,
    onConfigurationRequired,
    t,
  } = options;
  const [state, setState] = useState<SttUiState>("idle");
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef<ActiveSttSession | null>(null);

  const cleanup = useCallback(
    (preserveLastText: boolean) => {
      const active = activeRef.current;
      activeRef.current = null;
      if (active) {
        window.clearTimeout(active.connectTimer);
        if (active.finalTimer !== null) window.clearTimeout(active.finalTimer);
        void active.capture.stop();
        active.fifo.clear();
      }
      composerRef.current?.cancelTransientText({ preserveLastText });
    },
    [composerRef],
  );

  const fail = useCallback(
    (cause: unknown, fallback: SttErrorCode, expectedSessionId?: string) => {
      const active = activeRef.current;
      if (expectedSessionId && active?.id !== expectedSessionId) return;
      const message = sttErrorMessage(cause, fallback, t);
      if (active) void transport?.cancel(active.id).catch(() => undefined);
      const preserve = Boolean(active?.lastText.trim());
      cleanup(preserve);
      setError(message);
      setState("error");
      onError?.(message);
    },
    [cleanup, onError, t, transport],
  );

  const sendChunk = useCallback(
    (sequence: number, pcm: Int16Array) => {
      const active = activeRef.current;
      if (!active || !transport) return;
      const sessionId = active.id;
      active.queue = active.queue
        .then(() =>
          transport.sendAudio(sessionId, sequence, active.audio.pcm16ToLittleEndianBytes(pcm)),
        )
        .catch((cause) => {
          fail(cause, "sendAudioFailed", sessionId);
        });
    },
    [fail, transport],
  );

  const queueChunk = useCallback(
    (chunk: PcmChunk) => {
      const active = activeRef.current;
      if (!active) return;
      active.sequence = Math.max(active.sequence, chunk.sequence + 1);
      if (active.ready) {
        sendChunk(chunk.sequence, chunk.pcm);
      } else if (!active.fifo.push(chunk)) {
        fail(null, "bufferFull");
      }
    },
    [fail, sendChunk],
  );

  const finishProvider = useCallback(
    async (active: ActiveSttSession) => {
      if (
        activeRef.current !== active ||
        !active.ready ||
        !active.stopping ||
        !active.tailQueued ||
        active.finishSent ||
        !transport
      ) {
        return;
      }
      active.finishSent = true;
      let queueTimer = 0;
      try {
        await Promise.race([
          active.queue,
          new Promise<never>((_, reject) => {
            queueTimer = window.setTimeout(
              () => reject(new SttError("sendAudioTimeout")),
              active.audio.STT_SEND_QUEUE_TIMEOUT_MS,
            );
          }),
        ]);
      } catch (cause) {
        fail(cause, "sendAudioTimeout", active.id);
        return;
      } finally {
        window.clearTimeout(queueTimer);
      }
      if (activeRef.current !== active) return;
      try {
        await transport.stop(active.id);
        active.finalTimer = window.setTimeout(() => fail(null, "finalTimeout"), 5_000);
      } catch (cause) {
        fail(cause, "stopFailed");
      }
    },
    [fail, transport],
  );

  const abortActiveSession = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;
    void transport?.cancel(active.id).catch(() => undefined);
    cleanup(Boolean(active.lastText.trim()));
    setState("idle");
  }, [cleanup, transport]);

  const stop = useCallback(async () => {
    const active = activeRef.current;
    if (!active || !transport) return;
    if (active.stopping) {
      abortActiveSession();
      return;
    }
    active.stopping = true;
    setState("stopping");

    // stop() flushes the final real-audio fragment before the fixed tail.
    try {
      await active.capture.stop();
    } catch (cause) {
      fail(cause, "stopMicrophoneFailed");
      return;
    }
    const { appendTailSilence, STT_SAMPLES_PER_CHUNK } = active.audio;
    const tail = appendTailSilence();
    for (let offset = 0; offset < tail.length; offset += STT_SAMPLES_PER_CHUNK) {
      const pcm = tail.slice(offset, offset + STT_SAMPLES_PER_CHUNK);
      queueChunk({
        sequence: active.sequence++,
        pcm,
        durationMs: (pcm.length * 1000) / 16_000,
      });
    }
    if (activeRef.current === active && active.ready) {
      active.tailQueued = true;
      await finishProvider(active);
    } else if (activeRef.current === active) {
      active.tailQueued = true;
    }
  }, [abortActiveSession, fail, finishProvider, queueChunk, transport]);

  const onEvent = useCallback(
    (event: SttRuntimeEvent) => {
      const active = activeRef.current;
      if (!active || event.sessionId !== active.id) return;
      if (event.type === "ready") {
        window.clearTimeout(active.connectTimer);
        active.ready = true;
        // Silence must be measured from recognition start, not mic-open /
        // cloud-connect. Otherwise a slow handshake auto-stops immediately.
        active.capture.resetSilenceClock();
        if (!active.stopping) setState("recognizing");
        for (const chunk of active.fifo.drain()) sendChunk(chunk.sequence, chunk.pcm);
        if (active.stopping && active.tailQueued) void finishProvider(active);
      } else if (event.type === "partial") {
        active.lastText = event.text;
        composerRef.current?.updateTransientText(event.text);
      } else if (event.type === "final") {
        active.lastText = event.text;
        composerRef.current?.commitTransientText(event.text);
        cleanup(true);
        setState("idle");
      } else if (event.type === "error") {
        fail(event.message, "recognitionFailed");
      } else if (event.type === "closed") {
        if (!active.stopping) {
          fail(null, "connectionClosed");
        } else {
          cleanup(Boolean(active.lastText.trim()));
          setState("idle");
        }
      }
    },
    [cleanup, composerRef, fail, finishProvider, sendChunk],
  );

  const start = useCallback(async () => {
    if (!transport || !provider || disabled || activeRef.current) return;
    if (providerConfigured === false) {
      const message = t("chat.stt.error.providerIncomplete");
      setError(message);
      setState("error");
      if (onConfigurationRequired) onConfigurationRequired();
      else onError?.(message);
      return;
    }
    setError(null);
    setState("requesting-permission");
    if (!composerRef.current?.beginTransientText()) {
      const message = t("chat.stt.error.composerLocked");
      setState("error");
      setError(message);
      onError?.(message);
      return;
    }

    try {
      const [audio] = await Promise.all([loadSttAudio(), transport.requestPermission?.()]);
      const fifo = new audio.SttPcmFifo();
      const capture = new audio.SttAudioCapture({
        onChunk: (chunk) => queueChunk(chunk),
        onSilenceTimeout: () => {
          const current = activeRef.current;
          if (!current?.ready || current.stopping) return;
          void stop();
        },
        onCaptureError: (error) => fail(error, "microphoneStartFailed"),
      });
      const active: ActiveSttSession = {
        id: crypto.randomUUID(),
        audio,
        capture,
        fifo,
        ready: false,
        stopping: false,
        tailQueued: false,
        finishSent: false,
        lastText: "",
        sequence: 0,
        queue: Promise.resolve(),
        connectTimer: 0,
        finalTimer: null,
      };
      activeRef.current = active;

      // Capture starts before the cloud session opens so the first syllable is buffered.
      await capture.start();
      if (activeRef.current !== active) {
        await capture.stop();
        return;
      }
      setState("buffering");
      active.connectTimer = window.setTimeout(
        () => fail(null, "connectTimeout"),
        audio.STT_CONNECT_TIMEOUT_MS,
      );
      await transport.open({ sessionId: active.id, provider, onEvent });
    } catch (cause) {
      fail(cause, "startFailed");
    }
  }, [
    composerRef,
    disabled,
    fail,
    onError,
    onConfigurationRequired,
    onEvent,
    provider,
    providerConfigured,
    queueChunk,
    stop,
    t,
    transport,
  ]);

  const toggle = useCallback(() => (activeRef.current ? void stop() : void start()), [start, stop]);

  const sessionKeyRef = useRef(sessionKey);
  useLayoutEffect(() => {
    if (sessionKeyRef.current === sessionKey) return;
    sessionKeyRef.current = sessionKey;
    abortActiveSession();
  }, [abortActiveSession, sessionKey]);

  useLayoutEffect(() => {
    if (hidden) abortActiveSession();
  }, [abortActiveSession, hidden]);

  useEffect(
    () => () => {
      const active = activeRef.current;
      if (active) void transport?.cancel(active.id).catch(() => undefined);
      cleanup(Boolean(active?.lastText.trim()));
      transport?.dispose?.();
    },
    [cleanup, transport],
  );

  useEffect(() => {
    if ((disabled || !provider) && activeRef.current) void stop();
  }, [disabled, provider, stop]);

  return {
    state,
    error,
    toggle,
    active: state !== "idle" && state !== "error",
    available: Boolean(provider && transport),
  };
}
