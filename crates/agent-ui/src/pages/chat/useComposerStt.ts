import type { SttProviderId } from "@liveagent/app/lib/settings";
import type { MentionComposerHandle } from "@liveagent/ui/components/chat/MentionComposer";
import { errorMessageWithFallback } from "@liveagent/ui/lib/shared/value";
import {
  appendTailSilence,
  type PcmChunk,
  pcm16ToLittleEndianBytes,
  STT_CONNECT_TIMEOUT_MS,
  STT_SAMPLES_PER_CHUNK,
  SttAudioCapture,
  SttPcmFifo,
} from "@liveagent/ui/lib/stt/audio";
import type { SttRuntimeEvent, SttTransport, SttUiState } from "@liveagent/ui/lib/stt/types";
import type { MutableRefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

type ActiveSttSession = {
  id: string;
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
  /** 错误上报回调（如麦克风不可用）；由宿主决定展示方式（toast 等）。 */
  onError?: (message: string) => void;
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
    (message: string, expectedSessionId?: string) => {
      const active = activeRef.current;
      if (expectedSessionId && active?.id !== expectedSessionId) return;
      if (active) void transport?.cancel(active.id).catch(() => undefined);
      const preserve = Boolean(active?.lastText.trim());
      cleanup(preserve);
      setError(message);
      setState("error");
      onError?.(message);
    },
    [cleanup, onError, transport],
  );

  const sendChunk = useCallback(
    (sequence: number, pcm: Int16Array) => {
      const active = activeRef.current;
      if (!active || !transport) return;
      const sessionId = active.id;
      active.queue = active.queue
        .then(() => transport.sendAudio(sessionId, sequence, pcm16ToLittleEndianBytes(pcm)))
        .catch((cause) => {
          fail(errorMessageWithFallback(cause, "发送语音数据失败"), sessionId);
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
        fail("云连接超时，语音缓存已达到 10 秒上限");
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
      await active.queue;
      if (activeRef.current !== active) return;
      try {
        await transport.stop(active.id);
        active.finalTimer = window.setTimeout(
          () => fail("识别结束超时，已保留最后转写内容"),
          5_000,
        );
      } catch (cause) {
        fail(errorMessageWithFallback(cause, "停止识别失败"));
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
    if (!active || active.stopping || !transport) return;
    active.stopping = true;
    setState("stopping");

    // stop() flushes the final real-audio fragment before the fixed tail.
    try {
      await active.capture.stop();
    } catch (cause) {
      fail(errorMessageWithFallback(cause, "停止麦克风失败"));
      return;
    }
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
  }, [fail, finishProvider, queueChunk, transport]);

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
        fail(event.message || "语音识别失败");
      } else if (event.type === "closed") {
        if (!active.stopping) {
          fail("语音识别连接意外关闭");
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
      const message = "STT供应商配置不完整";
      setError(message);
      setState("error");
      onError?.(message);
      return;
    }
    setError(null);
    setState("requesting-permission");
    if (!composerRef.current?.beginTransientText()) {
      setState("error");
      setError("无法锁定当前输入位置");
      onError?.("无法锁定当前输入位置");
      return;
    }

    try {
      await transport.requestPermission?.();
      const fifo = new SttPcmFifo();
      const capture = new SttAudioCapture({
        onChunk: (chunk) => queueChunk(chunk),
        onSilenceTimeout: () => {
          const current = activeRef.current;
          if (!current?.ready || current.stopping) return;
          void stop();
        },
        onCaptureError: (message) => fail(message),
      });
      const active: ActiveSttSession = {
        id: crypto.randomUUID(),
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
      active.connectTimer = window.setTimeout(() => fail("云端连接超时"), STT_CONNECT_TIMEOUT_MS);
      await transport.open({ sessionId: active.id, provider, onEvent });
    } catch (cause) {
      fail(errorMessageWithFallback(cause, "无法启动语音识别"));
    }
  }, [
    composerRef,
    disabled,
    fail,
    onError,
    onEvent,
    provider,
    providerConfigured,
    queueChunk,
    stop,
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
