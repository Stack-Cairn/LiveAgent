// crates/agent-ui/src/components/chat/clarify/useClarifySession.ts
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  buildClarifyAnswersMessage,
  buildClarifyMessages,
  CLARIFY_FORCE_FINAL_INSTRUCTION,
  CLARIFY_MAX_ROUNDS,
  clarifyStreamPreview,
  parseClarifyTurn,
} from "./clarifyProtocol";
import type {
  ClarifyAnswer,
  ClarifyContext,
  ClarifyMessage,
  ClarifyRound,
  RunClarifyTurn,
} from "./clarifyTypes";

// 测试经本模块读取上限常量（单一事实来源仍在 clarifyProtocol）。
export { CLARIFY_MAX_ROUNDS };

export type ClarifySessionStatus = "idle" | "asking" | "awaitingInput" | "done" | "error";

export type ClarifySessionState = {
  status: ClarifySessionStatus;
  /** 会话起点的用户草稿（面板头部引用展示）。 */
  draftText: string;
  /** 问答轮次。末轮 answers === null 即当前待作答的问题组。 */
  rounds: ClarifyRound[];
  /** 终稿轮的流式预览文本（问题轮流的是 JSON，恒为空串）。 */
  streamingText: string;
  error: string | null;
  roundCount: number;
  finalText: string | null;
};

export const EMPTY_CLARIFY_SESSION_STATE: ClarifySessionState = {
  status: "idle",
  draftText: "",
  rounds: [],
  streamingText: "",
  error: null,
  roundCount: 0,
  finalText: null,
};

export type ClarifySessionCore = {
  getState(): ClarifySessionState;
  /** 外部（React useSyncExternalStore）订阅状态变化；返回退订函数。 */
  subscribe(listener: () => void): () => void;
  start(draftText: string): Promise<void>;
  /** 提交当前轮全部应答；模型据此决定追问下一轮或直接产出终稿。 */
  submitAnswers(answers: ClarifyAnswer[]): Promise<void>;
  /** 就按已有回答（含当前轮的部分选择）直接生成终稿，不再等待剩余问题。 */
  generateNow(answers?: ClarifyAnswer[]): Promise<void>;
  retry(): Promise<void>;
  close(): void;
};

