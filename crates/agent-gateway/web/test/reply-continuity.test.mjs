import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const loader = createWebModuleLoader({ rootDir });
const {
  assembleContinuousReply,
  createCompactionSeamRound,
  getCompactionSeam,
  rekeyContinuationRounds,
  stitchCompactedReplies,
} = loader.loadModule("@liveagent/ui/lib/chat/replyContinuity.ts");
const { resolveAssistantTurnLayout, resolveActiveWorkEntry } = loader.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils.ts",
);
const { collectChangedFiles } = loader.loadModule("@liveagent/ui/lib/chat/changedFiles.ts");

const classify = (item) => item.kind;

function seam(key = "cp-1") {
  return {
    key,
    summaryId: key,
    content: "summary body",
    coveredMessageCount: 12,
    generatedBy: { providerId: "deepseek", model: "deepseek-v4-flash" },
    contextUsageTokens: 18_400,
  };
}

function textRound(round, text) {
  return { round, key: `r${round}`, blocks: [{ kind: "text", id: "text-1", text }] };
}

function editRound(round, id, path) {
  return {
    round,
    key: `r${round}`,
    blocks: [
      {
        kind: "tool",
        item: {
          toolCall: {
            type: "toolCall",
            id,
            name: "Write",
            arguments: { path, content: "a\nb\n" },
          },
          toolResult: {
            role: "toolResult",
            toolCallId: id,
            isError: false,
            content: [],
            details: { path },
          },
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Grouping

test("a checkpoint between two assistant parts stitches them into one reply", () => {
  const items = [
    { kind: "user", id: "u1" },
    { kind: "assistant", id: "a1" },
    { kind: "checkpoint", id: "c1" },
    { kind: "assistant", id: "a2" },
    { kind: "user", id: "u2" },
    { kind: "assistant", id: "a3" },
  ];
  const groups = stitchCompactedReplies(items, classify);
  assert.deepEqual(
    groups.map((group) => (group.kind === "single" ? group.item.id : group.items.map((i) => i.id))),
    ["u1", ["a1", "c1", "a2"], "u2", "a3"],
  );
});

test("a trailing checkpoint stays a standalone divider", () => {
  const items = [
    { kind: "user", id: "u1" },
    { kind: "assistant", id: "a1" },
    { kind: "checkpoint", id: "c1" },
    { kind: "user", id: "u2" },
  ];
  const groups = stitchCompactedReplies(items, classify);
  assert.deepEqual(
    groups.map((group) => (group.kind === "single" ? group.item.id : group.items.map((i) => i.id))),
    ["u1", "a1", "c1", "u2"],
  );
});

test("an idle manual compaction (checkpoint with no reply around it) is untouched", () => {
  const items = [
    { kind: "user", id: "u1" },
    { kind: "assistant", id: "a1" },
    { kind: "checkpoint", id: "c1" },
  ];
  const groups = stitchCompactedReplies(items, classify);
  assert.deepEqual(
    groups.map((group) => group.kind),
    ["single", "single", "single"],
  );
});

test("a leading checkpoint folds into the reply it precedes", () => {
  const items = [
    { kind: "user", id: "u1" },
    { kind: "checkpoint", id: "c1" },
    { kind: "assistant", id: "a1" },
  ];
  const groups = stitchCompactedReplies(items, classify);
  assert.equal(groups[1].kind, "reply");
  assert.deepEqual(
    groups[1].items.map((item) => item.id),
    ["c1", "a1"],
  );
});

test("two compactions inside one reply produce one group with two seams", () => {
  const items = [
    { kind: "assistant", id: "a1" },
    { kind: "checkpoint", id: "c1" },
    { kind: "assistant", id: "a2" },
    { kind: "checkpoint", id: "c2" },
    { kind: "assistant", id: "a3" },
  ];
  const groups = stitchCompactedReplies(items, classify);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 5);
});

// ---------------------------------------------------------------------------
// Assembly & re-keying

test("assembly interleaves seam rounds and re-keys continuation parts positionally", () => {
  const reply = assembleContinuousReply(
    [
      { kind: "assistant", rounds: [textRound(1, "a"), textRound(2, "b")] },
      { kind: "checkpoint", seam: seam("cp-1") },
      { kind: "assistant", rounds: [textRound(1, "c")] },
    ],
    {
      classify,
      roundsOf: (item) => item.rounds,
      seamOf: (item) => item.seam,
      rekeyParts: true,
    },
  );
  assert.deepEqual(
    reply.rounds.map((round) => round.key),
    ["r1", "r2", "cp-1", "p1:r1"],
  );
  assert.equal(reply.partCount, 2);
  assert.equal(reply.seamCount, 1);
  assert.equal(getCompactionSeam(reply.rounds[2]).summaryId, "cp-1");
  assert.equal(getCompactionSeam(reply.rounds[0]), null);
});

test("re-keying is identity-stable and leaves the first part alone", () => {
  const rounds = [textRound(1, "x")];
  assert.equal(rekeyContinuationRounds(rounds, 0), rounds);
  const first = rekeyContinuationRounds(rounds, 2);
  const second = rekeyContinuationRounds(rounds, 2);
  assert.equal(first[0], second[0]);
  assert.equal(first[0].key, "p2:r1");
});

test("seam rounds are cached per seam payload", () => {
  const payload = seam();
  assert.equal(createCompactionSeamRound(payload), createCompactionSeamRound(payload));
  assert.deepEqual(createCompactionSeamRound(payload).blocks, []);
});

// ---------------------------------------------------------------------------
// Layout & aggregation across the seam

test("turn layout renders the seam as a work entry and keeps the final answer after it", () => {
  const rounds = [
    editRound(1, "w1", "src/a.ts"),
    createCompactionSeamRound(seam("cp-1")),
    { ...editRound(1, "w2", "src/b.ts"), key: "p1:r1", meta: { stopReason: "toolUse" } },
    { ...textRound(2, "done"), key: "p1:r2", meta: { stopReason: "stop" } },
  ];
  const layout = resolveAssistantTurnLayout(rounds, { live: false });
  assert.deepEqual(
    layout.work.map((entry) => entry.block.kind),
    ["toolGroup", "checkpoint", "toolGroup"],
  );
  assert.equal(layout.work[1].block.seam.summaryId, "cp-1");
  assert.deepEqual(
    layout.answer.map((entry) => entry.block.text),
    ["done"],
  );
  assert.equal(resolveActiveWorkEntry([layout.work[1]]), null);
});

test("changed files aggregate across both halves of a stitched reply", () => {
  const rounds = [
    editRound(1, "w1", "src/a.ts"),
    createCompactionSeamRound(seam("cp-1")),
    { ...editRound(1, "w2", "src/b.ts"), key: "p1:r1" },
  ];
  const summary = collectChangedFiles(rounds);
  assert.deepEqual(
    summary.files.map((file) => file.path),
    ["src/a.ts", "src/b.ts"],
  );
});
