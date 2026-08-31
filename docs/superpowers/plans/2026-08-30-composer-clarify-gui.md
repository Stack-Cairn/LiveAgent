# 输入框提示词澄清 · 计划 1：agent-ui 共享组件 + 桌面 GUI 接线 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在聊天输入框旁提供「澄清」按钮：LLM 小对话持续追问用户澄清需求，产出优化后的提示词放回输入框（只替换文本段，附件与提及保留）。

**Architecture:** agent-ui 新增 `components/chat/clarify/` 模块（类型 + 协议解析 + 状态机 + 面板组件）；`ChatComposerBar` 通过新增可选 props `runClarifyTurn` / `clarifyContext` 注入 LLM 执行器，缺省不渲染按钮；桌面宿主（`ChatPage.tsx` 的 composer binding）包装现有 `streamAssistantMessage` 纯文本调用。Web（agent-gateway）接线是独立的计划 2，本计划不做。

**Tech Stack:** TypeScript / React（无新依赖）、`@earendil-works/pi-ai` Context 类型、`node:test`（经 `crates/agent-gui/test/helpers/load-ts-module.mjs` 的 TS 加载器）。

**Spec:** `docs/superpowers/specs/2026-08-30-composer-clarify-design.md`

## Global Constraints

- 终稿协议标记：`[CLARIFY_QUESTION]` / `[CLARIFY_FINAL]`，单行置于回复开头（spec「终稿协议」节）。
- 最多 5 轮提问；第 6 轮起前端自动注入终稿指令（spec「错误处理」表）。
- 产物落框：只替换草稿 `type: "text"` 段，其余 segment 与 pendingUploadedFiles 原样保留（spec「终稿落框」）。
- i18n：所有 UI 文案走 `chat.clarify.*` 键，`zhCNCommon.ts` 与 `enUSCommon.ts` 两份（spec「i18n」）。
- 澄清会话不持久化、不进会话历史；面板关闭即丢弃（spec「错误处理」表）。
- 面板打开期间发送按钮禁用（`handleComposerSend` 守卫），输入框本体仍可编辑。
- 测试用 `node:test` + `createTsModuleLoader`，放 `crates/agent-gui/test/chat/`，不新建测试框架（spec「测试」）。
- 代码注释风格跟随周边：中文注释、说明「为什么」。

## 现有代码事实（实施者必读）

- `MentionComposerHandle`（`crates/agent-ui/src/components/chat/MentionComposerModel.ts:104`）：`getDraft()` 返回 `MentionComposerDraft`（`segments: MentionComposerDraftSegment[]`，segment 判别字段 `type: "text" | "fileMention" | ...`）；`setDraft(draft)` 会清空编辑器并按 `draft.segments` 逐个重建 DOM（`MentionComposer.tsx:806`），stale 的派生字段（text/mentions 数组）会被忽略；`focus()`。
- `streamAssistantMessage`（`crates/agent-gui/src/lib/providers/runtime/textOnlyRuntime.ts:183`）：参数 `providerId / model / runtime / context {systemPrompt, messages:[{role,content,timestamp}]} / signal / onTextDelta / cacheRetention / nativeWebSearch`；返回 assistant message，用 `assistantMessageToText`（`crates/agent-gui/src/lib/providers/llm.ts`）转纯文本。调用范式见 `conversationTitleJob.ts`。
- 模型解析：`resolveEffectiveChatModelSelection({ settings, conversationSelectedModel })`（`crates/agent-gui/src/pages/chat/runtime/modelSelection.ts:28`）返回 `{ provider, providerId, model }`；runtime 构造用 `createProviderRuntimeConfig(provider, model, runtimeControls)`（`crates/agent-gui/src/lib/providers/llm.ts`）。
- `ChatComposerBar`（`crates/agent-ui/src/pages/chat/ChatComposerBar.tsx:313`）底部工具行在 `ChatComposerBar.tsx:1010`：`<div className="relative flex items-center justify-between gap-2 px-3 pb-2 pt-1">`，左侧 cluster `<div className="flex min-w-0 flex-1 items-center gap-1">`（1011 行起：加号菜单 → 计划模式 pill → STT 按钮）。面板（队列/审批栏）插在 `glassCardRef` 卡片（887 行起）之外、其上方——`approvalBar` 渲染于 885 行。编辑器容器在 980 行。
- GUI 宿主 composer binding：`crates/agent-gui/src/pages/ChatPage.tsx:2988` 的 `composer: {...}` 对象；`ConversationComposerBindings`（`ConversationPaneHostEnvironment.tsx:25`）是 `Omit<ChatComposerBarProps, ...>`，新增 props 自动透传，无需改该文件。
- 图标：`crates/agent-ui/src/components/IconSet.tsx` 已导出 `WandSparkles`（621 行）、`Loader2` 等，lucide `~icons` 直接 import 也可。
- i18n：`crates/agent-ui/src/i18n/translations/zhCNCommon.ts` / `enUSCommon.ts` 扁平键（如 `"chat.queue.title": "等待队列 {count}"`）。
- 测试：`crates/agent-gui/test/` 下 `.mjs`，`import test from "node:test"` + `createTsModuleLoader`（见 `test/providers/text-only-failover.test.mjs` 头部），运行 `cd crates/agent-gui && npm test`（`scripts/run-node-tests.mjs test`）。
- 类型检查：`cd crates/agent-gui && npx tsc --noEmit`（agent-ui 无独立 tsconfig 引用链时的实际命令以仓库现状为准，缺省用 GUI 侧的 tsc）。

---

### Task 1: clarifyTypes + clarifyProtocol（标记解析 + 系统提示词）

**Files:**
- Create: `crates/agent-ui/src/components/chat/clarify/clarifyTypes.ts`
- Create: `crates/agent-ui/src/components/chat/clarify/clarifyProtocol.ts`
- Test: `crates/agent-gui/test/chat/clarify-protocol.test.mjs`

