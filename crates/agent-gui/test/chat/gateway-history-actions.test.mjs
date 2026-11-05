import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("remote history shares the desktop K-brain projection and preserves message identities", async () => {
  const calls = [];
  const summary = { id: "conversation", cwd: "C:\\Users\\Tester\\project", messageCount: 10 };
  const message = { id: "user-1", role: "user", content: "hello", timestamp: 123 };
  const historyPath = fileURLToPath(
    new URL("../../src/lib/chat/history/chatHistory.ts", import.meta.url),
  );
  const loader = createTsModuleLoader({
    mocks: {
      [fileURLToPath(new URL("../../src/lib/kbrain/mapping.ts", import.meta.url))]: {
        getKBrainSessionId: (id) => (id === "conversation" ? "session" : undefined),
        setKBrainSessionId() {},
      },
      [fileURLToPath(new URL("../../src/lib/kbrain/history.ts", import.meta.url))]: {
        resolveKBrainLocalId: (id) => {
          assert.equal(id, "session");
          return "conversation";
        },
      },
      [path.normalize(historyPath)]: {
        listChatHistory: async (...args) => {
          calls.push(["list", ...args]);
          return { items: [summary], totalCount: 1 };
        },
        listChatHistoryWorkdirs: async () => ({
          workdirs: [{ path: summary.cwd, conversationCount: 1 }],
        }),
        getChatHistoryWindow: async (args) => {
          calls.push(["get", args]);
          return {
            conversation: summary,
            hasMoreBefore: true,
            segments: [
              {
                segmentIndex: 0,
                segmentId: "kbrain:session",
                startMessageIndex: 7,
                messages: [message],
              },
            ],
          };
        },
        renameChatHistory: async (id, title) => ({ ...summary, id, title }),
        setChatHistoryPinned: async (id, isPinned) => ({ ...summary, id, isPinned }),
        setChatHistoryCwd: async (id, cwd) => ({ ...summary, id, cwd }),
        deleteChatHistory: async (id) => {
          calls.push(["delete", id]);
        },
      },
    },
  });
  const { runGatewayHistoryAction: run } = loader.loadModule(
    "src/pages/chat/gateway/gatewayHistoryActions.ts",
  );
  const event = (action, data = {}) => ({
    kind: "history",
    conversationId: "conversation",
    action,
    data,
  });
  assert.equal(
    (await run(event("list", { page: 2, pageSize: 20, cwd: summary.cwd }))).items[0].cwd,
    summary.cwd,
  );
  assert.deepEqual(calls[0], ["list", 2, 20, { cwd: summary.cwd, cwdEmpty: false }]);
  assert.equal((await run(event("workdirs"))).workdirs[0].path, summary.cwd);
  const result = await run(event("get", { maxMessages: 100 }));
  assert.equal(result.totalMessageCount, 10);
  assert.equal(result.hasMore, true);
  await run({ ...event("get"), conversationId: "session" });
  assert.equal(calls.at(-1)[1].id, "conversation");
  await run(event("list", { cwd: "" }));
  assert.equal(calls.at(-1)[3].cwd, undefined);
  const messages = JSON.parse(result.messagesJson);
  assert.equal(messages[0].liveAgentHistoryRef.messageId, "user-1");
  assert.equal(messages[0].liveAgentHistoryRef.messageIndex, 7);
  assert.equal(messages[0].liveAgentHistoryRef.segmentId, "kbrain:session");
  assert.equal((await run(event("rename", { title: "renamed" }))).conversation.title, "renamed");
  assert.equal((await run(event("pin", { isPinned: true }))).conversation.isPinned, true);
  assert.equal((await run(event("cwd", { cwd: "/tmp/project" }))).conversation.cwd, "/tmp/project");
  await run(event("delete"));
  assert.deepEqual(calls.at(-1), ["delete", "conversation"]);
  await assert.rejects(run(event("unknown")), /Unsupported gateway history action/);
});

