import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const proxyModulePath = path.join(rootDir, "src/lib/providers/proxy.ts");
const powerActivityModulePath = path.join(rootDir, "src/lib/system/powerActivity.ts");

const loader = createTsModuleLoader();
const { wrapDeepSeekDsmlToolCallStream } = loader.loadModule(
  "src/lib/providers/deepSeekDsmlToolCallStream.ts",
);

function createUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createAssistant(text, stopReason = "stop") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "deepseek-chat",
    usage: createUsage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function createAssistantWithContent(content, stopReason = "toolUse") {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "deepseek-chat",
    usage: createUsage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function createToolCall(id, name, args = {}) {
  return {
    type: "toolCall",
    id,
    name,
    arguments: args,
  };
}

function createToolResult(toolCall, text = "ok") {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

function createSourceStream(deltas, stopReason = "stop") {
  const text = deltas.join("");
  const assistant = createAssistant(text, stopReason);
  const partial = {
    ...assistant,
    content: [{ type: "text", text: "" }],
  };
  const events = [
    { type: "start", partial: { ...assistant, content: [] } },
    { type: "text_start", contentIndex: 0, partial },
  ];

  for (const delta of deltas) {
    partial.content[0].text += delta;
    events.push({
      type: "text_delta",
      contentIndex: 0,
      delta,
      partial: { ...partial, content: [{ ...partial.content[0] }] },
    });
  }

  events.push({
    type: "text_end",
    contentIndex: 0,
    content: text,
    partial: assistant,
  });
  events.push({ type: "done", reason: stopReason, message: assistant });

  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    async result() {
      return assistant;
    },
  };
}

function createThinkingSourceStream(deltas, stopReason = "stop") {
  const thinking = deltas.join("");
  const assistant = createAssistantWithContent([{ type: "thinking", thinking }], stopReason);
  const partial = {
    ...assistant,
    content: [{ type: "thinking", thinking: "", thinkingSignature: "" }],
  };
  const events = [
    { type: "start", partial: { ...assistant, content: [] } },
    { type: "thinking_start", contentIndex: 0, partial },
  ];

  for (const delta of deltas) {
    partial.content[0].thinking += delta;
    events.push({
      type: "thinking_delta",
      contentIndex: 0,
      delta,
      partial: { ...partial, content: [{ ...partial.content[0] }] },
    });
  }

  events.push({
    type: "thinking_end",
    contentIndex: 0,
    content: thinking,
    partial: assistant,
  });
  events.push({ type: "done", reason: stopReason, message: assistant });

  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    async result() {
      return assistant;
    },
  };
}

function createSourceStreamWithTextAndTool(deltas, toolCall) {
  const text = deltas.join("");
  const assistant = createAssistantWithContent([{ type: "text", text }, toolCall], "toolUse");
  const textPartial = {
    ...assistant,
    content: [{ type: "text", text: "" }],
  };
  const toolPartial = {
    ...assistant,
    content: [{ type: "text", text }, toolCall],
  };
  const events = [
    { type: "start", partial: { ...assistant, content: [] } },
    { type: "text_start", contentIndex: 0, partial: textPartial },
  ];

  for (const delta of deltas) {
    textPartial.content[0].text += delta;
    events.push({
      type: "text_delta",
      contentIndex: 0,
      delta,
      partial: { ...textPartial, content: [{ ...textPartial.content[0] }] },
    });
  }

  events.push({
    type: "text_end",
    contentIndex: 0,
    content: text,
    partial: { ...assistant, content: [{ type: "text", text }] },
  });
  events.push({
    type: "toolcall_start",
    contentIndex: 1,
    partial: toolPartial,
  });
  events.push({
    type: "toolcall_delta",
    contentIndex: 1,
    delta: JSON.stringify(toolCall.arguments),
    partial: toolPartial,
  });
  events.push({
    type: "toolcall_end",
    contentIndex: 1,
    toolCall,
    partial: toolPartial,
  });
  events.push({ type: "done", reason: "toolUse", message: assistant });

  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    async result() {
      return assistant;
    },
  };
}

