import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const bus = loader.loadModule("src/lib/subagents/bus.ts");
const roster = loader.loadModule("src/lib/subagents/roster.ts");
const tailBlock = loader.loadModule("src/lib/chat/context/contextTailBlock.ts");

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
  }).text;
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

function makeIdentity(agentId, overrides = {}) {
  return {
    parentConversationId: "conversation-1",
    agentId,
    name: overrides.name ?? `Agent ${agentId}`,
    role: overrides.role ?? "R",
    identityPrompt: "",
    lastMode: overrides.lastMode ?? "readonly",
    createdAt: 1,
    updatedAt: overrides.updatedAt ?? 2,
  };
}

function makeRun(agentId, overrides = {}) {
  return {
    id: `run-${agentId}`,
    agentId,
    status: overrides.status ?? "completed",
    prompt: overrides.prompt ?? `task for ${agentId}`,
    summary: overrides.summary,
  };
}

test("identity section carries only stable fields and truncates long values", () => {
  assert.equal(roster.buildRosterIdentitySection({ identities: [] }), "");

  const longRole = "very long role ".repeat(30);
  const section = roster.buildRosterIdentitySection({
    identities: [makeIdentity("agent-a", { name: "Agent A", role: longRole })],
  });
  assert.match(section, /Existing delegated agents in this parent conversation:/);
  assert.match(section, /- id=agent-a name=Agent A role=very long role/);
  // 160-char cap on role, whitespace collapsed, ellipsis appended.
  assert.ok(/role=[^\n]*\.\.\./.test(section));
  assert.match(section, /call Agent again with an `agents` entry per existing id/);
  // 易变字段一律不得出现在 systemPrompt 段里。
  assert.doesNotMatch(section, /status=/);
  assert.doesNotMatch(section, /last_task=/);
  assert.doesNotMatch(section, /last_summary=/);
  // mode 随每次 Agent 调用变化（lastMode），属于易变字段，同样不得进稳定段。
  assert.doesNotMatch(section, /mode=/);
});

test("identity section bytes survive listIdentities() reordering", () => {
  // listIdentities() 按 updatedAt 倒序返回，任一身份被更新都会改变顺序。
  const ordered = [
    makeIdentity("agent-a", { updatedAt: 30 }),
    makeIdentity("agent-b", { updatedAt: 20 }),
    makeIdentity("agent-c", { updatedAt: 10 }),
  ];
  const reordered = [ordered[2], ordered[0], ordered[1]];
  const reversed = [...ordered].reverse();

  const baseline = roster.buildRosterIdentitySection({ identities: ordered });
  assert.equal(roster.buildRosterIdentitySection({ identities: reordered }), baseline);
  assert.equal(roster.buildRosterIdentitySection({ identities: reversed }), baseline);
  // 归一化后恒为 agentId 升序。
  assert.ok(baseline.indexOf("id=agent-a") < baseline.indexOf("id=agent-b"));
  assert.ok(baseline.indexOf("id=agent-b") < baseline.indexOf("id=agent-c"));
});

test("run-status advancing leaves the identity section byte-identical", () => {
  // run 推进会 bump 对应身份的 updatedAt，listIdentities() 随之把它排到最前，
  // 于是稳定段拿到的入参顺序也变了——字节仍必须一致。
  const agentA = makeIdentity("agent-a", { updatedAt: 10 });
  const agentB = makeIdentity("agent-b", { updatedAt: 20 });
  const identitiesBefore = [agentB, agentA];
  const before = new Map([["agent-a", makeRun("agent-a", { status: "running" })]]);

  const advancedA = { ...agentA, updatedAt: 30 };
  const identitiesAfter = [advancedA, agentB];
  const after = new Map([
    ["agent-a", makeRun("agent-a", { status: "completed", summary: "found three issues" })],
    ["agent-b", makeRun("agent-b", { status: "running" })],
  ]);

  const identityBefore = roster.buildRosterIdentitySection({ identities: identitiesBefore });
  const identityAfter = roster.buildRosterIdentitySection({ identities: identitiesAfter });
  assert.equal(identityAfter, identityBefore);

  const statusBefore = roster.buildRosterRunStatusSection({
    identities: identitiesBefore,
    latestRunsByAgent: before,
  });
  const statusAfter = roster.buildRosterRunStatusSection({
    identities: identitiesAfter,
    latestRunsByAgent: after,
  });
  assert.match(statusBefore, /Latest run state of the delegated agents/);
  // mode 从身份段移到易变段，随每条 run 状态一起投递。
  assert.match(statusBefore, /- id=agent-a status=running mode=readonly last_task=task for agent-a/);
  // 没有历史 run 的身份不出现在易变段里。
  assert.doesNotMatch(statusBefore, /id=agent-b/);
  assert.notEqual(statusAfter, statusBefore);
  assert.match(statusAfter, /- id=agent-a status=completed .*last_summary=found three issues/);
  assert.match(statusAfter, /- id=agent-b status=running/);
});

