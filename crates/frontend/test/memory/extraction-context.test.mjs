import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const context = loader.loadModule("src/lib/memory/extraction/context.ts");
const { buildConversationWindowBlock, deriveWorkspaceMutations, extractLatestUserText } = context;

const WORKDIR = "/Users/dev/project";

function user(text) {
  return { role: "user", content: text, timestamp: 1 };
}
function assistant(text, toolCalls = []) {
  return {
    role: "assistant",
    content: [...(text ? [{ type: "text", text }] : []), ...toolCalls],
    timestamp: 1,
  };
}
function toolCall(id, name, args) {
  return { type: "toolCall", id, name, arguments: args };
}
function toolResult(id, name, isError = false) {
  return { role: "toolResult", toolCallId: id, toolName: name, content: [], isError, timestamp: 1 };
}

test("extractLatestUserText reads the newest non-empty user message", () => {
  const messages = [user("first"), assistant("a"), user("second"), assistant("b")];
  assert.equal(extractLatestUserText(messages), "second");
  assert.equal(extractLatestUserText([assistant("only")]), "");
});

test("window keeps the last K user turns with role labels", () => {
  const messages = [];
  for (let i = 1; i <= 6; i++) {
    messages.push(user(`question ${i}`));
    messages.push(assistant(`answer ${i}`));
  }
  const block = buildConversationWindowBlock(messages, { turns: 4 });
  assert.ok(block.startsWith("<conversation-window>"));
  assert.ok(block.includes("[user] question 3"));
  assert.ok(block.includes("[user] question 6"));
  assert.ok(!block.includes("question 2"));
  assert.ok(block.includes("[assistant] answer 6"));
});

test("per-message and window caps truncate from the front", () => {
  const long = "x".repeat(5_000);
  const messages = [user(long), assistant(long), user("final short question")];
  const block = buildConversationWindowBlock(messages, {
    turns: 4,
    messageCharCap: 500,
    windowCharCap: 900,
  });
  assert.ok(block.length < 1_200);
  // the latest user message always survives
  assert.ok(block.includes("final short question"));
  assert.ok(block.includes("(earlier context trimmed)") || !block.includes("[user] xxxx"));
});

test("tool calls render as one-liners inside the window", () => {
  const messages = [
    user("edit the file"),
    assistant("doing it", [toolCall("t1", "Edit", { file_path: "src/a.ts" })]),
    toolResult("t1", "Edit"),
  ];
  const block = buildConversationWindowBlock(messages);
  assert.ok(block.includes("[tool-call] Edit src/a.ts"));
  assert.ok(block.includes("[tool-result] Edit → ok"));
});

test("workspace mutations: successful Write/Edit inside workdir qualify", () => {
  const messages = [
    user("do it"),
    assistant("", [
      toolCall("t1", "Edit", { file_path: `${WORKDIR}/src/foo.ts` }),
      toolCall("t2", "Write", { file_path: "/elsewhere/outside.ts" }),
      toolCall("t3", "Read", { file_path: `${WORKDIR}/src/foo.ts` }),
    ]),
    toolResult("t1", "Edit"),
    toolResult("t2", "Write"),
    toolResult("t3", "Read"),
  ];
  const mutations = deriveWorkspaceMutations(messages, WORKDIR);
  assert.deepEqual(mutations, ["Edit src/foo.ts"]);
});

test("workspace mutations: failed calls are excluded", () => {
  const messages = [
    user("do it"),
    assistant("", [toolCall("t1", "Edit", { file_path: `${WORKDIR}/src/foo.ts` })]),
    toolResult("t1", "Edit", true),
  ];
  assert.deepEqual(deriveWorkspaceMutations(messages, WORKDIR), []);
});

test("workspace mutations: Bash mutation heuristic", () => {
  const messages = [
    user("install it"),
    assistant("", [
      toolCall("t1", "Bash", { command: "pnpm add lodash" }),
      toolCall("t2", "Bash", { command: "git status" }),
    ]),
    toolResult("t1", "Bash"),
    toolResult("t2", "Bash"),
  ];
  const mutations = deriveWorkspaceMutations(messages, WORKDIR);
  assert.equal(mutations.length, 1);
  assert.ok(mutations[0].startsWith("Bash: pnpm add lodash"));
});

test("workspace mutations: only the LAST turn is scanned; no workdir → none", () => {
  const messages = [
    user("earlier turn"),
    assistant("", [toolCall("t1", "Edit", { file_path: `${WORKDIR}/src/old.ts` })]),
    toolResult("t1", "Edit"),
    user("new turn, read only"),
    assistant("done"),
  ];
  assert.deepEqual(deriveWorkspaceMutations(messages, WORKDIR), []);
  assert.deepEqual(deriveWorkspaceMutations(messages, undefined), []);
});