function createSourceStreamWithTextToolAndTrailingText(deltas, toolCall, trailingDeltas) {
  const text = deltas.join("");
  const trailingText = trailingDeltas.join("");
  const assistant = createAssistantWithContent(
    [{ type: "text", text }, toolCall, { type: "text", text: trailingText }],
    "toolUse",
  );
  const textPartial = {
    ...assistant,
    content: [{ type: "text", text: "" }],
  };
  const textDonePartial = {
    ...assistant,
    content: [{ type: "text", text }],
  };
  const toolPartial = {
    ...assistant,
    content: [{ type: "text", text }, toolCall],
  };
  const trailingPartial = {
    ...assistant,
    content: [{ type: "text", text }, toolCall, { type: "text", text: "" }],
  };
  const events = [
    { type: "start", partial: { ...assistant, content: [] } },
    { type: "text_start", contentIndex: 0, partial: textPartial },
  ];

  for (const delta of deltas) {
    textPartial.content[0].text += delta;
    events.push({
      type: "text_delta",
      contentIndex: 0,
      delta,
      partial: { ...textPartial, content: [{ ...textPartial.content[0] }] },
    });
  }

  events.push({
    type: "text_end",
    contentIndex: 0,
    content: text,
    partial: textDonePartial,
  });
  events.push({
    type: "toolcall_start",
    contentIndex: 1,
    partial: toolPartial,
  });
  events.push({
    type: "toolcall_delta",
    contentIndex: 1,
    delta: JSON.stringify(toolCall.arguments),
    partial: toolPartial,
  });
  events.push({
    type: "toolcall_end",
    contentIndex: 1,
    toolCall,
    partial: toolPartial,
  });
  events.push({
    type: "text_start",
    contentIndex: 2,
    partial: trailingPartial,
  });

  for (const delta of trailingDeltas) {
    trailingPartial.content[2].text += delta;
    events.push({
      type: "text_delta",
      contentIndex: 2,
      delta,
      partial: {
        ...trailingPartial,
        content: [
          trailingPartial.content[0],
          trailingPartial.content[1],
          { ...trailingPartial.content[2] },
        ],
      },
    });
  }

  events.push({
    type: "text_end",
    contentIndex: 2,
    content: trailingText,
    partial: assistant,
  });
  events.push({ type: "done", reason: "toolUse", message: assistant });

  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    async result() {
      return assistant;
    },
  };
}

const dsml = "\uFF5C\uFF5CDSML\uFF5C\uFF5C";

test("DeepSeek DSML stream wrapper passes through ordinary text once", async () => {
  const deltas = ["plain ", "text", "\nnext line"];
  const wrapped = wrapDeepSeekDsmlToolCallStream(createSourceStream(deltas));
  const events = [];
  for await (const event of wrapped) {
    events.push(event);
  }

  assert.equal(
    events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.delta)
      .join(""),
    "plain text\nnext line",
  );
  assert.equal(events.some((event) => event.type === "toolcall_end"), false);

  const final = await wrapped.result();
  assert.equal(final.stopReason, "stop");
  assert.deepEqual(final.content, [{ type: "text", text: "plain text\nnext line" }]);
});

