import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// #975：命令运行中的输出由 K-brain 以 tool.status{tool_call_id,status:"running",message}
// 推送尾部快照；桌面端把它挂到对应工具卡，结果到达后由最终输出取代。
const loader = createTsModuleLoader();
const { runKBrainTurn } = loader.loadModule("src/lib/kbrain/turn.ts");
const { attachToolResultToRound, setToolLiveOutputInRound, upsertToolCallToRound } =
  loader.loadModule("src/lib/chat/messages/uiMessages.ts");
const { formatLiveShellOutput, LIVE_SHELL_OUTPUT_MAX_LINES } = loader.loadModule(
  "../agent-ui/src/lib/chat/liveShellOutput.ts",
);

test("tool.status snapshots with a tool_call_id reach the tool card, not the turn status", async () => {
  let seq = 1;
  const event = (type, payload) =>
    `data: ${JSON.stringify({ version: "kbrain.agent.v1", conversation_id: "s", run_id: "r", seq: ++seq, type, payload })}\n\n`;
  const stream = [
    event("tool.call", { tool_call: { id: "bash-1", name: "Bash", arguments: { command: "make" } } }),
    // 未知调用的快照被忽略。
    event("tool.status", { tool_call_id: "unknown", status: "running", message: "stray" }),
    event("tool.status", { tool_call_id: "bash-1", status: "running", message: "step 1\n" }),
    event("tool.status", { tool_call_id: "bash-1", status: "running", message: "step 1\nstep 2\n" }),
    event("tool.result", { tool_result: { id: "bash-1", name: "Bash", output: "step 1\nstep 2\ndone" } }),
    // 结果之后晚到的快照不能再覆盖卡片。
    event("tool.status", { tool_call_id: "bash-1", status: "running", message: "late" }),
    // 不带 tool_call_id 的状态（如压缩）仍按整轮状态处理。
    event("tool.status", { tool: "compaction", status: "compacting" }),
    event("assistant.text.delta", { text: "ok" }),
    event("run.completed", {}),
  ].join("");
  const fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/v1/sessions") return Response.json({ id: "s" });
    if (path === "/v1/health") return Response.json({});
    if (path.endsWith("/runs"))
      return Response.json({ version: "kbrain.agent.v1", conversation_id: "s", run_id: "r", accepted_seq: 1 });
    if (path.endsWith("/events"))
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    throw new Error(`Unexpected request ${path}`);
  };
  const outputs = [];
  const statuses = [];
  const results = [];
  const result = await runKBrainTurn({
    baseUrl: "http://fixture.test",
    fetch,
    model: { provider: "fixture", model: "test" },
    sessionId: "frontend",
    conversationId: "live-output",
    cwd: "/tmp",
    context: { messages: [] },
    prompt: "build",
    signal: new AbortController().signal,
    onStatus: (status) => statuses.push(status),
    onTextDelta() {},
    onThinkingDelta() {},
    onToolCall() {},
    onToolResult: (call) => results.push(call.id),
    onToolOutput: (id, output) => outputs.push([id, output]),
  });
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(outputs, [
    ["bash-1", "step 1\n"],
    ["bash-1", "step 1\nstep 2\n"],
  ]);
  assert.deepEqual(results, ["bash-1"]);
  assert.ok(!statuses.includes("running"), "live output must not overwrite the turn status");
  assert.ok(statuses.includes("compacting"));
});

test("live output attaches to a running tool block and is dropped when the result lands", () => {
  const call = { type: "toolCall", id: "bash-1", name: "Bash", arguments: { command: "make" } };
  const empty = { round: 1, key: "r1", blocks: [] };
  const running = upsertToolCallToRound(empty, call);
  const live = setToolLiveOutputInRound(running, "bash-1", "compiling a.c\n");
  assert.equal(live.blocks[0].item.liveOutput, "compiling a.c\n");
  // 相同快照不产生新对象；未知调用原样返回。
  assert.equal(setToolLiveOutputInRound(live, "bash-1", "compiling a.c\n"), live);
  assert.equal(setToolLiveOutputInRound(live, "missing", "x"), live);
  // 参数更新保留快照。
  assert.equal(upsertToolCallToRound(live, call).blocks[0].item.liveOutput, "compiling a.c\n");

  const toolResult = {
    role: "toolResult",
    toolCallId: "bash-1",
    toolName: "Bash",
    content: [{ type: "text", text: "done" }],
    isError: false,
  };
  const settled = attachToolResultToRound(live, call, toolResult);
  assert.equal(settled.blocks[0].item.toolResult, toolResult);
  assert.equal("liveOutput" in settled.blocks[0].item, false);
  // 结果之后的快照不再写入。
  assert.equal(setToolLiveOutputInRound(settled, "bash-1", "late"), settled);
});

test("live shell output strips terminal control sequences, keeps the last redraw and stays bounded", () => {
  assert.equal(formatLiveShellOutput(""), "");
  assert.equal(
    formatLiveShellOutput("\u001b[32mCompiling\u001b[0m foo\r\nprogress 10%\rprogress 55%\n\n"),
    "Compiling foo\nprogress 55%",
  );
  const many = Array.from({ length: LIVE_SHELL_OUTPUT_MAX_LINES + 50 }, (_, i) => `line ${i}`).join("\n");
  const bounded = formatLiveShellOutput(many);
  const lines = bounded.split("\n");
  assert.equal(lines.length, LIVE_SHELL_OUTPUT_MAX_LINES);
  assert.equal(lines.at(-1), `line ${LIVE_SHELL_OUTPUT_MAX_LINES + 49}`);
  assert.ok(formatLiveShellOutput("x".repeat(20_000)).length <= 8000);
});