test("healthy desktop projection serves Gateway list and workdirs without backend pagination",async()=>{
 const historyPath=fileURLToPath(new URL("../../src/lib/chat/history/chatHistory.ts",import.meta.url));
 const syncPath=fileURLToPath(new URL("../../src/lib/kbrain/sidebarSync.ts",import.meta.url));
 const calls=[];const loader=createTsModuleLoader({mocks:{
 [historyPath]:{listChatHistory:()=>assert.fail("no full history HTTP"),listChatHistoryWorkdirs:()=>assert.fail("no workdir full pagination")},
 [syncPath]:{kBrainSidebarSync:{isHealthy:()=>true,list:(...args)=>{calls.push(args);return{items:[],totalCount:0};},workdirs:()=>[{path:"/project",conversationCount:2,updatedAt:1}]}}
 }});
 const {runGatewayHistoryAction:run}=loader.loadModule("src/pages/chat/gateway/gatewayHistoryActions.ts");
 await run({kind:"history",conversationId:"",action:"list",data:{page:2,pageSize:20,cwd:"/project"}});
 assert.deepEqual(calls[0],[2,20,{kind:"workdir",cwd:"/project"}]);
 await run({kind:"history",conversationId:"",action:"list",data:{cwdEmpty:true}});
 assert.deepEqual(calls[1],[1,80,{kind:"unscoped"}]);
 assert.equal((await run({kind:"history",conversationId:"",action:"workdirs",data:{}})).workdirs[0].conversationCount,2);
});