test("DeepSeek DSML stream wrapper converts split builtin_web_search markup into tool calls", async () => {
  const deltas = [
    "prefix ",
    "<",
    dsml,
    "tool",
    "_calls>\n",
    "<",
    dsml,
    'invoke name="builtin_web_search">\n',
    "<",
    dsml,
    'parameter name="additionalContext" string="true">',
    "企",
    "查",
    "查 funding rounds",
    "</",
    dsml,
    "parameter>\n",
    "</",
    dsml,
    "invoke>\n",
    "<",
    dsml,
    'invoke name="builtin_web_search">\n',
    "<",
    dsml,
    'parameter name="additionalContext" string="true">',
    "DeepSeek Anthropic web search DSML",
    "</",
    dsml,
    "parameter>\n",
    "</",
    dsml,
    "invoke>\n",
    "</",
    dsml,
    "tool_calls>",
    " suffix",
  ];

  const wrapped = wrapDeepSeekDsmlToolCallStream(createSourceStream(deltas));
  const events = [];
  for await (const event of wrapped) {
    events.push(event);
  }

  const text = events
    .filter((event) => event.type === "text_delta")
    .map((event) => event.delta)
    .join("");
  assert.equal(text, "prefix  suffix");

  const toolCallEvents = events.filter((event) => event.type === "toolcall_end");
  assert.equal(toolCallEvents.length, 2);
  assert.deepEqual(
    toolCallEvents.map((event) => event.toolCall.name),
    ["builtin_web_search", "builtin_web_search"],
  );
  assert.deepEqual(toolCallEvents[0].toolCall.arguments, {
    additionalContext: "企查查 funding rounds",
  });

  const final = await wrapped.result();
  assert.equal(final.stopReason, "toolUse");
  assert.deepEqual(
    final.content.map((block) => block.type),
    ["text", "toolCall", "toolCall", "text"],
  );
  assert.equal(
    final.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(""),
    "prefix  suffix",
  );
});

test("DeepSeek DSML stream wrapper strips tool markup leaked through thinking", async () => {
  const deltas = [
    "Need search ",
    `<${dsml}tool_calls>`,
    `<${dsml}invoke name="builtin_web_search">`,
    `<${dsml}parameter name="additionalContext" string="true">thinking leak</${dsml}parameter>`,
    `</${dsml}invoke>`,
    `</${dsml}tool_calls>`,
    " done",
  ];

  const wrapped = wrapDeepSeekDsmlToolCallStream(createThinkingSourceStream(deltas));
  const events = [];
  for await (const event of wrapped) {
    events.push(event);
  }

  const thinkingText = events
    .filter((event) => event.type === "thinking_delta")
    .map((event) => event.delta)
    .join("");
  assert.equal(thinkingText, "Need search  done");

  const toolCallEvents = events.filter((event) => event.type === "toolcall_end");
  assert.equal(toolCallEvents.length, 1);
  assert.equal(toolCallEvents[0].toolCall.name, "builtin_web_search");
  assert.deepEqual(toolCallEvents[0].toolCall.arguments, { additionalContext: "thinking leak" });

  const final = await wrapped.result();
  assert.equal(JSON.stringify(final).includes("DSML"), false);
  assert.deepEqual(
    final.content.map((block) => block.type),
    ["thinking", "toolCall", "thinking"],
  );
  assert.equal(final.stopReason, "toolUse");
});

test("DeepSeek DSML stream wrapper converts flattened tool request text into tool calls", async () => {
  const deltas = [
    "服务已经在跑了，",
    "先看看它是否正确 serve 了 test 目录的内容。\n\nHist",
    "orical assistant tool request (read-only context; do not repeat):\n",
    "tool_call_id: call_00_jphDsYokazxBfu9SJZGZ4602\n",
    "tool_name: SSHManager\n",
    "arguments:\n",
    "{\n",
    '  "action": "exec",\n',
    '  "command": "curl -s http://localhost:8080/index.html | head -20",\n',
    '  "host_id": "713f0316-04ee-4010-bd62-de83aeebc017",\n',
    '  "timeout_ms": 10000\n',
    "}\n",
    "\n稍等。",
  ];

  const wrapped = wrapDeepSeekDsmlToolCallStream(createSourceStream(deltas));
  const events = [];
  for await (const event of wrapped) {
    events.push(event);
  }

  const text = events
    .filter((event) => event.type === "text_delta")
    .map((event) => event.delta)
    .join("");
  assert.equal(text.includes("tool_call_id"), false);
  assert.equal(text, "服务已经在跑了，先看看它是否正确 serve 了 test 目录的内容。\n\n\n\n稍等。");

  const toolCallEvents = events.filter((event) => event.type === "toolcall_end");
  assert.equal(toolCallEvents.length, 1);
  assert.equal(toolCallEvents[0].toolCall.id, "call_00_jphDsYokazxBfu9SJZGZ4602");
  assert.equal(toolCallEvents[0].toolCall.name, "SSHManager");
  assert.deepEqual(toolCallEvents[0].toolCall.arguments, {
    action: "exec",
    command: "curl -s http://localhost:8080/index.html | head -20",
    host_id: "713f0316-04ee-4010-bd62-de83aeebc017",
    timeout_ms: 10000,
  });

  const final = await wrapped.result();
  assert.equal(final.stopReason, "toolUse");
  assert.deepEqual(
    final.content.map((block) => block.type),
    ["text", "toolCall", "text"],
  );
});

