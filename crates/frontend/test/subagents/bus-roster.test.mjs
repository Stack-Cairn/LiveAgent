import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const bus = loader.loadModule("src/lib/subagents/bus.ts");
const roster = loader.loadModule("src/lib/subagents/roster.ts");

let nextSeq = 0;
function makeMessage(overrides = {}) {
  nextSeq += 1;
  return {
    id: nextSeq,
    parentConversationId: "conversation-1",
    seq: overrides.seq ?? nextSeq,
    senderId: overrides.senderId ?? "agent-x",
    senderName: overrides.senderName,
    recipientId: overrides.recipientId ?? "agent-a",
    recipientName: overrides.recipientName,
    channel: overrides.channel ?? "direct",
    subject: overrides.subject,
    bodyMarkdown: overrides.bodyMarkdown ?? `message body ${nextSeq}`,
    createdAt: overrides.createdAt ?? 1_700_000_000_000 + nextSeq,
  };
}

function render(messages, overrides = {}) {
  return bus.renderMessageBusSnapshot({
    messages,
    currentAgentId: overrides.currentAgentId ?? "agent-a",
    currentAgentName: overrides.currentAgentName,
    maxMessages: overrides.maxMessages,
    maxBodyChars: overrides.maxBodyChars,
  });
}

test("snapshot buckets messages into direct inbox, shared decisions, open questions, and recent", () => {
  const snapshot = render([
    makeMessage({ recipientId: "agent-a", channel: "direct", bodyMarkdown: "direct for a" }),
    makeMessage({ recipientId: "*", channel: "decision", bodyMarkdown: "team decision" }),
    makeMessage({ recipientId: "*", channel: "question", bodyMarkdown: "open question" }),
    makeMessage({
      senderId: "agent-a",
      recipientId: "*",
      channel: "shared",
      bodyMarkdown: "note from a",
    }),
  ]);

  assert.match(snapshot, /## LiveAgent Message Bus/);
  assert.match(snapshot, /Current agent: `agent-a`/);
  const inboxIndex = snapshot.indexOf("### Direct Inbox for agent-a");
  const decisionsIndex = snapshot.indexOf("### Shared Decisions");
  const questionsIndex = snapshot.indexOf("### Open Questions");
  const recentIndex = snapshot.indexOf("### Recent Messages");
  assert.ok(inboxIndex >= 0 && decisionsIndex > inboxIndex);
  assert.ok(questionsIndex > decisionsIndex && recentIndex > questionsIndex);
  assert.match(snapshot, /> direct for a/);
  assert.match(snapshot, /> team decision/);
  assert.match(snapshot, /> open question/);
  assert.match(snapshot, /> note from a/);
});

test("direct messages addressed to other agents are invisible", () => {
  const snapshot = render([
    makeMessage({ recipientId: "agent-b", bodyMarkdown: "secret for b" }),
    makeMessage({ recipientId: "agent-a", bodyMarkdown: "hello a" }),
  ]);
  assert.doesNotMatch(snapshot, /secret for b/);
  assert.match(snapshot, /hello a/);

  const nothingVisible = render([
    makeMessage({ recipientId: "agent-b", bodyMarkdown: "b only" }),
  ]);
  assert.equal(nothingVisible, "");
});

test("maxMessages caps the snapshot and prioritizes the direct inbox", () => {
  const messages = [
    makeMessage({ recipientId: "agent-a", bodyMarkdown: "inbox one" }),
    makeMessage({ recipientId: "agent-a", bodyMarkdown: "inbox two" }),
    makeMessage({ recipientId: "*", channel: "decision", bodyMarkdown: "decision one" }),
    makeMessage({ recipientId: "*", channel: "shared", bodyMarkdown: "shared chatter" }),
  ];
  const snapshot = render(messages, { maxMessages: 2 });
  assert.match(snapshot, /inbox one/);
  assert.match(snapshot, /inbox two/);
  assert.doesNotMatch(snapshot, /decision one/);
  assert.doesNotMatch(snapshot, /shared chatter/);
  // Each rendered message appears exactly once even though buckets overlap.
  assert.equal(snapshot.match(/#### #/g).length, 2);
});

test("long bodies are truncated with the original char count", () => {
  const longBody = "x".repeat(500);
  const snapshot = render(
    [makeMessage({ recipientId: "agent-a", bodyMarkdown: longBody })],
    { maxBodyChars: 100 },
  );
  assert.match(snapshot, /\[message truncated; original chars=500\]/);
  assert.doesNotMatch(snapshot, /x{200}/);
});

test("labels escape markdown and bodies are block-quoted", () => {
  const snapshot = render(
    [
      makeMessage({
        senderId: "agent-x",
        senderName: "Spicy *Name* [link]",
        recipientId: "agent-a",
        subject: "About #headers",
        bodyMarkdown: "line one\nline two",
      }),
    ],
    { currentAgentName: "Agent`A`" },
  );
  assert.match(snapshot, /\*\*Spicy \\\*Name\\\* \\\[link\\\]\*\* \(`agent-x`\)/);
  assert.match(snapshot, /- Subject: About \\#headers/);
  assert.match(snapshot, /> line one\n> line two/);
  assert.match(snapshot, /Current agent: \*\*Agent\\`A\\`\*\* \(`agent-a`\)/);
});

test("snapshot is empty without a current agent or matching messages", () => {
  assert.equal(render([makeMessage()], { currentAgentId: "  " }), "");
  assert.equal(render([]), "");
  assert.equal(
    render([makeMessage({ recipientId: "agent-a", bodyMarkdown: "   " })]),
    "",
  );
});

test("formatRoster and formatTemplates render bounded description blocks", () => {
  assert.equal(
    roster.formatRoster([]),
    "No existing agents are recorded for this parent conversation.",
  );
  const rosterText = roster.formatRoster([
    {
      id: "agent-a",
      name: "Agent A",
      role: "Research",
      lastMode: "readonly",
      lastStatus: "completed",
      lastSummary: "Found three issues",
    },
    { id: "agent-b", name: "Agent B", role: "Builder", lastMode: "worktree" },
  ]);
  assert.match(
    rosterText,
    /id=agent-a name=Agent A role=Research mode=readonly status=completed summary=Found three issues/,
  );
  assert.match(rosterText, /id=agent-b name=Agent B role=Builder mode=worktree$/m);

  const manyEntries = Array.from({ length: 15 }, (_, index) => ({
    id: `agent-${index}`,
    name: `Agent ${index}`,
    role: "R",
    lastMode: "readonly",
  }));
  assert.equal(roster.formatRoster(manyEntries).split("\n").length, 12);

  assert.equal(roster.formatTemplates([]), "No enabled AGENTS templates are available.");
  assert.equal(
    roster.formatTemplates([
      { id: "reviewer", name: "Reviewer", description: "Review code" },
      { id: "bare", name: "Bare" },
    ]),
    "reviewer (Reviewer) - Review code\nbare (Bare)",
  );
});

test("buildRosterReminder lists agents with latest-run fields and truncates long values", () => {
  assert.equal(
    roster.buildRosterReminder({ identities: [], latestRunsByAgent: new Map() }),
    "",
  );

  const longRole = "very long role ".repeat(30);
  const identities = [
    {
      parentConversationId: "conversation-1",
      agentId: "agent-a",
      name: "Agent A",
      role: longRole,
      identityPrompt: "",
      lastMode: "readonly",
      createdAt: 1,
      updatedAt: 2,
    },
  ];
  const latestRunsByAgent = new Map([
    [
      "agent-a",
      {
        id: "run-1",
        agentId: "agent-a",
        status: "completed",
        prompt: "multi\nline   prompt " + "p".repeat(500),
        summary: "s".repeat(500),
      },
    ],
  ]);
  const reminder = roster.buildRosterReminder({ identities, latestRunsByAgent });
  assert.match(reminder, /Existing delegated agents in this parent conversation:/);
  assert.match(reminder, /- id=agent-a name=Agent A role=very long role/);
  // 160-char cap on role, 360 default cap on prompt/summary, whitespace collapsed.
  assert.match(reminder, new RegExp(`role=${"very long role ".repeat(10).slice(0, 160).trim().slice(0, 20)}`));
  assert.ok(/role=[^\n]*\.\.\./.test(reminder));
  assert.match(reminder, /status=completed/);
  // Newlines and repeated whitespace collapse to single spaces.
  assert.match(reminder, /last_task=multi line prompt/);
  assert.ok(/last_task=[^\n]*\.\.\./.test(reminder));
  assert.ok(/last_summary=[^\n]*\.\.\./.test(reminder));
  assert.match(reminder, /call Agent again with an `agents` entry per existing id/);
});

test("buildRosterReminder omits entries beyond the cap with an omitted-count line", () => {
  const identities = Array.from({ length: 15 }, (_, index) => ({
    parentConversationId: "conversation-1",
    agentId: `agent-${index}`,
    name: `Agent ${index}`,
    role: "R",
    identityPrompt: "",
    lastMode: "readonly",
    createdAt: 1,
    updatedAt: 2,
  }));
  // Blank ids/names are filtered before counting.
  identities.push({
    parentConversationId: "conversation-1",
    agentId: "  ",
    name: "Ghost",
    role: "R",
    identityPrompt: "",
    lastMode: "readonly",
    createdAt: 1,
    updatedAt: 2,
  });
  const reminder = roster.buildRosterReminder({
    identities,
    latestRunsByAgent: new Map(),
  });
  const agentLines = reminder.split("\n").filter((line) => line.startsWith("- id="));
  assert.equal(agentLines.length, 12);
  assert.match(reminder, /- \.\.\. 3 more omitted/);
});

test("titleizeStableId and createSubagentIdentity derive names mechanically", () => {
  assert.equal(roster.titleizeStableId("data-analyst_2"), "Data Analyst 2");
  assert.equal(roster.titleizeStableId("   "), "");

  const now = 42;
  const fromTemplate = roster.createSubagentIdentity({
    parentConversationId: "conversation-1",
    toolCallId: "call-1",
    spec: {
      id: "helper",
      prompt: "p",
      mode: "worktree",
      applyPolicy: "none",
      allowedOutputPaths: [],
      resume: true,
      retainWorktree: false,
    },
    template: {
      id: "reviewer",
      name: "Reviewer",
      description: "Review code paths",
      prompt: "x",
    },
    now,
  });
  assert.equal(fromTemplate.name, "Reviewer");
  assert.equal(fromTemplate.role, "Review code paths");
  assert.equal(fromTemplate.templateId, "reviewer");
  assert.equal(fromTemplate.lastMode, "worktree");
  assert.equal(fromTemplate.createdToolCallId, "call-1");
  assert.equal(fromTemplate.createdAt, now);

  const fromId = roster.createSubagentIdentity({
    parentConversationId: "conversation-1",
    toolCallId: "call-1",
    spec: {
      id: "lone.wolf",
      prompt: "p",
      mode: "readonly",
      applyPolicy: "none",
      allowedOutputPaths: [],
      resume: true,
      retainWorktree: false,
    },
    now,
  });
  assert.equal(fromId.name, "Lone Wolf");
  assert.equal(fromId.role, "Lone Wolf");
});
