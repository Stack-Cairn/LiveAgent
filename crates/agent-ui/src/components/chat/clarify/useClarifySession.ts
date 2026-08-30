// crates/agent-ui/src/components/chat/clarify/useClarifySession.ts
import { useCallback, useRef, useSyncExternalStore } from "react";
import {
  buildClarifyMessages,
  buildForceFinalInstruction,
  CLARIFY_MAX_QUESTIONS,
  parseClarifyTurn,
} from "./clarifyProtocol";
import type { ClarifyContext, ClarifyMessage, RunClarifyTurn } from "./clarifyTypes";

// 测试经本模块读取上限常量（单一事实来源仍在 clarifyProtocol）。
export { CLARIFY_MAX_QUESTIONS };

export type ClarifySessionStatus =
  | "idle"
  | "asking"
  | "awaitingInput"
  | "synthesizing"
  | "done"
  | "error";

export type ClarifySessionState = {
  status: ClarifySessionStatus;
  /** 面板可见消息（不含 system）。 */
  visibleMessages: ClarifyMessage[];
  /** 当轮流式文本（未解析，渲染时剥标记前缀）。 */
  streamingText: string;
  error: string | null;
  questionCount: number;
  finalText: string | null;
};

export const EMPTY_CLARIFY_SESSION_STATE: ClarifySessionState = {
  status: "idle",
  visibleMessages: [],
  streamingText: "",
  error: null,
  questionCount: 0,
  finalText: null,
};

export type ClarifySessionCore = {
  getState(): ClarifySessionState;
  /** 外部（React useSyncExternalStore）订阅状态变化；返回退订函数。 */
  subscribe(listener: () => void): () => void;
  start(draftText: string): Promise<void>;
  submitAnswer(text: string): Promise<void>;
  forceFinal(): Promise<void>;
  retry(): Promise<void>;
  close(): void;
};

/**
 * 澄清会话核心（框架无关，便于 node:test 直测）。React hook 只是把 core 的
 * state 镜像进 useSyncExternalStore。一次 start 对应一次会话；close 丢弃全部状态。
 */
export function createClarifySessionCore(
  runTurn: RunClarifyTurn,
  callbacks: { onFinal: (text: string) => void },
  getContext?: () => ClarifyContext | undefined,
): ClarifySessionCore {
  let state: ClarifySessionState = { ...EMPTY_CLARIFY_SESSION_STATE };
  let sessionMessages: ClarifyMessage[] = [];
  let questionCount = 0;
  let controller: AbortController | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };

  const setState = (patch: Partial<ClarifySessionState>) => {
    state = { ...state, ...patch };
    emit();
  };

  const ask = async (extraUser?: ClarifyMessage) => {
    if (extraUser) sessionMessages.push(extraUser);
    controller = new AbortController();
    setState({ status: "asking", streamingText: "", error: null });
    try {
      // context 用 getter 取：宿主切工作区后无需重建 core（设计文档「上下文感知」）。
      const raw = await runTurn(
        buildClarifyMessages(sessionMessages, getContext?.()),
        controller.signal,
        (delta) => setState({ streamingText: state.streamingText + delta }),
      );
      const parsed = parseClarifyTurn(raw);
      if (parsed.kind === "final") {
        setState({ status: "synthesizing", streamingText: "" });
        sessionMessages.push({ role: "assistant", content: raw });
        setState({
          status: "done",
          finalText: parsed.text,
          visibleMessages: sessionMessages.slice(),
        });
        callbacks.onFinal(parsed.text);
        return;
      }
      questionCount += 1;
      sessionMessages.push({ role: "assistant", content: raw });
      setState({
        status: "awaitingInput",
        streamingText: "",
        questionCount,
        visibleMessages: sessionMessages.slice(),
      });
    } catch (error) {
      // 用户取消走 close()，不产生 error 态；此处只兜网络/模型错误。
      setState({ status: "error", error: error instanceof Error ? error.message : String(error) });
    } finally {
      controller = null;
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(draftText) {
      sessionMessages = [{ role: "user", content: draftText }];
      questionCount = 0;
      setState({
        ...EMPTY_CLARIFY_SESSION_STATE,
        visibleMessages: sessionMessages.slice(),
      });
      return ask();
    },
    submitAnswer(text) {
      sessionMessages.push({ role: "user", content: text });
      setState({ visibleMessages: sessionMessages.slice() });
      if (questionCount >= CLARIFY_MAX_QUESTIONS) {
        // 硬上限：不再放行提问，直接注入终稿指令（设计文档「错误处理」）。
        return ask({ role: "user", content: buildForceFinalInstruction() });
      }
      return ask();
    },
    forceFinal() {
      return ask({ role: "user", content: buildForceFinalInstruction() });
    },
    retry() {
      // 失败重试重发当前轮：把最后一条 assistant 之外的尾巴原样再发一次。
      const last = sessionMessages.at(-1);
      if (last?.role === "user" && state.status === "error") {
        const retryTail = last;
        sessionMessages.pop();
        return ask(retryTail);
      }
      return Promise.resolve();
    },
    close() {
      controller?.abort();
      controller = null;
      sessionMessages = [];
      questionCount = 0;
      state = { ...EMPTY_CLARIFY_SESSION_STATE };
      emit();
    },
  };
}

/** React 包装：useSyncExternalStore 镜像 core 状态；runTurn/callbacks/context 经 ref 保持最新。 */
export function useClarifySession(
  runTurn: RunClarifyTurn,
  clarifyContext: ClarifyContext | undefined,
  callbacks: { onFinal: (text: string) => void },
): {
  state: ClarifySessionState;
  start: (draftText: string) => void;
  submitAnswer: (text: string) => void;
  forceFinal: () => void;
  retry: () => void;
  close: () => void;
} {
  // 每次渲染刷新 ref：core 闭包里永远读到最新的宿主回调，core 本体不必重建。
  const runTurnRef = useRef(runTurn);
  runTurnRef.current = runTurn;
  const contextRef = useRef(clarifyContext);
  contextRef.current = clarifyContext;
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  // core 只创建一次：换 identity 会导致订阅丢失与在途会话断裂。
  const coreRef = useRef<ClarifySessionCore | null>(null);
  if (!coreRef.current) {
    coreRef.current = createClarifySessionCore(
      (messages, signal, onDelta) => runTurnRef.current(messages, signal, onDelta),
      { onFinal: (text) => callbacksRef.current.onFinal(text) },
      () => contextRef.current,
    );
  }
  const core = coreRef.current;

  // subscribe 必须引用稳定，否则 useSyncExternalStore 每渲染重订阅。
  const subscribe = useCallback((listener: () => void) => core.subscribe(listener), [core]);
  const state = useSyncExternalStore(subscribe, core.getState);

  // 动作返回 void：错误已由 core 落进 state.error，Promise 无需调用方续接。
  const start = useCallback((draftText: string) => void core.start(draftText), [core]);
  const submitAnswer = useCallback((text: string) => void core.submitAnswer(text), [core]);
  const forceFinal = useCallback(() => void core.forceFinal(), [core]);
  const retry = useCallback(() => void core.retry(), [core]);
  const close = useCallback(() => core.close(), [core]);

  return { state, start, submitAnswer, forceFinal, retry, close };
}