test("DeepSeek DSML stream wrapper strips repeated historical tool call text before native tool calls", async () => {
  const toolCall = createToolCall("call_00_quPNrz0VAAnTk8FHPCXr6162", "Grep", {
    pattern: "express",
    file_pattern: "**/*.js",
    ignore_case: true,
  });
  const wrapped = wrapDeepSeekDsmlToolCallStream(
    createSourceStreamWithTextAndTool(
      [
        "✅ JS 文件 2 个：`server.js` + `public/app.js`\n\n",
        "## 4️⃣ Grep 文本搜索\n\nHist",
        "orical tool call (read-only, not repeating):\n",
        "tool_name: Grep\n",
        'arguments: {"pattern": "express", "file_pattern": "**/*.js", "ignore_case": true}',
      ],
      toolCall,
    ),
  );
  const events = [];
  for await (const event of wrapped) {
    events.push(event);
  }

  const text = events
    .filter((event) => event.type === "text_delta")
    .map((event) => event.delta)
    .join("");
  assert.equal(text.includes("Historical tool call"), false);
  assert.equal(text.includes("tool_name: Grep"), false);
  assert.equal(text, "✅ JS 文件 2 个：`server.js` + `public/app.js`\n\n## 4️⃣ Grep 文本搜索\n\n");

  const toolCallEvents = events.filter((event) => event.type === "toolcall_end");
  assert.equal(toolCallEvents.length, 1);
  assert.equal(toolCallEvents[0].toolCall.id, toolCall.id);
  assert.deepEqual(toolCallEvents[0].toolCall.arguments, toolCall.arguments);

  const final = await wrapped.result();
  assert.equal(final.stopReason, "toolUse");
  assert.deepEqual(
    final.content.map((block) => block.type),
    ["text", "toolCall"],
  );
  assert.equal(final.content[0].text.includes("Historical tool call"), false);
});

test("DeepSeek DSML stream wrapper strips bare tool_name text before native tool calls", async () => {
  const toolCall = createToolCall("call_00_native_route_grep", "Grep", {
    pattern: "express|route|api",
    file_pattern: "*.js",
    output_mode: "content",
    ignore_case: true,
  });
  const wrapped = wrapDeepSeekDsmlToolCallStream(
    createSourceStreamWithTextAndTool(
      [
        "继续检查 JS 路由。\n\n",
        "to",
        "ol_name: Grep\n",
        "arguments:\n",
        "{\n",
        '"pattern": "express|route|api",\n',
        '"file_pattern": "*.js",\n',
        '"output_mode": "content",\n',
        '"ignore_case": true\n',
        "}",
      ],
      toolCall,
    ),
  );
  const events = [];
  for await (const event of wrapped) {
    events.push(event);
  }

  const text = events
    .filter((event) => event.type === "text_delta")
    .map((event) => event.delta)
    .join("");
  assert.equal(text.includes("tool_name: Grep"), false);
  assert.equal(text.includes("arguments:"), false);
  assert.equal(text, "继续检查 JS 路由。\n\n");

  const toolCallEvents = events.filter((event) => event.type === "toolcall_end");
  assert.equal(toolCallEvents.length, 1);
  assert.equal(toolCallEvents[0].toolCall.id, toolCall.id);
  assert.deepEqual(toolCallEvents[0].toolCall.arguments, toolCall.arguments);

  const final = await wrapped.result();
  assert.equal(final.stopReason, "toolUse");
  assert.deepEqual(
    final.content.map((block) => block.type),
    ["text", "toolCall"],
  );
  assert.equal(final.content[0].text.includes("tool_name: Grep"), false);
});

