import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { parseRunProgress, encodeRunProgress } = loader.loadModule("../agent-ui/src/lib/chat/runProgress.ts");
const { runKBrainTurn } = loader.loadModule("src/lib/kbrain/turn.ts");

test("run progress only accepts known stages and finite nonnegative timings", () => {
  for (const input of [null, "kbrain-progress:{", {}, [], {stage:"unknown"}, "waiting_model"]) {
    assert.equal(parseRunProgress(input), null);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(parseRunProgress({stage:"thinking", elapsed_ms:0, first_text_ms:-1, model_request_ms:Infinity, secret:"private"}))), {stage:"thinking",elapsed_ms:0});
  assert.equal(parseRunProgress(encodeRunProgress({stage:"responding",first_text_ms:12})).first_text_ms, 12);
});

for (const legacy of [false, true]) {
  test(`turn progress survives reconnect without resubmitting (${legacy ? "legacy" : "current"} backend)`, async () => {
    const statuses = [];
    const text = [];
    const requests = [];
    let seq = 1;
    let connections = 0;
    const event = (type,payload) => `data: ${JSON.stringify({version:"kbrain.agent.v1",conversation_id:"s",run_id:"r",seq:++seq,type,payload})}\n\n`;
    const fetch = async (url, init) => {
      const path = new URL(url).pathname;
      requests.push(path);
      if (path === "/v1/sessions") return Response.json({id:"s"});
      if (path.endsWith("/runs")) return Response.json({version:"kbrain.agent.v1",conversation_id:"s",run_id:"r",accepted_seq:1});
      if (path.endsWith("/events")) {
        connections++;
        if (connections === 1) return new Response(legacy ? event("assistant.thinking.delta",{text:"think"}) : event("run.progress",{stage:"waiting_model",elapsed_ms:10,model_request_ms:8}), {headers:{"Content-Type":"text/event-stream"}});
        assert.equal(new URL(url).searchParams.get("after_seq"), "2");
        return new Response(event("assistant.text.delta",{text:"hello"}) + event("run.completed",{}), {headers:{"Content-Type":"text/event-stream"}});
      }
      throw new Error(`Unexpected request ${path} ${init?.method}`);
    };
    const result = await runKBrainTurn({baseUrl:"http://fixture.test",fetch,model:{provider:"fixture",model:"test"},sessionId:"frontend",conversationId:`progress-${legacy}`,cwd:"/tmp",context:{messages:[]},prompt:"hello",signal:new AbortController().signal,onStatus:s=>statuses.push(s),onTextDelta:t=>text.push(t),onThinkingDelta(){},onToolCall(){},onToolResult(){}});
    assert.equal(result.stopReason,"stop");
    assert.deepEqual(text,["hello"]);
    assert.equal(requests.filter(p=>p.endsWith("/runs")).length,1);
    const progress = statuses.map(parseRunProgress).filter(Boolean);
    const reconnect = progress.findIndex(p=>p.stage === "reconnecting");
    assert.ok(reconnect >= 0);
    assert.equal(progress[reconnect+1].stage,legacy ? "thinking" : "waiting_model");
    const response = progress.find(p=>p.stage === "responding");
    assert.ok(response.client_first_text_ms >= 0);
    assert.equal(statuses.at(-1),null);
  });
}

test("rejected run clears connecting status",async()=>{
  const statuses=[];
  await assert.rejects(runKBrainTurn({baseUrl:"http://fixture.test",fetch:async()=>Response.json({error:"unavailable"},{status:503}),model:{provider:"fixture",model:"test"},conversationId:"reject",context:{messages:[]},prompt:"hello",signal:new AbortController().signal,onStatus:s=>statuses.push(s)}),/unavailable/);
  assert.equal(statuses.at(-1),null);
});

test("desktop activity progress yields to manual approval and disappears after settling",()=>{
  const renderLoader=createTsModuleLoader({mocks:{
    react:{...React,memo:fn=>fn,useMemo:fn=>fn()},
    "@liveagent/ui/components/chat/AssistantStatus":{LiveAssistantStatus:()=>null},
    "@liveagent/ui/components/chat/LiveSparkle":{LiveSparkle:()=>null},
    [new URL("../../src/pages/chat/transcript/AssistantRenderUnit.tsx",import.meta.url).pathname]:{AssistantRenderUnit:()=>null},
  }});
  const {AssistantActivityRow}=renderLoader.loadModule("src/pages/chat/transcript/AssistantActivityRow.tsx");
  const {LiveAssistantStatus}=renderLoader.loadModule("@liveagent/ui/components/chat/AssistantStatus");
  const {LiveSparkle}=renderLoader.loadModule("@liveagent/ui/components/chat/LiveSparkle");
  const status=encodeRunProgress({stage:"waiting_model"});
  const render=(live,approval)=>AssistantActivityRow({row:{live,units:[]},hasPendingToolApproval:approval,toolStatus:status}).props.children.at(-1);
  assert.equal(render(true,false).type,LiveAssistantStatus);
  assert.equal(render(true,true).type,LiveSparkle);
  assert.equal(render(true,true).props.paused,true);
  assert.equal(render(false,false),null);
});
