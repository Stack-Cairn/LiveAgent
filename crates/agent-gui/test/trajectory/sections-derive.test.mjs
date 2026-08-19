import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  buildTrajectoryHeader,
  composeTrajectorySystemPrompt,
  hashTrajectoryContent,
  serializeToolCatalog,
  trajectorySectionSlotAt,
} = loader.loadModule("@liveagent/ui/lib/trajectory/sections.ts");
const { buildTrajectoryLedger } = loader.loadModule(
  "@liveagent/ui/lib/trajectory/eventLog.ts",
);
const { deriveLedgerFromMessages, mergeTrajectoryLedgerWithMessages } = loader.loadModule(
  "@liveagent/ui/lib/trajectory/fromMessages.ts",
);
const { buildTrajectoryContentIndex, walkTrajectoryTurns } = loader.loadModule(
  "@liveagent/ui/lib/trajectory/contentIndex.ts",
);
const { deriveTrajectoryLayout, flattenTrajectoryRecords, stepKey } = loader.loadModule(
  "@liveagent/ui/lib/trajectory/layout.ts",
);

test("identical content hashes identically and differing content does not", () => {
  assert.equal(hashTrajectoryContent("abc"), hashTrajectoryContent("abc"));
  assert.notEqual(hashTrajectoryContent("abc"), hashTrajectoryContent("abd"));
  assert.equal(hashTrajectoryContent("").length, 64);
  assert.equal(
    hashTrajectoryContent(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    hashTrajectoryContent("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("hashing is stable for long multi-byte content", () => {
  const long = "系统提示词".repeat(5_000);
  assert.equal(hashTrajectoryContent(long), hashTrajectoryContent(long));
  assert.notEqual(hashTrajectoryContent(long), hashTrajectoryContent(`${long}x`));
});

test("runtime is appended on the wire but reconstructed before tool rules", () => {
  const built = buildTrajectoryHeader({
    base: " BASE ",
    memory: "MEMORY",
    runtime: " RUNTIME ",
    toolsSuffix: "TOOLS-SUFFIX\n",
    toolCatalog: "CATALOG",
  });
  assert.equal(trajectorySectionSlotAt(4), "toolsSuffix");
  assert.equal(trajectorySectionSlotAt(5), "toolCatalog");
  assert.equal(trajectorySectionSlotAt(6), "runtime");
  assert.equal(
    composeTrajectorySystemPrompt({
      base: " BASE ",
      memory: "MEMORY",
      runtime: " RUNTIME ",
      toolsSuffix: "TOOLS-SUFFIX\n",
    }),
    "BASE\n\nMEMORY\n\nRUNTIME\n\nTOOLS-SUFFIX\n",
  );
  assert.equal(built.refs.length, 7);
});

test("a whitespace-only tool suffix is absent just like the provider boundary", () => {
  assert.equal(
    composeTrajectorySystemPrompt({ base: "BASE", toolsSuffix: "  \n  " }),
    "BASE",
  );
});

test("adding an empty appended runtime slot does not invent a prompt change", () => {
  const previous = buildTrajectoryHeader({
    base: "BASE",
    toolsSuffix: "SUFFIX",
    toolCatalog: "CATALOG",
  });
  const legacyPrevious = { headerId: previous.headerId, refs: previous.refs.slice(0, 6) };
  const current = buildTrajectoryHeader(
    { base: "BASE", toolsSuffix: "SUFFIX", toolCatalog: "CATALOG" },
    legacyPrevious,
  );
  assert.equal(current.change, "none");
});

test("old six-slot headers keep their tools indexes after runtime was added", () => {
  const legacy = ["s_base", null, null, null, "s_suffix", "s_catalog"];
  assert.equal(legacy[4], "s_suffix");
  assert.equal(trajectorySectionSlotAt(4), "toolsSuffix");
  assert.equal(legacy[5], "s_catalog");
  assert.equal(trajectorySectionSlotAt(5), "toolCatalog");
  assert.equal(legacy[6], undefined);
});

test("only the changed slot is reported for persistence", () => {
  const first = buildTrajectoryHeader({
    base: "BASE",
    skills: "SKILLS",
    memory: "MEM-1",
    toolCatalog: "TOOLS",
  });
  assert.equal(first.change, "initial");
  assert.equal(first.sections.length, 4);

  const second = buildTrajectoryHeader(
    { base: "BASE", skills: "SKILLS", memory: "MEM-2", toolCatalog: "TOOLS" },
    { headerId: first.headerId, refs: first.refs },
  );
  // memory 每轮重渲染，是唯一常变的槽位——只有它需要新落盘。
  assert.equal(second.sections.length, 1);
  assert.equal(second.sections[0].slot, "memory");
  assert.equal(second.change, "system");
  assert.notEqual(second.headerId, first.headerId);
});

test("an unchanged prompt reuses the same header id and writes nothing", () => {
  const input = { base: "BASE", memory: "MEM", toolCatalog: "TOOLS" };
  const first = buildTrajectoryHeader(input);
  const second = buildTrajectoryHeader(input, { headerId: first.headerId, refs: first.refs });
  assert.equal(second.headerId, first.headerId);
  assert.equal(second.sections.length, 0);
  assert.equal(second.change, "none");
});

test("tool catalog changes classify as tools, not system", () => {
  const first = buildTrajectoryHeader({ base: "BASE", toolCatalog: "T1" });
  const second = buildTrajectoryHeader(
    { base: "BASE", toolCatalog: "T2" },
    { headerId: first.headerId, refs: first.refs },
  );
  assert.equal(second.change, "tools");

  const third = buildTrajectoryHeader(
    { base: "BASE-2", toolCatalog: "T3" },
    { headerId: second.headerId, refs: second.refs },
  );
  assert.equal(third.change, "system-and-tools");
});

test("blank and whitespace-only slots collapse to an absent reference", () => {
  const built = buildTrajectoryHeader({ base: "BASE", agent: "   ", skills: undefined });
  assert.equal(built.refs[trajectorySectionSlotIndex("agent")], null);
  assert.equal(built.refs[trajectorySectionSlotIndex("skills")], null);
  assert.equal(built.sections.length, 1);
});


test("non-empty model-visible whitespace is preserved exactly", () => {
  const content = "  BASE\n";
  const built = buildTrajectoryHeader({ base: content });
  assert.equal(built.sections[0].content, content);
  assert.equal(built.sections[0].sectionId, `s_${hashTrajectoryContent(content).slice(0, 16)}`);
});

function trajectorySectionSlotIndex(slot) {
  for (let index = 0; index < 7; index += 1) {
    if (trajectorySectionSlotAt(index) === slot) return index;
  }
  throw new Error(`unknown slot ${slot}`);
}

test("tool catalog serialization ignores registration and nested object-key order", () => {
  const a = serializeToolCatalog([
    {
      name: "Bash",
      description: "run",
      parameters: { required: ["cmd"], properties: { cmd: { type: "string" } }, type: "object" },
    },
    { name: "Read", description: "read", parameters: { type: "object" } },
  ]);
  const b = serializeToolCatalog([
    { name: "Read", description: "read", parameters: { type: "object" } },
    {
      name: "Bash",
      description: "run",
      parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
    },
  ]);
  assert.equal(a, b);
  assert.equal(serializeToolCatalog([]), undefined);
  assert.equal(serializeToolCatalog(undefined), undefined);
});

test("tool catalog serialization survives circular schemas", () => {
  const circular = { type: "object" };
  circular.self = circular;
  const serialized = serializeToolCatalog([{ name: "Loop", parameters: circular }]);
  assert.equal(serialized, '["Loop"]');
});

function toolBlock(id, name, resultText, isError = false) {
  return {
    kind: "tool",
    item: {
      toolCall: { id, name, arguments: { path: "a.txt" } },
      toolResult:
        resultText === undefined
          ? undefined
          : {
              role: "toolResult",
              toolCallId: id,
              toolName: name,
              content: [{ type: "text", text: resultText }],
              isError,
              timestamp: 1,
            },
    },
  };
}

function messagesFixture() {
  return [
    { key: "u1", role: "user", text: "first ask", messageIndex: 0 },
    {
      key: "a1",
      role: "assistant",
      text: "",
      rounds: [
        {
          round: 1,
          blocks: [
            { kind: "text", id: "t1", text: "thinking out loud" },
            toolBlock("c1", "Read", "file body"),
          ],
          meta: { provider: "claude_code", model: "opus", usage: { input: 10, output: 4 } },
        },
        {
          round: 2,
          blocks: [{ kind: "text", id: "t2", text: "done" }],
          meta: { stopReason: "endTurn" },
        },
      ],
    },
    { key: "u2", role: "user", text: "second ask", messageIndex: 2 },
    {
      key: "a2",
      role: "assistant",
      text: "",
      rounds: [{ round: 1, blocks: [toolBlock("c2", "Bash", "boom", true)] }],
    },
  ];
}

test("turns are cut on user message boundaries", () => {
  const walked = walkTrajectoryTurns(messagesFixture());
  assert.deepEqual(
    walked.map((entry) => entry.turn),
    [1, 2],
  );
  assert.equal(walked[0].assistants.length, 1);
});

test("turn walking backfills unrecorded visible turns from the first absolute anchor", () => {
  const entries = walkTrajectoryTurns(
    [
      { key: "u90", role: "user", text: "old 90", messageId: "u90" },
      { key: "a90", role: "assistant", text: "", rounds: [] },
      { key: "u91", role: "user", text: "old 91", messageId: "u91" },
      { key: "a91", role: "assistant", text: "", rounds: [] },
      { key: "u92", role: "user", text: "old 92", messageId: "u92" },
      { key: "a92", role: "assistant", text: "", rounds: [] },
      { key: "u93", role: "user", text: "recorded 93", messageId: "u93" },
    ],
    new Map([["u93", 93]]),
  );
  assert.deepEqual(
    entries.map((entry) => entry.turn),
    [90, 91, 92, 93],
  );
});

test("mixed legacy and recorded history keeps old turns and real timing together", () => {
  const recorded = buildTrajectoryLedger([
    { k: "user", t: 93, at: 100, id: "u93" },
    { k: "step_start", t: 93, s: 1, at: 110 },
    { k: "step_end", t: 93, s: 1, at: 150, st: "complete" },
    { k: "turn_end", t: 93, at: 160, st: "complete" },
  ]);
  const messages = [
    { key: "u91", role: "user", text: "legacy 91", messageId: "u91" },
    { key: "a91", role: "assistant", text: "", rounds: [{ round: 1, blocks: [] }] },
    { key: "u92", role: "user", text: "legacy 92", messageId: "u92" },
    { key: "a92", role: "assistant", text: "", rounds: [{ round: 1, blocks: [] }] },
    { key: "u93", role: "user", text: "recorded 93", messageId: "u93" },
    { key: "a93", role: "assistant", text: "", rounds: [{ round: 1, blocks: [] }] },
  ];
  const merged = mergeTrajectoryLedgerWithMessages(recorded, messages);
  assert.deepEqual(
    merged.turns.map((turn) => turn.turn),
    [91, 92, 93],
  );
  assert.equal(merged.turns[0].steps[0].startedAt, null);
  assert.equal(merged.turns[2].steps[0].startedAt, 110);
  assert.equal(merged.hasTiming, true);
});

test("a tail history window joins content to its absolute trajectory turn by message id", () => {
  const ledger = buildTrajectoryLedger([
    { k: "user", t: 93, at: 100, mi: 812, id: "user-93" },
    { k: "step_start", t: 93, s: 1, at: 110 },
    { k: "step_end", t: 93, s: 1, at: 150, st: "complete" },
    { k: "turn_end", t: 93, at: 160, st: "complete" },
  ]);
  const messages = [
    { key: "tail-user", role: "user", text: "absolute question", messageId: "user-93" },
    {
      key: "tail-assistant",
      role: "assistant",
      text: "",
      rounds: [{ round: 1, blocks: [{ kind: "text", id: "tail-text", text: "absolute answer" }] }],
    },
  ];
  const content = buildTrajectoryContentIndex(messages, ledger);
  const records = flattenTrajectoryRecords(deriveTrajectoryLayout({ ledger, content }));
  assert.equal(records.find((record) => record.kind === "user")?.turn, 93);
  assert.equal(records.find((record) => record.kind === "user")?.text, "absolute question");
  assert.equal(records.find((record) => record.kind === "message")?.turn, 93);
  assert.equal(records.find((record) => record.kind === "message")?.text, "absolute answer");
});

test("a leading assistant with no user message still lands in turn 1", () => {
  const walked = walkTrajectoryTurns([
    { key: "a0", role: "assistant", text: "", rounds: [{ round: 1, blocks: [] }] },
  ]);
  assert.equal(walked.length, 1);
  assert.equal(walked[0].turn, 1);
  assert.equal(walked[0].user, undefined);
});

test("derived ledger keeps structure and refuses to invent timing", () => {
  const ledger = deriveLedgerFromMessages(messagesFixture());
  assert.equal(ledger.hasTiming, false);
  assert.equal(ledger.turns.length, 2);
  assert.deepEqual(
    ledger.turns[0].steps.map((step) => step.step),
    [1, 2],
  );
  const everyTimeIsNull = ledger.turns.every(
    (turn) =>
      turn.startedAt === null &&
      turn.steps.every(
        (step) =>
          step.startedAt === null &&
          step.endedAt === null &&
          step.firstTokenAt === null &&
          step.tools.every((tool) => tool.startedAt === null && tool.endedAt === null),
      ),
  );
  assert.equal(everyTimeIsNull, true);
});

test("derived ledger carries provider metadata and usage from round meta", () => {
  const step = deriveLedgerFromMessages(messagesFixture()).turns[0].steps[0];
  assert.equal(step.provider, "claude_code");
  assert.equal(step.model, "opus");
  assert.deepEqual(step.usage, { input: 10, output: 4 });
});

test("derived tool status distinguishes error, success and interruption", () => {
  const ledger = deriveLedgerFromMessages([
    ...messagesFixture(),
    {
      key: "a3",
      role: "assistant",
      text: "",
      rounds: [{ round: 1, blocks: [toolBlock("c3", "Glob", undefined)] }],
    },
  ]);
  assert.equal(ledger.turns[0].steps[0].tools[0].status, "complete");
  assert.equal(ledger.turns[1].steps[0].tools[0].status, "error");
  assert.equal(ledger.turns[1].steps[1].tools[0].status, "aborted");
});

test("derived ledger renders through the same layout path as recorded events", () => {
  const messages = messagesFixture();
  const turns = deriveTrajectoryLayout({
    ledger: deriveLedgerFromMessages(messages),
    content: buildTrajectoryContentIndex(messages),
  });
  const records = flattenTrajectoryRecords(turns);
  assert.ok(records.length > 0);
  assert.ok(records.every((record) => record.timeSeconds === null));
  assert.equal(records.filter((record) => record.kind === "system").length, 0);
  assert.equal(records.find((record) => record.kind === "user").text, "first ask");
  assert.equal(records.find((record) => record.kind === "message").text, "thinking out loud");
});

test("content index keys assistant text by turn and step", () => {
  const index = buildTrajectoryContentIndex(messagesFixture());
  assert.equal(index.userByTurn.get(1).text, "first ask");
  assert.equal(index.assistantByStep.get(stepKey(1, 1)).text, "thinking out loud");
  assert.equal(index.assistantByStep.get(stepKey(1, 2)).text, "done");
  const toolOnly = index.assistantByStep.get(stepKey(2, 1));
  assert.equal(toolOnly.text, undefined);
  assert.equal(toolOnly.blocks[0].type, "tool-call");
  assert.equal(toolOnly.blocks[0].toolName, "Bash");
});

test("user attachment blocks preserve a safe relative file target for trajectory details", () => {
  const index = buildTrajectoryContentIndex([
    {
      key: "u-attachment",
      role: "user",
      text: "see attachment",
      attachments: [
        {
          kind: "text",
          fileName: "notes.md",
          relativePath: "docs/notes.md",
          sizeBytes: 42,
        },
      ],
    },
  ]);
  const attachment = index.userByTurn
    .get(1)
    .blocks.find((block) => block.type === "attachment:text");
  assert.equal(attachment.filePath, "docs/notes.md");
  assert.equal(attachment.fileSource, "relative");
  assert.equal(attachment.imageAlt, "notes.md");
});

test("content index exposes tool args and results by call id", () => {
  const index = buildTrajectoryContentIndex(messagesFixture());
  const read = index.toolByCallId.get("c1");
  assert.match(read.args, /a\.txt/);
  assert.equal(read.result.includes("file body"), true);
  assert.equal(read.isError, undefined);
  assert.equal(index.toolByCallId.get("c2").isError, true);
});


test("storage and model prompt slot orders stay independently compatible", () => {
  const types = loader.loadModule("@liveagent/ui/lib/trajectory/types.ts");
  const sections = loader.loadModule("@liveagent/ui/lib/trajectory/sections.ts");
  assert.deepEqual([...types.TRAJECTORY_SECTION_SLOTS], [
    "base",
    "agent",
    "skills",
    "memory",
    "toolsSuffix",
    "toolCatalog",
    "runtime",
  ]);
  assert.deepEqual([...sections.TRAJECTORY_SYSTEM_PROMPT_SLOTS], [
    "base",
    "agent",
    "skills",
    "memory",
    "runtime",
    "toolsSuffix",
  ]);
});