**Interfaces:**
- Consumes: 无（首个任务）。
- Produces（后续任务依赖的确切签名）:
  - `type ClarifyMessage = { role: "user" | "assistant" | "system"; content: string }`
  - `type ClarifyContext = { workdir: string; gitBranch?: string }`
  - `type RunClarifyTurn = (messages: ClarifyMessage[], signal: AbortSignal, onTextDelta?: (delta: string) => void) => Promise<string>`（返回完整回复文本）
  - `const CLARIFY_QUESTION_MARKER = "[CLARIFY_QUESTION]"`；`const CLARIFY_FINAL_MARKER = "[CLARIFY_FINAL]"`；`const CLARIFY_MAX_QUESTIONS = 5`
  - `parseClarifyTurn(raw: string): { kind: "question" | "final"; text: string }`
  - `stripLeadingMarker(partial: string): string`（流式显示用）
  - `buildClarifySystemPrompt(context?: ClarifyContext): string`
  - `buildForceFinalInstruction(): string`
  - `buildClarifyMessages(sessionMessages: ClarifyMessage[], context?: ClarifyContext): ClarifyMessage[]`（前置 system 消息）

- [ ] **Step 1: 写失败测试**

```js
// crates/agent-gui/test/chat/clarify-protocol.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);
const loader = createTsModuleLoader({ mocks: {} });
const protocol = await loader.import(
  abs("../agent-ui/src/components/chat/clarify/clarifyProtocol.ts"),
);

test("question marker parses", () => {
  const r = protocol.parseClarifyTurn("[CLARIFY_QUESTION]\n要做什么功能？");
  assert.equal(r.kind, "question");
  assert.equal(r.text, "要做什么功能？");
});

test("final marker parses", () => {
  const r = protocol.parseClarifyTurn("[CLARIFY_FINAL]\n优化后的提示词正文");
  assert.equal(r.kind, "final");
  assert.equal(r.text, "优化后的提示词正文");
});

test("no marker falls back to question", () => {
  const r = protocol.parseClarifyTurn("直接一句没有标记的话");
  assert.equal(r.kind, "question");
  assert.equal(r.text, "直接一句没有标记的话");
});

test("marker after body text still recognized", () => {
  const r = protocol.parseClarifyTurn("[CLARIFY_FINAL]\n\n  带空行的终稿  ");
  assert.equal(r.kind, "final");
  assert.equal(r.text, "带空行的终稿");
});

test("stripLeadingMarker hides complete and partial markers during streaming", () => {
  assert.equal(protocol.stripLeadingMarker("[CLARIFY_QUE"), "");
  assert.equal(protocol.stripLeadingMarker("[CLARIFY_QUESTION]\n问题正文"), "问题正文");
  assert.equal(protocol.stripLeadingMarker("普通文本"), "普通文本");
});

test("system prompt contains workspace context and rules", () => {
  const p = protocol.buildClarifySystemPrompt({ workdir: "/repo/x", gitBranch: "main" });
  assert.match(p, /\/repo\/x/);
  assert.match(p, /main/);
  assert.match(p, /一次只问一个问题/);
  const bare = protocol.buildClarifySystemPrompt();
  assert.doesNotMatch(bare, /workdir/i);
});

test("buildClarifyMessages prepends system", () => {
  const msgs = protocol.buildClarifyMessages(
    [{ role: "user", content: "hi" }],
    { workdir: "/w" },
  );
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs.length, 2);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd crates/agent-gui && npm test -- test/chat/clarify-protocol.test.mjs`
Expected: FAIL（模块不存在 / import 报错）

- [ ] **Step 3: 实现**

```ts
// crates/agent-ui/src/components/chat/clarify/clarifyTypes.ts
/** 澄清小对话的消息。与 pi-ai Context 的 messages 同构，但独立于会话运行时。 */
export type ClarifyMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

/** 轻量工作区信息：只喂路径/分支，不含文件内容（见设计文档「上下文感知」）。 */
export type ClarifyContext = {
  workdir: string;
  gitBranch?: string;
};

/**
 * 执行一轮澄清补全。messages 含 system；返回完整回复文本（已由宿主拼装）。
 * onTextDelta 用于面板流式上屏；signal 由状态机贯穿取消。
 */
export type RunClarifyTurn = (
  messages: ClarifyMessage[],
  signal: AbortSignal,
  onTextDelta?: (delta: string) => void,
) => Promise<string>;
```