test("bridge branch, share, trajectory and checkpoint requests are served by K-brain", async () => {
  const src = (file) => fileURLToPath(new URL(`../../src/${file}`, import.meta.url));
  const calls = [];
  const summary = { id: "conversation", title: "t", isShared: true, messageCount: 2 };
  const shareStatus = { conversationId: "conversation", enabled: true, token: "tok", createdAt: 1, updatedAt: 2, redactToolContent: true };
  const ref = { segmentIndex: 0, messageIndex: 3, segmentId: "kbrain:session", messageId: "user-1", role: "user", contentHash: "h" };
  const loader = createTsModuleLoader({
    mocks: {
      [src("lib/kbrain/mapping.ts")]: {
        getKBrainSessionId: (id) => (id === "conversation" ? "session" : undefined),
        setKBrainSessionId() {},
      },
      [src("lib/kbrain/history.ts")]: {
        resolveKBrainLocalId: () => assert.fail("mapped ids must not be re-resolved"),
        resolveKBrainHistoryShare: async (token) => {
          calls.push(["resolve", token]);
          return {
            conversationId: "conversation",
            title: "Shared",
            messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [] }],
            redactToolContent: true,
          };
        },
      },
      [path.normalize(src("lib/chat/history/chatHistory.ts"))]: {
        branchChatHistory: async (id, baseRef) => {
          calls.push(["branch", id, baseRef]);
          return { ...summary, id: "child" };
        },
        getChatHistoryShare: async (id) => ({ ...shareStatus, conversationId: id }),
        setChatHistoryShare: async (id, enabled, options) => {
          calls.push(["share_set", id, enabled, options]);
          return { ...shareStatus, enabled };
        },
        getChatHistoryWindow: async (args) => {
          calls.push(["window", args]);
          return { conversation: summary, segments: [], hasMoreBefore: false };
        },
      },
      [src("lib/kbrain/checkpoints.ts")]: {
        kBrainCheckpointClient: {
          list: async (id) => {
            calls.push(["checkpoint_list", id]);
            return [{ turnSeq: 4 }];
          },
          preview: async (args) => {
            calls.push(["checkpoint_diff", args]);
            return { turnSeq: args.turnSeq };
          },
          rewind: async (args) => {
            calls.push(["checkpoint_rewind", args]);
            return { turnSeq: args.turnSeq, failed: false };
          },
        },
      },
      [src("lib/kbrain/trajectory.ts")]: {
        createKBrainTrajectoryHost: () => ({
          loadWindow: async (id, before, max) => {
            calls.push(["window_traj", id, before, max]);
            return { eventsJson: "[1]", truncated: false, oldestSegmentIndex: 2, returnedSegmentCount: 1, totalSegmentCount: 3, hasMoreBefore: true };
          },
          loadSections: async (id, ids) => ids.map((sectionId) => ({ sectionId, slot: "system", content: id })),
          loadSubagentRuns: async (id, ids) => ids.map((runId) => ({ runId, agentId: id })),
        }),
      },
    },
  });
  const { runGatewayHistoryAction: run } = loader.loadModule(
    "src/pages/chat/gateway/gatewayHistoryActions.ts",
  );
  const event = (action, data = {}, conversationId = "conversation") => ({ kind: "history", conversationId, action, data });

  assert.equal((await run(event("branch", { baseMessageRef: ref }))).conversation.id, "child");
  assert.deepEqual(calls.at(-1), ["branch", "conversation", ref]);
  await assert.rejects(run(event("branch")), /base_message_ref/);

  assert.equal((await run(event("share_get"))).share.token, "tok");
  const shared = await run(event("share_set", { enabled: true, redactToolContent: false }));
  assert.deepEqual(calls.find((call) => call[0] === "share_set"), ["share_set", "conversation", true, { redactToolContent: false }]);
  assert.equal(shared.conversation.isShared, true, "share_set returns the summary for the sync upsert");
  await run(event("share_set", { enabled: false, redactToolContent: null }));
  assert.deepEqual(calls.filter((call) => call[0] === "share_set").at(-1)[3], {});

  const resolved = await run(event("share_resolve", { token: " tok " }, ""));
  assert.deepEqual(calls.at(-1), ["resolve", " tok "]);
  assert.equal(resolved.conversationId, "conversation");
  assert.equal(resolved.totalMessageCount, 2);
  assert.equal(resolved.redactToolContent, true);
  assert.equal(JSON.parse(resolved.messagesJson)[0].content, "hi");
  assert.equal(resolved.conversation.title, "Shared");

  const window = await run(event("trajectory", { maxSegments: 4, beforeSegmentIndex: 5, sectionIds: [] }));
  assert.deepEqual(calls.at(-1), ["window_traj", "conversation", 5, 4]);
  assert.equal(window.eventsJson, "[1]");
  assert.equal(window.hasMoreBefore, true);
  assert.equal(window.subagentRunsJson, "");
  await run(event("trajectory", { maxSegments: 0, beforeSegmentIndex: null }));
  assert.deepEqual(calls.at(-1), ["window_traj", "conversation", undefined, undefined]);
  const sections = await run(event("trajectory", { sectionIds: ["s1"] }));
  assert.deepEqual(sections.sections, [{ sectionId: "s1", slot: "system", content: "conversation" }]);
  assert.equal(sections.eventsJson, "");
  const runs = await run(event("trajectory", { includeSubagentRuns: true, sectionIds: ["ignored"], subagentRunIds: ["run-1"] }));
  assert.deepEqual(JSON.parse(runs.subagentRunsJson), [{ runId: "run-1", agentId: "conversation" }]);
  assert.deepEqual(runs.sections, []);

  assert.deepEqual((await run(event("checkpoint_list"))).result, [{ turnSeq: 4 }]);
  assert.deepEqual(calls.at(-1), ["checkpoint_list", "conversation"]);
  await run(event("checkpoint_diff", { turnSeq: 4, authorizedRoots: ["/w", 3] }));
  assert.deepEqual(calls.at(-1)[1], { conversationId: "conversation", turnSeq: 4, authorizedRoots: ["/w"] });
  const rewound = await run(event("checkpoint_rewind", { turnSeq: 4, authorizedRoots: ["/w"], expected: [{ key: "k", currentHash: "h" }] }));
  assert.equal(rewound.result.failed, false);
  assert.deepEqual(calls.at(-1)[1].expected, [{ key: "k", currentHash: "h" }]);
  await assert.rejects(run(event("checkpoint_diff", { turnSeq: -1 })), /turn sequence/);
});