test("run-status section truncates long values and stays empty without runs", () => {
  const identities = [makeIdentity("agent-a")];
  assert.equal(
    roster.buildRosterRunStatusSection({ identities, latestRunsByAgent: new Map() }),
    "",
  );

  const section = roster.buildRosterRunStatusSection({
    identities,
    latestRunsByAgent: new Map([
      [
        "agent-a",
        makeRun("agent-a", {
          prompt: `multi\nline   prompt ${"p".repeat(500)}`,
          summary: "s".repeat(500),
        }),
      ],
    ]),
  });
  // Newlines and repeated whitespace collapse to single spaces; 360-char cap.
  assert.match(section, /last_task=multi line prompt/);
  assert.ok(/last_task=[^\n]*\.\.\./.test(section));
  assert.ok(/last_summary=[^\n]*\.\.\./.test(section));
});

test("both sections truncate on the same set so no agent is listed in only one", () => {
  // 数组顺序与 agentId 顺序相反：任一段若按“到手顺序”截断，选出的 12 个会是
  // agent-14..agent-03，与归一化后的 agent-00..agent-11 完全错位。
  const identities = Array.from({ length: 15 }, (_, index) =>
    makeIdentity(`agent-${String(14 - index).padStart(2, "0")}`, { updatedAt: 100 + index }),
  );
  // Blank ids/names are filtered before counting.
  identities.push(makeIdentity("  ", { name: "Ghost" }));
  const latestRunsByAgent = new Map(
    identities
      .filter((identity) => identity.agentId.trim())
      .map((identity) => [identity.agentId, makeRun(identity.agentId)]),
  );

  const identitySection = roster.buildRosterIdentitySection({ identities });
  const statusSection = roster.buildRosterRunStatusSection({ identities, latestRunsByAgent });
  const idsOf = (text) =>
    text
      .split("\n")
      .filter((line) => line.startsWith("- id="))
      .map((line) => line.slice("- id=".length).split(" ")[0]);

  const identityIds = idsOf(identitySection);
  assert.equal(identityIds.length, 12);
  assert.equal(identityIds[0], "agent-00");
  assert.equal(identityIds[11], "agent-11");
  assert.deepEqual(idsOf(statusSection), identityIds);
  // 溢出计数只归稳定段（它是身份列表的一部分），且不重复出现在易变段里。
  assert.match(identitySection, /- \.\.\. 3 more omitted/);
  assert.doesNotMatch(statusSection, /more omitted/);
});

test("unchanged run state renders identical bytes so the turn attaches nothing", () => {
  const identities = [makeIdentity("agent-a"), makeIdentity("agent-b")];
  const runs = [makeRun("agent-a", { summary: "done" }), makeRun("agent-b", { status: "running" })];

  const previous = roster.buildRosterRunStatusSection({
    identities,
    latestRunsByAgent: new Map([
      [runs[0].agentId, runs[0]],
      [runs[1].agentId, runs[1]],
    ]),
  });
  // 同一状态，但身份顺序与 Map 插入顺序都不同——渲染结果必须字节相同，
  // 否则调用方的「内容没变就不投递」判据失效，每轮都会挂一个新块。
  const current = roster.buildRosterRunStatusSection({
    identities: [identities[1], identities[0]],
    latestRunsByAgent: new Map([
      [runs[1].agentId, runs[1]],
      [runs[0].agentId, runs[0]],
    ]),
  });
  assert.equal(current, previous);

  // 调用方的投递判据：与上次投递内容相同 → 本轮不产生任何额外内容。
  const delta = current === previous ? "" : current;
  const messages = [
    { role: "user", content: "hi", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "Read", arguments: {} }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "m",
      usage: {},
      stopReason: "toolUse",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "Read",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 1,
    },
  ];
  assert.equal(tailBlock.appendToolResultTailBlock(messages, delta), messages);
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