test("DeepSeek DSML stream wrapper strips malformed historical request text before native tool calls", async () => {
  const toolCall = createToolCall("call_01_native_bash", "Bash", {
    command: "ls -la tool-test/",
    cwd: ".",
  });
  const wrapped = wrapDeepSeekDsmlToolCallStream(
    createSourceStreamWithTextAndTool(
      [
        "**Edit / Write 正常。** 继续测试 **Bash、MemoryManager 和管道类工具**：\n\n\n\n",
        "Historical assistant tool request (read-only context; do not repeat):\n",
        "tool_call_id: call_00_malformed_bash\n",
        "tool_name: Bash\n",
        "arguments:\n",
        "{\n",
        '  "command": "echo \'Node: $(node --version 2>/dev/null || echo "未安装")\'"\n',
        "}\n\n",
      ],
      toolCall,
    ),
  );
  const events = [];
  for await (const event of wrapped) {
    events.push(event);
  }

  const text = events
    .filter((event) => event.type === "text_delta")
    .map((event) => event.delta)
    .join("");
  assert.equal(text.includes("Historical assistant tool request"), false);
  assert.equal(text.includes("tool_name: Bash"), false);
  assert.equal(text.includes("未安装"), false);
  assert.equal(
    text,
    "**Edit / Write 正常。** 继续测试 **Bash、MemoryManager 和管道类工具**：\n\n\n\n",
  );

  const toolCallEvents = events.filter((event) => event.type === "toolcall_end");
  assert.equal(toolCallEvents.length, 1);
  assert.equal(toolCallEvents[0].toolCall.id, toolCall.id);
  assert.deepEqual(toolCallEvents[0].toolCall.arguments, toolCall.arguments);

  const final = await wrapped.result();
  assert.equal(final.stopReason, "toolUse");
  assert.deepEqual(
    final.content.map((block) => block.type),
    ["text", "toolCall"],
  );
});

test("DeepSeek DSML stream wrapper strips orphan DSML close tags after native tool calls", async () => {
  const toolCall = createToolCall("call_00_native_edit", "Edit", {
    path: "README.md",
    old_string: "old",
    new_string: "new",
  });
  const wrapped = wrapDeepSeekDsmlToolCallStream(
    createSourceStreamWithTextToolAndTrailingText(
      ["Bash 正常。继续：\n\n## 五、Edit — 精确字符串替换\n\n"],
      toolCall,
      [
        "\n</",
        dsml,
        "parameter>\n",
        "</",
        dsml,
        "invoke>\n",
        "</",
        dsml,
        "tool_calls>",
      ],
    ),
  );
  const events = [];
  for await (const event of wrapped) {
    events.push(event);
  }

  const text = events
    .filter((event) => event.type === "text_delta")
    .map((event) => event.delta)
    .join("");
  assert.equal(text.includes("DSML"), false);
  assert.equal(text.includes("tool_calls"), false);
  assert.equal(text, "Bash 正常。继续：\n\n## 五、Edit — 精确字符串替换\n\n");

  const toolCallEvents = events.filter((event) => event.type === "toolcall_end");
  assert.equal(toolCallEvents.length, 1);
  assert.equal(toolCallEvents[0].toolCall.id, toolCall.id);

  const final = await wrapped.result();
  assert.equal(final.stopReason, "toolUse");
  assert.deepEqual(
    final.content.map((block) => block.type),
    ["text", "toolCall"],
  );
  assert.equal(final.content[0].text.includes("DSML"), false);
});

test("DeepSeek DSML stream wrapper resolves transformed result without iteration", async () => {
  const wrapped = wrapDeepSeekDsmlToolCallStream(
    createSourceStream([
      `<${dsml}tool_calls>`,
      `<${dsml}invoke name="builtin_web_search">`,
      `<${dsml}parameter name="additionalContext" string="true">latest docs</${dsml}parameter>`,
      `</${dsml}invoke>`,
      `</${dsml}tool_calls>`,
    ]),
  );

  const final = await wrapped.result();
  assert.equal(final.stopReason, "toolUse");
  assert.equal(final.content.length, 1);
  assert.equal(final.content[0].type, "toolCall");
  assert.equal(final.content[0].name, "builtin_web_search");
});

