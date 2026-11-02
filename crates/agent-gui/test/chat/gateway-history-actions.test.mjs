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