/** 应答里至少有一题真的给了内容（选了选项或写了自由文本）。 */
function hasAnsweredContent(answers: ClarifyAnswer[]): boolean {
  return answers.some(
    (answer) => answer.selectedLabels.length > 0 || (answer.customText?.trim().length ?? 0) > 0,
  );
}

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
  let rounds: ClarifyRound[] = [];
  let roundCount = 0;
  let controller: AbortController | null = null;
  // 会话代际：start()/close() 各递增一次。在途 ask() 捕获进入时的代际，
  // 之后任何 await 回来先比对——代际变了说明会话已被重置/替换，迟到结果一律丢弃。
  // 这同时覆盖了「close 后迟到的 reject 把 idle 态写成 error」和
  // 「close 后 start(new)，旧请求的成功结果污染新会话消息」两类竞态。
  let epoch = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };

  const setState = (patch: Partial<ClarifySessionState>) => {
    state = { ...state, ...patch };
    emit();
  };

  /** 把待作答的末轮落定为已应答；无待作答轮时是空操作。 */
  const settlePendingRound = (answers: ClarifyAnswer[]): ClarifyRound | null => {
    const pending = rounds.at(-1);
    if (!pending || pending.answers !== null) return null;
    const settled: ClarifyRound = { ...pending, answers };
    rounds = [...rounds.slice(0, -1), settled];
    return settled;
  };

  const ask = async (extraUser?: ClarifyMessage) => {
    // 任何新轮次（start/submitAnswers/generateNow/retry）都作废在途旧轮：
    // 代际 +1 在先，再中止旧 controller。旧 ask 的迟到 delta/完成/失败
    // 全部被下方代际闸门静默丢弃（abort 类错误尤其不得落 error 态）。
    epoch += 1;
    controller?.abort();
    controller = null;
    if (extraUser) sessionMessages.push(extraUser);
    const localController = new AbortController();
    controller = localController;
    const currentEpoch = epoch;
    setState({ status: "asking", streamingText: "", error: null, rounds: rounds.slice() });
    // 流式预览不是逐段拼接稳定的（标记/JSON 前缀要整体判定），
    // 单独累积原始文本、每次全量重算预览。
    let streamedRaw = "";
    let raw: string;
    try {
      // context 用 getter 取：宿主切工作区后无需重建 core（设计文档「上下文感知」）。
      raw = await runTurn(
        buildClarifyMessages(sessionMessages, getContext?.()),
        localController.signal,
        (delta) => {
          // 仅当前代际且仍处 asking 态才累积：turn 结束或会话被重置后
          // 迟到的 delta 不得写入已清空/已提交的 streamingText。
          if (epoch !== currentEpoch || state.status !== "asking") return;
          streamedRaw += delta;
          const preview = clarifyStreamPreview(streamedRaw);
          if (preview !== state.streamingText) setState({ streamingText: preview });
        },
      );
    } catch (error) {
      // 会话已被 close()/start() 丢弃：旧请求的失败（包括 abort）不属于当前会话，
      // 不落 error 态——否则会把刚重置的 idle/新会话翻成 error。
      if (epoch !== currentEpoch) return;
      // 同一代际内的失败才是真正的网络/模型错误；error 态不得残留半截流文本。
      setState({
        status: "error",
        streamingText: "",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    } finally {
      // 只有自己仍是当前 controller 时才清引用：避免迟到的旧 ask 清掉新 ask 的 controller。
      if (controller === localController) controller = null;
    }
    // 成功结果同样要先过代际闸门，再解析/写消息。
    if (epoch !== currentEpoch) return;
    const parsed = parseClarifyTurn(raw);
    sessionMessages.push({ role: "assistant", content: raw });
    if (parsed.kind === "final") {
      setState({
        status: "done",
        streamingText: "",
        finalText: parsed.text,
        rounds: rounds.slice(),
      });
      // 宿主回调放在状态提交为 done 之后、且包住异常：宿主副作用抛错
      // 不应把已落定的 done 态翻回 error，也不应让 start() 的 Promise reject。
      try {
        callbacks.onFinal(parsed.text);
      } catch {
        // 吞掉宿主回调异常：状态机对外只认会话自身的错误。
      }
      return;
    }
    roundCount += 1;
    rounds = [...rounds, { questions: parsed.questions, answers: null }];
    setState({
      status: "awaitingInput",
      streamingText: "",
      roundCount,
      rounds: rounds.slice(),
    });
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(draftText) {
      // 新会话重置消息与轮次；代际递增与在途请求中止统一由 ask() 负责。
      sessionMessages = [{ role: "user", content: draftText }];
      rounds = [];
      roundCount = 0;
      setState({ ...EMPTY_CLARIFY_SESSION_STATE, draftText });
      return ask();
    },
    submitAnswers(answers) {
      // 只有等待作答时才接受提交：done 后不得重开轮次/二次 onFinal，
      // asking 中的提交属于 UI 不可达路径，一并挡掉。
      if (state.status !== "awaitingInput") return Promise.resolve();
      const settled = settlePendingRound(answers);
      if (!settled) return Promise.resolve();
      const answersMessage: ClarifyMessage = {
        role: "user",
        content: buildClarifyAnswersMessage(settled),
      };
      if (roundCount >= CLARIFY_MAX_ROUNDS) {
        // 硬上限：不再放行提问，答案连同终稿指令一起送出（设计文档「错误处理」）。
        sessionMessages.push(answersMessage);
        return ask({ role: "user", content: CLARIFY_FORCE_FINAL_INSTRUCTION });
      }
      return ask(answersMessage);
    },
    generateNow(answers) {
      // done 之后强制终稿是空操作：终稿已落定，不重开轮次。
      if (state.status === "done") return Promise.resolve();
      if (state.status === "awaitingInput") {
        const settled = settlePendingRound(answers ?? []);
        // 当前轮已选的部分回答一并入档；全空就不给模型添噪声消息。
        if (settled && hasAnsweredContent(settled.answers ?? [])) {
          sessionMessages.push({ role: "user", content: buildClarifyAnswersMessage(settled) });
        }
      }
      return ask({ role: "user", content: CLARIFY_FORCE_FINAL_INSTRUCTION });
    },
    retry() {
      // 仅 error 态可重试：失败的轮次里 sessionMessages 尾部正是那轮的
      // user 输入，直接原样重发即可（pop 再 push 同一条是恒等变换，不做）。
      if (state.status !== "error") return Promise.resolve();
      return ask();
    },
    close() {
      // 代际 +1 在先：在途 ask 的迟到结果（成功或失败）全部作废，
      // 不得写入刚清空的 sessionMessages / 复活幽灵 awaitingInput 会话。
      epoch += 1;
      controller?.abort();
      controller = null;
      sessionMessages = [];
      rounds = [];
      roundCount = 0;
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
  submitAnswers: (answers: ClarifyAnswer[]) => void;
  generateNow: (answers?: ClarifyAnswer[]) => void;
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
  const submitAnswers = useCallback(
    (answers: ClarifyAnswer[]) => void core.submitAnswers(answers),
    [core],
  );
  const generateNow = useCallback(
    (answers?: ClarifyAnswer[]) => void core.generateNow(answers),
    [core],
  );
  const retry = useCallback(() => void core.retry(), [core]);
  const close = useCallback(() => core.close(), [core]);

  // 卸载即丢弃：宿主（ChatComposerBar）已在 close()/切会话路径显式关会话，
  // 这里兜底纯卸载路径（视图切换等组件直接消失）——core.close() 里的
  // AbortController 贯穿到在途请求（设计文档「错误处理」）。依赖数组留空：
  // coreRef 是稳定的 ref，cleanup 只在卸载时执行一次。
  useEffect(() => {
    return () => coreRef.current?.close();
  }, []);

  return { state, start, submitAnswers, generateNow, retry, close };
}