test("DeepSeek DSML stream wrapper settles result when source closes without terminal event", async () => {
  const assistant = createAssistant("partial answer");
  const partial = {
    ...assistant,
    content: [{ type: "text", text: "" }],
  };
  const wrapped = wrapDeepSeekDsmlToolCallStream({
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: { ...assistant, content: [] } };
      yield { type: "text_start", contentIndex: 0, partial };
      partial.content[0].text = "partial answer";
      yield {
        type: "text_delta",
        contentIndex: 0,
        delta: "partial answer",
        partial,
      };
      yield {
        type: "text_end",
        contentIndex: 0,
        content: "partial answer",
        partial: assistant,
      };
    },
    async result() {
      return assistant;
    },
  });

  const final = await wrapped.result();
  assert.equal(final.stopReason, "stop");
  assert.deepEqual(final.content, [{ type: "text", text: "partial answer" }]);
});

test("DeepSeek DSML stream wrapper recovers Anthropic streams missing message_stop after content", async () => {
  const assistant = createAssistant("partial answer");
  const partial = {
    ...assistant,
    content: [{ type: "text", text: "" }],
  };
  const wrapped = wrapDeepSeekDsmlToolCallStream({
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: { ...assistant, content: [] } };
      yield { type: "text_start", contentIndex: 0, partial };
      partial.content[0].text = "partial ";
      yield {
        type: "text_delta",
        contentIndex: 0,
        delta: "partial ",
        partial: { ...partial, content: [{ ...partial.content[0] }] },
      };
      partial.content[0].text = "partial answer";
      yield {
        type: "text_delta",
        contentIndex: 0,
        delta: "answer",
        partial: { ...partial, content: [{ ...partial.content[0] }] },
      };
      throw new Error("Anthropic stream ended before message_stop");
    },
    async result() {
      return assistant;
    },
  });

  const events = [];
  for await (const event of wrapped) {
    events.push(event);
  }

  assert.equal(events.at(-1)?.type, "done");
  assert.equal(events.some((event) => event.type === "error"), false);
  assert.equal(
    events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.delta)
      .join(""),
    "partial answer",
  );

  const final = await wrapped.result();
  assert.equal(final.stopReason, "stop");
  assert.deepEqual(final.content, [{ type: "text", text: "partial answer" }]);
});

test("DeepSeek DSML stream wrapper keeps empty premature message_stop streams as errors", async () => {
  const assistant = createAssistant("");
  const wrapped = wrapDeepSeekDsmlToolCallStream({
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: { ...assistant, content: [] } };
      throw new Error("Anthropic stream ended before message_stop");
    },
    async result() {
      return assistant;
    },
  });

  const events = [];
  for await (const event of wrapped) {
    events.push(event);
  }

  assert.equal(events.at(-1)?.type, "error");
  const final = await wrapped.result();
  assert.equal(final.stopReason, "error");
  assert.match(final.errorMessage, /Anthropic stream ended before message_stop/);
});

test("DeepSeek DSML stream wrapper salvages a half-streamed native tool call without a toolcall_end", async () => {
  // Contract the tool-call argument guard relies on: a native tool call cut
  // off by a recoverable stream end is committed into `done` but never gets a
  // `toolcall_end` event, so downstream integrity checks can refuse it.
  const truncatedCall = createToolCall("call_00_cut", "Write", { path: "test2" });
  const assistant = createAssistantWithContent([truncatedCall]);
  const wrapped = wrapDeepSeekDsmlToolCallStream({
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: { ...assistant, content: [] } };
      yield { type: "toolcall_start", contentIndex: 0, partial: assistant };
      yield {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '{"path": "test2',
        partial: assistant,
      };
      throw new Error("Anthropic stream ended before message_stop");
    },
    async result() {
      return assistant;
    },
  });

  const events = [];
  for await (const event of wrapped) {
    events.push(event);
  }

  assert.equal(events.at(-1)?.type, "done");
  assert.equal(
    events.some((event) => event.type === "toolcall_end"),
    false,
  );
  const doneMessage = events.at(-1).message;
  const salvagedToolCall = doneMessage.content.find((block) => block.type === "toolCall");
  assert.ok(salvagedToolCall);
  assert.equal(salvagedToolCall.id, "call_00_cut");
});