```ts
// crates/agent-ui/src/components/chat/clarify/clarifyProtocol.ts
import type { ClarifyContext, ClarifyMessage } from "./clarifyTypes";

export const CLARIFY_QUESTION_MARKER = "[CLARIFY_QUESTION]";
export const CLARIFY_FINAL_MARKER = "[CLARIFY_FINAL]";
/** 超过硬上限后前端强制注入终稿指令，防止 LLM 无限提问（设计文档「错误处理」）。 */
export const CLARIFY_MAX_QUESTIONS = 5;

export type ParsedClarifyTurn = { kind: "question" | "final"; text: string };

/** 完整回复解析：识别首行标记；无标记整体当 question 兜底。 */
export function parseClarifyTurn(raw: string): ParsedClarifyTurn {
  const value = raw ?? "";
  for (const [marker, kind] of [
    [CLARIFY_FINAL_MARKER, "final"],
    [CLARIFY_QUESTION_MARKER, "question"],
  ] as const) {
    if (value.startsWith(marker)) {
      return { kind, text: value.slice(marker.length).trim() };
    }
  }
  return { kind: "question", text: value.trim() };
}

/**
 * 流式显示用：剥掉开头已到/未到的标记前缀。流首 token 往往劈在标记中间，
 * 前 20 个字符在凑齐标记（或确认不是标记）之前一律隐藏。
 */
export function stripLeadingMarker(partial: string): string {
  const value = partial ?? "";
  if (value.startsWith(CLARIFY_FINAL_MARKER)) {
    return value.slice(CLARIFY_FINAL_MARKER.length).replace(/^\s+/, "");
  }
  if (value.startsWith(CLARIFY_QUESTION_MARKER)) {
    return value.slice(CLARIFY_QUESTION_MARKER.length).replace(/^\s+/, "");
  }
  // 尚未排除标记可能性：标记最长 16 字符，前缀不足 16 字符且每个字符都
  // 与某一标记前缀一致时先隐藏，避免标记碎片闪现在气泡里。
  const prefixWindow = value.slice(0, CLARIFY_QUESTION_MARKER.length);
  const couldBeMarker =
    CLARIFY_QUESTION_MARKER.startsWith(prefixWindow) ||
    CLARIFY_FINAL_MARKER.startsWith(prefixWindow);
  if (couldBeMarker && prefixWindow.length < CLARIFY_QUESTION_MARKER.length) {
    return "";
  }
  return value;
}

/** 从 superpowers brainstorming 技能拆编：一次一问、聚焦目的/约束/成功标准。 */
export function buildClarifySystemPrompt(context?: ClarifyContext): string {
  const workspace = context?.workdir?.trim();
  const branch = context?.gitBranch?.trim();
  const workspaceLines = workspace
    ? [`Workspace: ${workspace}${branch ? ` (branch: ${branch})` : ""}`]
    : [];
  return [
    "You are a prompt clarification assistant. The user gives a rough draft prompt; your job is to turn it into a well-specified, directly executable prompt through a short conversation.",
    "",
    "Rules:",
    `- Ask exactly ONE question per reply. Start every reply with the line "${CLARIFY_QUESTION_MARKER}".`,
    `- Prefer 2-4 concrete options the user can pick from (e.g. "A) ... B) ... C) ..."), or an open question when options would mislead.`,
    "  You may ask the user to choose \"Other\" and type freely.",
    "- Focus on: purpose (what outcome they want), constraints (tech/scope/style), and success criteria (what \"done\" looks like).",
    "- Never re-ask what the draft already makes clear. At most 5 questions total.",
    "- When the requirement is clear enough (or you have asked 5 questions), stop asking: start your reply with the line",
    `  "${CLARIFY_FINAL_MARKER}" and write the full optimized prompt. The final prompt must be a single ready-to-send message in the user's language, incorporating every answer given so far. Do not add explanations around it.`,
    "- Always reply in the language of the user's draft.",
    ...workspaceLines,
  ].join("\n");
}

/** 「直接生成」/轮数超限时注入的用户指令：绕过剩余提问直接出终稿。 */
export function buildForceFinalInstruction(): string {
  return "直接给出最终优化后的提示词（以 " + CLARIFY_FINAL_MARKER + " 开头），不要再提问。";
}