test("streamAssistantMessage replies to recovered DeepSeek DSML tool calls before continuing", async () => {
  const streamQueue = [
    createSourceStream([
      "Searching ",
      `<${dsml}tool_calls>`,
      `<${dsml}invoke name="builtin_web_search">`,
      `<${dsml}parameter name="additionalContext" string="true">latest DeepSeek DSML fix</${dsml}parameter>`,
      `</${dsml}invoke>`,
      `</${dsml}tool_calls>`,
    ]),
    createSourceStream(["final answer with recovered context"]),
  ];
  const capturedContexts = [];
  const localLoader = createTsModuleLoader({
    mocks: {
      "@earendil-works/pi-ai": {
        getModel() {
          return undefined;
        },
      },
      "@earendil-works/pi-ai/api/anthropic-messages": {
        stream(_model, context) {
          capturedContexts.push(context);
          const stream = streamQueue.shift();
          if (!stream) throw new Error("No mocked Anthropic stream queued");
          return stream;
        },
      },
      [proxyModulePath]: {
        async prepareProxyRequest(_providerId, baseUrl) {
          return { baseUrl, headers: { "x-liveagent-test": "1" } };
        },
      },
      [powerActivityModulePath]: {
        async withPowerActivity(_scope, _reason, run) {
          return run();
        },
      },
    },
  });
  const providers = localLoader.loadModule("src/lib/providers/llm.ts");
  const textDeltas = [];

  const final = await providers.streamAssistantMessage({
    providerId: "claude_code",
    model: "deepseek-chat",
    runtime: {
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "test-key",
      requestFormat: "anthropic-messages",
      nativeWebSearchEnabled: true,
    },
    context: {
      messages: [{ role: "user", content: "Search latest DeepSeek DSML fix", timestamp: 1 }],
    },
    nativeWebSearch: true,
    onTextDelta(delta) {
      textDeltas.push(delta);
    },
  });

  assert.equal(final.stopReason, "stop");
  assert.deepEqual(
    final.content.map((block) => block.type),
    ["text"],
  );
  assert.equal(final.content[0].text, "final answer with recovered context");
  assert.equal(textDeltas.join(""), "Searching final answer with recovered context");
  assert.equal(capturedContexts.length, 2);

  const secondMessages = capturedContexts[1].messages;
  assert.equal(secondMessages.at(-2).role, "assistant");
  assert.deepEqual(
    secondMessages.at(-2).content.map((block) => block.type),
    ["text", "toolCall"],
  );
  assert.equal(secondMessages.at(-1).role, "toolResult");
  assert.equal(
    secondMessages.some((message) => JSON.stringify(message).includes(`<${dsml}`)),
    false,
  );
});

test("streamAssistantMessage normalizes recovered DeepSeek DSML tool calls from history", async () => {
  const pairedSearch = createToolCall("dsml-tool-call-paired", "builtin_web_search", {
    additionalContext: "already paired",
  });
  const missingSearch = createToolCall("dsml-tool-call-missing-search", "builtin_web_search", {
    additionalContext: "DeepSeek missing search result",
  });
  const missingLocalTool = createToolCall("dsml-tool-call-missing-read", "Read", {
    path: "README.md",
  });
  const incompleteAssistant = createAssistantWithContent(
    [{ type: "text", text: "Searching" }, pairedSearch, missingSearch, missingLocalTool],
    "toolUse",
  );
  const capturedContexts = [];
  const localLoader = createTsModuleLoader({
    mocks: {
      "@earendil-works/pi-ai": {
        getModel() {
          return undefined;
        },
      },
      "@earendil-works/pi-ai/api/anthropic-messages": {
        stream(_model, context) {
          capturedContexts.push(context);
          return createSourceStream(["answer after repaired history"]);
        },
      },
      [proxyModulePath]: {
        async prepareProxyRequest(_providerId, baseUrl) {
          return { baseUrl, headers: { "x-liveagent-test": "1" } };
        },
      },
      [powerActivityModulePath]: {
        async withPowerActivity(_scope, _reason, run) {
          return run();
        },
      },
    },
  });
  const providers = localLoader.loadModule("src/lib/providers/llm.ts");

  await providers.streamAssistantMessage({
    providerId: "claude_code",
    model: "deepseek-chat",
    runtime: {
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "test-key",
      requestFormat: "anthropic-messages",
    },
    context: {
      messages: [
        { role: "user", content: "previous search", timestamp: 1 },
        incompleteAssistant,
        createToolResult(pairedSearch, "already done"),
        { role: "user", content: "continue", timestamp: 4 },
      ],
    },
    onTextDelta() {},
  });

  assert.equal(capturedContexts.length, 1);
  const messages = capturedContexts[0].messages;
  const assistantIndex = messages.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.content.some((block) => block.type === "text" && block.text === "Searching") &&
      message.content.some(
        (block) => block.type === "toolCall" && block.id === missingLocalTool.id,
      ),
  );
  assert.ok(assistantIndex >= 0);
  assert.equal(
    messages.some((message) => message.role === "toolResult"),
    true,
  );
  assert.equal(
    messages.some(
      (message) =>
        message.role === "assistant" &&
        message.content.some((block) => block.type === "toolCall"),
    ),
    true,
  );
  assert.equal(messages[assistantIndex + 1].role, "toolResult");
  assert.equal(messages[assistantIndex + 2].role, "toolResult");
  assert.equal(messages[assistantIndex + 3].role, "toolResult");
  assert.equal(
    messages[assistantIndex + 3].toolCallId,
    missingLocalTool.id,
  );
  assert.equal(messages[assistantIndex + 3].isError, true);
});

test("completeAssistantMessage normalizes recovered DeepSeek DSML tool calls from history", async () => {
  const missingSearch = createToolCall("dsml-tool-call-complete-search", "builtin_web_search", {
    additionalContext: "DeepSeek complete missing result",
  });
  const incompleteAssistant = createAssistantWithContent([missingSearch], "toolUse");
  const capturedContexts = [];
  const localLoader = createTsModuleLoader({
    mocks: {
      "@earendil-works/pi-ai": {
        getModel() {
          return undefined;
        },
      },
      "@earendil-works/pi-ai/api/anthropic-messages": {
        stream(_model, context) {
          capturedContexts.push(context);
          return createSourceStream(["completed answer"]);
        },
      },
      [proxyModulePath]: {
        async prepareProxyRequest(_providerId, baseUrl) {
          return { baseUrl, headers: { "x-liveagent-test": "1" } };
        },
      },
      [powerActivityModulePath]: {
        async withPowerActivity(_scope, _reason, run) {
          return run();
        },
      },
    },
  });
  const providers = localLoader.loadModule("src/lib/providers/llm.ts");

  await providers.completeAssistantMessage({
    providerId: "claude_code",
    model: "deepseek-chat",
    runtime: {
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "test-key",
      requestFormat: "anthropic-messages",
    },
    context: {
      messages: [
        { role: "user", content: "previous search", timestamp: 1 },
        incompleteAssistant,
        { role: "user", content: "finish", timestamp: 3 },
      ],
    },
  });

  assert.equal(capturedContexts.length, 1);
  const messages = capturedContexts[0].messages;
  const assistantIndex = messages.findIndex((message) => message === incompleteAssistant);
  assert.equal(assistantIndex, 1);
  assert.equal(
    messages.some(
      (message) =>
        message.role === "toolResult" && message.toolCallId === missingSearch.id,
    ),
    true,
  );
  assert.equal(
    messages.some(
      (message) =>
        message.role === "assistant" &&
        message.content.some(
          (block) => block.type === "toolCall" && block.id === missingSearch.id,
        ),
    ),
    true,
  );
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "toolResult", "user"],
  );
});