/** 完整 LLM 输入：system 前置 + 会话消息。 */
export function buildClarifyMessages(
  sessionMessages: ClarifyMessage[],
  context?: ClarifyContext,
): ClarifyMessage[] {
  return [{ role: "system", content: buildClarifySystemPrompt(context) }, ...sessionMessages];
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd crates/agent-gui && npm test -- test/chat/clarify-protocol.test.mjs`
Expected: PASS（全部 7 个用例）

- [ ] **Step 5: Commit**

```bash
git add crates/agent-ui/src/components/chat/clarify/ crates/agent-gui/test/chat/clarify-protocol.test.mjs
git commit -m "feat(clarify): add protocol parsing and system prompt for composer clarify"
```

---

### Task 2: useClarifySession 状态机

**Files:**
- Create: `crates/agent-ui/src/components/chat/clarify/useClarifySession.ts`
- Test: `crates/agent-gui/test/chat/clarify-session.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `ClarifyMessage`、`RunClarifyTurn`、`parseClarifyTurn`、`buildClarifyMessages`、`buildForceFinalInstruction`、`CLARIFY_MAX_QUESTIONS`。
- Produces:
  - `type ClarifySessionStatus = "idle" | "asking" | "awaitingInput" | "synthesizing" | "done" | "error"`
  - `type ClarifySessionState = { status; visibleMessages: ClarifyMessage[]; streamingText: string; error: string | null; questionCount: number; finalText: string | null }`
  - `useClarifySession(runTurn: RunClarifyTurn, clarifyContext: ClarifyContext | undefined, callbacks: { onFinal: (text: string) => void }): { state; start(draftText: string): void; submitAnswer(text: string): void; forceFinal(): void; retry(): void; close(): void }`

- [ ] **Step 1: 写失败测试**

```js
// crates/agent-gui/test/chat/clarify-session.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);

// React mock：hook 只用 useState/useRef/useCallback/useEffect，全部可空实现。
const reactMock = {
  useState: (initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useEffect: (fn) => (fn(), () => {}),
};
const loader = createTsModuleLoader({
  mocks: { [abs("react")]: reactMock },
});
const mod = await loader.import(
  abs("../agent-ui/src/components/chat/clarify/useClarifySession.ts"),
);
const protocol = await loader.import(
  abs("../agent-ui/src/components/chat/clarify/clarifyProtocol.ts"),
);

const QUESTION = "[CLARIFY_QUESTION]\n要做什么功能？";
const FINAL = "[CLARIFY_FINAL]\n优化后的提示词";

test("happy path: question then final", async () => {
  const seenInputs = [];
  const runTurn = async (messages, _signal, onDelta) => {
    seenInputs.push(messages);
    if (onDelta) onDelta(QUESTION.slice(0, 10));
    return seenInputs.length === 1 ? QUESTION : FINAL;
  };
  const finals = [];
  const session = mod.createClarifySessionCore(runTurn, { onFinal: (t) => finals.push(t) });
  await session.start("帮我写个脚本");
  assert.equal(session.getState().status, "awaitingInput");
  assert.equal(session.getState().questionCount, 1);
  await session.submitAnswer("批量改文件名");
  assert.equal(session.getState().status, "done");
  assert.deepEqual(finals, ["优化后的提示词"]);
  // 第二轮输入应包含第一轮问答 + system
  const second = seenInputs[1];
  assert.equal(second[0].role, "system");
  assert.equal(second.filter((m) => m.role === "assistant").length, 1);
});

test("exceeding max questions force-injects final instruction", async () => {
  let calls = 0;
  const runTurn = async (messages) => {
    calls += 1;
    if (messages.at(-1).content.includes("CLARIFY_FINAL")) {
      return FINAL; // 已是强制指令轮
    }
    return QUESTION;
  };
  const session = mod.createClarifySessionCore(runTurn, { onFinal: () => {} });
  await session.start("draft");
  for (let i = 0; i < mod.CLARIFY_MAX_QUESTIONS; i++) {
    await session.submitAnswer(`a${i}`);
  }
  // 第 6 轮：不追加提问，直接强制终稿
  assert.equal(session.getState().status, "done");
  assert.ok(calls <= mod.CLARIFY_MAX_QUESTIONS + 1);
});

test("forceFinal injects instruction and produces final", async () => {
  const runTurn = async (messages) =>
    messages.at(-1).content.includes("CLARIFY_FINAL") ? FINAL : QUESTION;
  const finals = [];
  const session = mod.createClarifySessionCore(runTurn, { onFinal: (t) => finals.push(t) });
  await session.start("d");
  await session.forceFinal();
  assert.deepEqual(finals, ["优化后的提示词"]);
});

test("error state keeps messages; retry resends", async () => {
  let fail = true;
  const runTurn = async () => {
    if (fail) throw new Error("boom");
    return FINAL;
  };
  const finals = [];
  const session = mod.createClarifySessionCore(runTurn, { onFinal: (t) => finals.push(t) });
  await session.start("d");
  assert.equal(session.getState().status, "error");
  assert.match(session.getState().error, /boom/);
  fail = false;
  await session.retry();
  assert.equal(session.getState().status, "done");
  assert.deepEqual(finals, ["优化后的提示词"]);
});

test("unmarked reply falls back to question", async () => {
  const runTurn = async () => "没有标记的一句话";
  const session = mod.createClarifySessionCore(runTurn, { onFinal: () => {} });
  await session.start("d");
  assert.equal(session.getState().status, "awaitingInput");
  assert.equal(session.getState().visibleMessages.at(-1).content, "没有标记的一句话");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd crates/agent-gui && npm test -- test/chat/clarify-session.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// crates/agent-ui/src/components/chat/clarify/useClarifySession.ts
import { useCallback, useRef, useState } from "react";
import {
  buildClarifyMessages,
  buildForceFinalInstruction,
  CLARIFY_MAX_QUESTIONS,
  parseClarifyTurn,
} from "./clarifyProtocol";
import type { ClarifyContext, ClarifyMessage, RunClarifyTurn } from "./clarifyTypes";

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
  start(draftText: string): Promise<void>;
  submitAnswer(text: string): Promise<void>;
  forceFinal(): Promise<void>;
  retry(): Promise<void>;
  close(): void;
};

/**
 * 澄清会话核心（框架无关，便于 node:test 直测）。React hook 只是把 core 的
 * state 镜像进 useState。一次 start 对应一次会话；close 丢弃全部状态。
 */
export function createClarifySessionCore(
  runTurn: RunClarifyTurn,
  callbacks: { onFinal: (text: string) => void },
): ClarifySessionCore {
  let state: ClarifySessionState = { ...EMPTY_CLARIFY_SESSION_STATE };
  let sessionMessages: ClarifyMessage[] = [];
  let questionCount = 0;
  let controller: AbortController | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  const setState = (patch: Partial<ClarifySessionState>) => {
    state = { ...state, ...patch };
    emit();
  };

  const ask = async (extraUser?: ClarifyMessage) => {
    if (extraUser) sessionMessages.push(extraUser);
    controller = new AbortController();
    setState({ status: "asking", streamingText: "", error: null });
    try {
      const raw = await runTurn(
        buildClarifyMessages(sessionMessages),
        controller.signal,
        (delta) => setState({ streamingText: state.streamingText + delta }),
      );
      const parsed = parseClarifyTurn(raw);
      if (parsed.kind === "final") {
        setState({ status: "synthesizing", streamingText: "" });
        sessionMessages.push({ role: "assistant", content: raw });
        setState({ status: "done", finalText: parsed.text, visibleMessages: sessionMessages.slice() });
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

/** React 包装：把 core 状态镜像进组件态。 */
export function useClarifySession(
  runTurn: RunClarifyTurn,
  _clarifyContext: ClarifyContext | undefined,
  callbacks: { onFinal: (text: string) => void },
) {
  const [state, setState] = useState<ClarifySessionState>(EMPTY_CLARIFY_SESSION_STATE);
  const coreRef = useRef<ClarifySessionCore | null>(null);
  if (!coreRef.current) {
    const core = createClarifySessionCore(runTurn, callbacks);
    core.subscribe = (listener: () => void) => {
      // createClarifySessionCore 未导出 subscribe 时在此补充（见下）。
      return () => {};
    };
    coreRef.current = core;
  }
  return { state, core: coreRef.current };
}
```

注意：上面的 `useClarifySession` 是占位草案——实施时把 `createClarifySessionCore` 加上 `subscribe(listener): () => void` 返回（`emit` 已有），hook 内 `useSyncExternalStore(core.subscribe, core.getState)` 驱动重渲染，`runTurn`/`callbacks` 经 ref 保持最新。测试只测 `createClarifySessionCore`，hook 部分手测（Task 5）。

- [ ] **Step 4: 运行确认通过**

Run: `cd crates/agent-gui && npm test -- test/chat/clarify-session.test.mjs`
Expected: PASS（5 个用例）

- [ ] **Step 5: Commit**

```bash
git add crates/agent-ui/src/components/chat/clarify/useClarifySession.ts crates/agent-gui/test/chat/clarify-session.test.mjs
git commit -m "feat(clarify): add clarify session state machine"
```

---

### Task 3: ClarifyPanel 组件 + i18n 键

**Files:**
- Create: `crates/agent-ui/src/components/chat/clarify/ClarifyPanel.tsx`
- Modify: `crates/agent-ui/src/i18n/translations/zhCNCommon.ts`（文件尾部 `chat.*` 键区域附近，新增一节）
- Modify: `crates/agent-ui/src/i18n/translations/enUSCommon.ts`（同上）

**Interfaces:**
- Consumes: Task 1 `stripLeadingMarker`；Task 2 `useClarifySession`、`ClarifySessionState`。
- Produces:
  - `ClarifyPanel(props: { state: ClarifySessionState; onSubmitAnswer: (text: string) => void; onForceFinal: () => void; onRetry: () => void; onClose: () => void; busy: boolean }): JSX.Element`
  - i18n 键（两个文件都要）：`chat.clarify.title`、`chat.clarify.buttonTitle`、`chat.clarify.buttonDisabled`、`chat.clarify.answerPlaceholder`、`chat.clarify.generate`、`chat.clarify.retry`、`chat.clarify.close`、`chat.clarify.thinking`、`chat.clarify.writing`、`chat.clarify.applied`、`chat.clarify.errorPrefix`

- [ ] **Step 1: 加 i18n 键**

`zhCNCommon.ts`（在既有 `chat.queue.*` 键组附近追加）：

```ts
  // 提示词澄清面板（输入框旁的按钮唤起）
  "chat.clarify.title": "澄清提示词",
  "chat.clarify.buttonTitle": "澄清提示词",
  "chat.clarify.buttonDisabled": "请先输入提示词草稿",
  "chat.clarify.answerPlaceholder": "回答问题，或补充说明…（Enter 发送）",
  "chat.clarify.generate": "直接生成提示词",
  "chat.clarify.retry": "重试",
  "chat.clarify.close": "关闭",
  "chat.clarify.thinking": "思考中…",
  "chat.clarify.writing": "正在生成最终提示词…",
  "chat.clarify.applied": "已写入输入框，可继续编辑",
  "chat.clarify.errorPrefix": "请求失败",
```

`enUSCommon.ts` 对应英文：

```ts
  // Prompt clarify panel (opened from the composer toolbar button)
  "chat.clarify.title": "Clarify prompt",
  "chat.clarify.buttonTitle": "Clarify prompt",
  "chat.clarify.buttonDisabled": "Type a draft prompt first",
  "chat.clarify.answerPlaceholder": "Answer or add details… (Enter to send)",
  "chat.clarify.generate": "Generate prompt now",
  "chat.clarify.retry": "Retry",
  "chat.clarify.close": "Close",
  "chat.clarify.thinking": "Thinking…",
  "chat.clarify.writing": "Writing the final prompt…",
  "chat.clarify.applied": "Applied to the composer — edit freely",
  "chat.clarify.errorPrefix": "Request failed",
```

- [ ] **Step 2: 实现 ClarifyPanel**

无组件测试基建（仓库无 react-testing 库），本任务以类型检查 + 手测验收（Task 5）。

```tsx
// crates/agent-ui/src/components/chat/clarify/ClarifyPanel.tsx
import { Loader2, RefreshCw, WandSparkles, X } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useState, type KeyboardEvent } from "react";
import { stripLeadingMarker } from "./clarifyProtocol";
import type { ClarifySessionState } from "./useClarifySession";

type ClarifyPanelProps = {
  state: ClarifySessionState;
  busy: boolean;
  onSubmitAnswer: (text: string) => void;
  onForceFinal: () => void;
  onRetry: () => void;
  onClose: () => void;
};

/** 输入框上方内嵌的澄清面板：问答气泡 + 回答输入行 + 操作按钮。 */
export function ClarifyPanel(props: ClarifyPanelProps) {
  const { state, busy, onSubmitAnswer, onForceFinal, onRetry, onClose } = props;
  const { t } = useLocale();
  const [answer, setAnswer] = useState("");

  const submit = () => {
    const text = answer.trim();
    if (!text || busy) return;
    setAnswer("");
    onSubmitAnswer(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const canAnswer = state.status === "awaitingInput";
  const canGenerate = !busy && state.status !== "done";

  return (
    <div
      data-clarify-panel=""
      className="mx-4 mb-1 mt-2 flex max-h-[40vh] flex-col overflow-hidden rounded-2xl border border-black/[0.055] bg-white/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] backdrop-blur-2xl dark:border-white/[0.10] dark:bg-white/[0.06]"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium text-muted-foreground">
          <WandSparkles className="h-3.5 w-3.5" />
          {t("chat.clarify.title")}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("chat.clarify.close")}
          title={t("chat.clarify.close")}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="chat-queue-scroll flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 pb-2">
        {state.visibleMessages.map((message, index) => (
          <div
            key={index}
            className={cn(
              "max-w-[92%] whitespace-pre-wrap rounded-xl px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] leading-relaxed",
              message.role === "user"
                ? "self-end bg-primary/10 text-foreground"
                : "self-start bg-muted/60 text-foreground/90",
            )}
          >
            {message.role === "assistant" ? stripLeadingMarker(message.content) : message.content}
          </div>
        ))}
        {busy && state.streamingText ? (
          <div className="max-w-[92%] self-start whitespace-pre-wrap rounded-xl bg-muted/60 px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] leading-relaxed text-foreground/90">
            {stripLeadingMarker(state.streamingText)}
          </div>
        ) : null}
        {state.status === "asking" && !state.streamingText ? (
          <div className="flex items-center gap-1.5 self-start rounded-xl bg-muted/60 px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("chat.clarify.thinking")}
          </div>
        ) : null}
        {state.status === "synthesizing" ? (
          <div className="flex items-center gap-1.5 self-start rounded-xl bg-muted/60 px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("chat.clarify.writing")}
          </div>
        ) : null}
        {state.status === "done" ? (
          <div className="self-start rounded-xl bg-primary/10 px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] text-foreground/90">
            {t("chat.clarify.applied")}
          </div>
        ) : null}
        {state.status === "error" && state.error ? (
          <div className="flex items-center gap-2 self-start rounded-xl bg-destructive/10 px-2.5 py-1.5 text-[calc(12px*var(--zone-font-scale,1))] text-destructive">
            <span className="min-w-0 flex-1">
              {t("chat.clarify.errorPrefix")}: {state.error}
            </span>
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors hover:bg-destructive/15"
            >
              <RefreshCw className="h-3 w-3" />
              {t("chat.clarify.retry")}
            </button>
          </div>
        ) : null}
      </div>

      {canAnswer ? (
        <div className="flex items-end gap-1.5 border-t border-black/[0.05] px-2.5 py-1.5 dark:border-white/[0.08]">
          <textarea
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={t("chat.clarify.answerPlaceholder")}
            className="max-h-24 min-h-[28px] flex-1 resize-none bg-transparent px-1.5 py-1 text-[calc(12px*var(--zone-font-scale,1))] leading-relaxed outline-none placeholder:text-muted-foreground/60"
          />
          <button
            type="button"
            onClick={onForceFinal}
            disabled={!canGenerate}
            title={t("chat.clarify.generate")}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-black/[0.06] px-2.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40 dark:border-white/[0.12]"
          >
            <WandSparkles className="h-3 w-3" />
            <span className="whitespace-nowrap">{t("chat.clarify.generate")}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
```

（`RefreshCw`、`X` 若 IconSet 未导出，用 `~icons/lucide/refresh-cw`、`~icons/lucide/x` 直接 import——仓库已配 unplugin-icons，见 IconSet.tsx 用法。）

- [ ] **Step 3: 类型检查**

Run: `cd crates/agent-gui && npx tsc --noEmit`
Expected: 无错误（若仓库有独立 lint 脚本一并跑 `npm run lint`）

- [ ] **Step 4: Commit**

```bash
git add crates/agent-ui/src/components/chat/clarify/ClarifyPanel.tsx crates/agent-ui/src/i18n/translations/zhCNCommon.ts crates/agent-ui/src/i18n/translations/enUSCommon.ts
git commit -m "feat(clarify): add ClarifyPanel UI component and i18n strings"
```

---

### Task 4: ChatComposerBar 集成（按钮 + 面板 + 落框）

**Files:**
- Modify: `crates/agent-ui/src/pages/chat/ChatComposerBar.tsx`（props 类型 229 行起、组件顶部解构、工具行 1010-1127、编辑器容器 980 行、发送守卫 `handleComposerSend` 507 行）

**Interfaces:**
- Consumes: Task 1-3 全部产物（`RunClarifyTurn`、`ClarifyContext`、`useClarifySession`、`ClarifyPanel`）。
- Produces: `ChatComposerBarProps` 新增可选字段：
  - `runClarifyTurn?: RunClarifyTurn`
  - `clarifyContext?: ClarifyContext`

- [ ] **Step 1: props 与状态**

在 `ChatComposerBarProps`（`ChatComposerBar.tsx:229`）的 `onHeightChange?: (height: number) => void;` 之前加：

```ts
  /** 提示词澄清执行器：注入后在工具行渲染「澄清」按钮（GUI 已接；Web 见计划 2）。 */
  runClarifyTurn?: RunClarifyTurn;
  /** 澄清系统提示词附带的轻量工作区信息。 */
  clarifyContext?: ClarifyContext;
```

顶部 import：

```ts
import { ClarifyPanel } from "@liveagent/ui/components/chat/clarify/ClarifyPanel";
import type {
  ClarifyContext,
  RunClarifyTurn,
} from "@liveagent/ui/components/chat/clarify/clarifyTypes";
import { useClarifySession } from "@liveagent/ui/components/chat/clarify/useClarifySession";
```

（import 风格：本文件统一 `@liveagent/ui/...` 绝对路径，照抄。）

组件解构加 `runClarifyTurn, clarifyContext`；body 加：

```tsx
  // 澄清会话：面板即开即用，关闭即丢弃（设计文档：不持久化）。
  const [clarifyOpen, setClarifyOpen] = useState(false);
  const applyClarifyFinal = useCallback(
    (finalText: string) => {
      const composer = composerRef.current;
      if (!composer) return;
      // 只替换文本段：附件/提及 chips 原样保留（设计文档「终稿落框」）。
      // setDraft 按 segments 重建 DOM，stale 派生字段会被忽略。
      const draft = composer.getDraft();
      const preserved = draft.segments.filter((segment) => segment.type !== "text");
      composer.setDraft({
        ...draft,
        segments: [{ type: "text", text: finalText }, ...preserved],
      });
      setClarifyOpen(false);
      composer.focus();
    },
    [composerRef],
  );
  const clarifySession = useClarifySession(runClarifyTurn, clarifyContext, {
    onFinal: applyClarifyFinal,
  });
  const clarifyEnabled = Boolean(runClarifyTurn) && hasModels;
  const clarifyButtonDisabled = !clarifyEnabled || composerIsEmpty;
  const handleClarifyToggle = useCallback(() => {
    if (!clarifyEnabled) return;
    if (clarifyOpen) {
      clarifySession.core.close();
      setClarifyOpen(false);
      return;
    }
    const composer = composerRef.current;
    const draftText = composer?.getDraft().textWithoutLargePastes.trim() || "";
    if (!draftText) return;
    setClarifyOpen(true);
    void clarifySession.core.start(draftText);
  }, [clarifyEnabled, clarifyOpen, clarifySession.core]);
  // 切会话时丢弃进行中的澄清（组件按 conversationId 重挂载，保险起见也显式关）。
  useEffect(() => {
    clarifySession.core.close();
    setClarifyOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);
```

发送守卫（`handleComposerSend`，507 行）：

```tsx
  const handleComposerSend = useCallback(() => {
    // 澄清进行中禁发：避免把半成品草稿发出去（设计文档「交互」）。
    if (clarifyOpen) return;
    setComposerExpanded(false);
    onSend();
  }, [clarifyOpen, onSend, setComposerExpanded]);
```

- [ ] **Step 2: 工具行按钮**

在计划模式 pill（1113-1125 行 `{isAgentMode && chatRuntimeControls.planModeEnabled ? (...) : null}` 之后、STT 块 `{stt.available ? (` 之前）插入：

```tsx
              {clarifyEnabled ? (
                <RuntimeControlTooltip label={t("chat.clarify.buttonTitle")}>
                  <button
                    type="button"
                    disabled={clarifyButtonDisabled}
                    onClick={handleClarifyToggle}
                    aria-label={t("chat.clarify.buttonTitle")}
                    aria-pressed={clarifyOpen}
                    title={clarifyButtonDisabled ? t("chat.clarify.buttonDisabled") : undefined}
                    className={cn(
                      "composer-toolbar-action inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-hidden transition-colors hover:bg-muted/60 focus-visible:bg-muted/60",
                      "disabled:pointer-events-none disabled:opacity-40",
                      clarifyOpen && "bg-muted/60 text-foreground",
                    )}
                  >
                    <WandSparkles className="h-4 w-4" />
                  </button>
                </RuntimeControlTooltip>
              ) : null}
```

`WandSparkles` 加入本文件 IconSet import。

- [ ] **Step 3: 面板渲染**

在编辑器容器（980 行 `<div className={cn("relative flex flex-1 pl-4 pr-12", ...)}>` 之前、用量环容器（959-968 行）之后）插入：

```tsx
          {clarifyOpen && runClarifyTurn ? (
            <ClarifyPanel
              state={clarifySession.state}
              busy={clarifySession.state.status === "asking" || clarifySession.state.status === "synthesizing"}
              onSubmitAnswer={(text) => void clarifySession.core.submitAnswer(text)}
              onForceFinal={() => void clarifySession.core.forceFinal()}
              onRetry={() => void clarifySession.core.retry()}
              onClose={() => {
                clarifySession.core.close();
                setClarifyOpen(false);
              }}
            />
          ) : null}
```

- [ ] **Step 4: 类型检查 + 全量测试**

Run: `cd crates/agent-gui && npx tsc --noEmit && npm test`
Expected: tsc 无错误；既有测试全绿（本任务不新增测试——逻辑都在 Task 1/2 测过，组件接线手测）。

- [ ] **Step 5: Commit**

```bash
git add crates/agent-ui/src/pages/chat/ChatComposerBar.tsx
git commit -m "feat(clarify): wire clarify panel and toolbar button into ChatComposerBar"
```

---

### Task 5: GUI 宿主接线（ChatPage → streamAssistantMessage）

**Files:**
- Modify: `crates/agent-gui/src/pages/ChatPage.tsx`（composer binding，2988 行起）
- Test: `crates/agent-gui/test/chat/clarify-runner.test.mjs`

**Interfaces:**
- Consumes: Task 1 `RunClarifyTurn`；`streamAssistantMessage` / `assistantMessageToText`（`crates/agent-gui/src/lib/providers/llm.ts`）、`resolveEffectiveChatModelSelection`（`runtime/modelSelection.ts`）、`createProviderRuntimeConfig`（`lib/providers/llm.ts`）。
- Produces: 无下游依赖（终端接线任务）。

- [ ] **Step 1: 写失败测试（runner 包装函数）**

为可测性，把包装函数放进独立文件 `crates/agent-gui/src/pages/chat/runtime/clarifyRunner.ts`（与 conversationTitleJob 同目录），测试 mock `streamAssistantMessage`：

```js
// crates/agent-gui/test/chat/clarify-runner.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);

const calls = [];
const loader = createTsModuleLoader({
  mocks: {
    [abs("src/lib/providers/llm.ts")]: {
      streamAssistantMessage: async (params) => {
        calls.push(params);
        return { role: "assistant", content: "[CLARIFY_QUESTION]\nQ1" };
      },
      assistantMessageToText: (m) => m.content,
    },
  },
});
const mod = await loader.import(abs("src/pages/chat/runtime/clarifyRunner.ts"));

test("runGuiClarifyTurn maps messages into a text-only stream call", async () => {
  const runtime = {
    baseUrl: "https://api.example.com",
    apiKey: "sk-test",
    requestFormat: "openai",
    reasoning: "off",
    promptCachingEnabled: false,
    retryPolicy: { maxAttempts: 1, initialDelayMs: 1 },
  };
  const provider = { id: "p1", type: "openai", baseUrl: "https://api.example.com", apiKey: "k", requestFormat: "openai", activeModels: ["m1"] };
  const selection = { selectedModel: { customProviderId: "p1", model: "m1" }, provider, providerId: "openai", model: "m1" };
  const out = await mod.createGuiClarifyRunner(
    () => selection,
    () => runtime,
  )([{ role: "user", content: "hi" }], new AbortController().signal);
  assert.equal(out, "[CLARIFY_QUESTION]\nQ1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].providerId, "openai");
  assert.equal(calls[0].model, "m1");
  assert.equal(calls[0].context.systemPrompt.length > 0, true);
  assert.equal(calls[0].context.messages.length, 1);
  assert.equal(calls[0].context.messages[0].role, "user");
  assert.equal(calls[0].nativeWebSearch, false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd crates/agent-gui && npm test -- test/chat/clarify-runner.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 clarifyRunner**

```ts
// crates/agent-gui/src/pages/chat/runtime/clarifyRunner.ts
import type { ClarifyMessage, RunClarifyTurn } from "@liveagent/ui/components/chat/clarify/clarifyTypes";
import { assistantMessageToText, streamAssistantMessage } from "../../../lib/providers/llm";
import type { EffectiveChatModelSelection } from "./modelSelection";

type RuntimeLike = Parameters<typeof streamAssistantMessage>[0]["runtime"];

/**
 * 桌面宿主的澄清执行器：当前会话模型跑一次纯文本补全。模型/runtime 在每
 * 次调用时惰性解析（getter），保证澄清用的始终是面板打开当下的选择。
 */
export function createGuiClarifyRunner(
  getSelection: () => EffectiveChatModelSelection,
  getRuntime: () => RuntimeLike,
): RunClarifyTurn {
  return async (messages: ClarifyMessage[], signal: AbortSignal, onTextDelta?: (delta: string) => void) => {
    const selection = getSelection();
    const assistant = await streamAssistantMessage({
      providerId: selection.providerId,
      model: selection.model,
      runtime: getRuntime(),
      signal,
      cacheRetention: "none",
      nativeWebSearch: false,
      context: {
        systemPrompt: "",
        messages: messages.map((message) => ({
          role: message.role,
          content: message.content,
          timestamp: Date.now(),
        })),
      },
      onTextDelta,
    });
    return assistantMessageToText(assistant);
  };
}
```

注意：`buildClarifyMessages`（Task 1）已在消息数组前置 system；`streamAssistantMessage` 的 `context.systemPrompt` 留空即可——`buildTextOnlyCallContext` 会追加 text-only 后缀。若实现时发现 pi-ai 要求 systemPrompt 非空，把 system 消息挪到 `context.systemPrompt` 字段并在测试中断言，保持 LLM 输入语义不变。

- [ ] **Step 4: 运行确认通过**

Run: `cd crates/agent-gui && npm test -- test/chat/clarify-runner.test.mjs`
Expected: PASS

- [ ] **Step 5: ChatPage 接线**

`crates/agent-gui/src/pages/ChatPage.tsx` composer binding（2988 行 `composer: {` 对象内、`loadHistoryPrompts` 附近）加：

```tsx
        runClarifyTurn: useMemo(
          () =>
            createGuiClarifyRunner(
              () => resolveEffectiveChatModelSelection({ settings }),
              () =>
                createProviderRuntimeConfig(
                  resolveEffectiveChatModelSelection({ settings }).provider,
                  resolveEffectiveChatModelSelection({ settings }).model,
                  chatRuntimeControlsForCurrentProvider,
                ),
            ),
          [settings, chatRuntimeControlsForCurrentProvider],
        ),
        clarifyContext: {
          workdir: workspaceRoot ?? "",
          gitBranch: currentGitBranch,
        },
```

接线细节（实施者按仓库实际微调，语义不变）：
- `resolveEffectiveChatModelSelection` 的 `conversationSelectedModel` 取当前 pane 的会话模型——与 `currentModelLabel: paneModelLabel` 同源（grep `paneModelLabel` 的上游）。若该 binding 处拿不到 pane 模型，退回 `{ settings }` 即页面级选中模型，并在注释说明。
- `currentGitBranch`：ChatPage 若无现成分支状态，先传 `undefined`（`clarifyContext.gitBranch` 可选），不为此新拉 git 状态。
- `createProviderRuntimeConfig` 与 `resolveEffectiveChatModelSelection` 的 import 从 `../../../lib/providers/llm` / `./chat/runtime/modelSelection` 引入（ChatPage 现有 import 区）。

- [ ] **Step 6: 全量验证**

Run: `cd crates/agent-gui && npx tsc --noEmit && npm test`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add crates/agent-gui/src/pages/chat/runtime/clarifyRunner.ts crates/agent-gui/src/pages/ChatPage.tsx crates/agent-gui/test/chat/clarify-runner.test.mjs
git commit -m "feat(clarify): wire GUI host clarify runner into composer binding"
```

---

### Task 6: 端到端手测

**Files:** 无新文件（验证任务）。

- [ ] **Step 1: 启动应用**

用 `run` 技能（或仓库既有启动方式）启动桌面 GUI。

- [ ] **Step 2: 验收清单（设计文档「交互」「错误处理」逐条）**

1. 输入框输入模糊草稿（如「帮我优化下登录页」）→ 点魔棒按钮 → 面板出现在输入框上方，首问出现
2. 回答 1-2 轮 → 点「直接生成提示词」→ 终稿写入输入框，面板关闭
3. 草稿含 @文件提及 → 澄清后文件 chip 仍在，文本被替换
4. 澄清进行中按 Enter → 不发送主会话
5. 断网/错 key 场景 → 面板出现错误行 + 重试可恢复
6. 草稿为空 → 按钮禁用，title 提示
7. 连问 5 轮 → 第 6 次回答后自动出终稿
8. 中英文 UI 各切一遍，文案正确

- [ ] **Step 3: 修复发现的问题（每修一个跑 `npm test`），全部通过后收尾 commit**

```bash
git add -A
git commit -m "fix(clarify): polish from manual verification pass"
```
（无问题则跳过本步。）

---

## Self-Review 记录

- Spec 覆盖：UI 形态（T3/T4）、当前会话模型（T5）、LLM 判定+手动兜底（T1/T2）、5 轮上限（T2）、只换文本保附件（T4）、轻量工作区（T1/T5）、错误处理全表（T2/T3/T6）、i18n（T3）、测试（T1/T2/T5 各任务内联）——全部有对应任务。Web surface 归计划 2。
- 占位符：T2 的 `useClarifySession` hook 部分标注了「实施时用 useSyncExternalStore 完善」——core 全量代码完整可测，hook 是 10 行镜像，属实现指引非占位；T5 Step 5 标注了两处「按仓库实际微调」的接线点，语义已锁死。
- 类型一致性：`RunClarifyTurn(messages, signal, onTextDelta?)` 贯穿 T1/T2/T4/T5；`ClarifySessionState` 字段名在 T2/T3/T4 一致。
