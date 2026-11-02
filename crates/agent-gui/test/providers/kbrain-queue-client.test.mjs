import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { createKBrainClient } = createTsModuleLoader().loadModule("src/lib/kbrain/client.ts");
const document = (overrides = {}) => ({
  version: "kbrain.agent.v1", accepted: true,
  snapshot: { conversationId: "session", revision: 0, paused: true, items: [] },
  ...overrides,
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("desktop queue API preserves zero revision and canonical attachments", async () => {
  const calls = [];
  const client = createKBrainClient({ baseUrl: "https://backend.test", fetch: async (url, init) => {
    calls.push({ url: String(url), ...init }); return json(document());
  }});
  const request = { conversation_id: "session", client_request_id: "identity", prompt: "file", content: [{ type: "file", file_url: "data:text/plain;base64,SGk=", mime_type: "text/plain" }] };
  await client.submitQueue({request, source: "gui"});
  await client.queueAction("session", {action:"resume",revision:0});
  assert.deepEqual(JSON.parse(calls[0].body).request, request);
  assert.equal(calls[1].url, "https://backend.test/v1/sessions/session/queue/actions");
  assert.deepEqual(JSON.parse(calls[1].body), {action:"resume",revision:0});
});

test("desktop queue recovers lost acceptance by GET without repeating POST", async () => {
  const calls = [];
  const client = createKBrainClient({baseUrl:"https://backend.test",fetch:async(url,init)=>{
    calls.push({url:String(url),...init});
    if (init.method === "POST") throw new TypeError("connection lost after acceptance");
    return json(document({receipt:{id:"item",state:"queued"}}));
  }});
  const result = await client.submitQueue({request:{conversation_id:"session",client_request_id:"req /?",prompt:"once"}});
  assert.equal(result.receipt.id,"item");
  assert.equal(calls.filter(c=>c.method==="POST").length,1);
  assert.equal(new URL(calls[1].url).searchParams.get("client_request_id"),"req /?");
});

test("desktop queue Stop during acceptance still recovers a cancellable receipt", async () => {
  const controller = new AbortController();
  let calls=0;
  const client=createKBrainClient({baseUrl:"https://backend.test",fetch:async(_url,init)=>{
    calls++;
    if(init.method==="POST") {controller.abort(new Error("stop"));throw controller.signal.reason;}
    assert.equal(init.signal.aborted,false);
    return json(document({receipt:{id:"item",state:"queued"}}));
  }});
  assert.equal((await client.submitQueue({request:{conversation_id:"session",client_request_id:"once",prompt:"once"}},controller.signal)).receipt.id,"item");
  assert.equal(calls,2);
});

test("desktop queue preserves structured revision conflicts without retrying mutation", async () => {
  let calls=0;
  const client=createKBrainClient({baseUrl:"https://backend.test",fetch:async()=>{
    calls++;return json(document({accepted:false,errorCode:"conflict",snapshot:{conversationId:"session",revision:7,paused:true,items:[]}}),409);
  }});
  const result=await client.queueAction("session",{action:"resume",revision:6});
  assert.equal(result.accepted,false);assert.equal(result.snapshot.revision,7);assert.equal(calls,1);
});

test("desktop queue rejects invalid or cross-session responses and run identities", async () => {
  for(const body of [null, document({snapshot:{conversationId:"other",revision:0,paused:true,items:[]}}),document({snapshot:{conversationId:"session",revision:-1,paused:true,items:[]}}),document({receipt:{run:{version:"kbrain.agent.v1",conversation_id:"other",run_id:"x",accepted_seq:1}}})]) {
    const client=createKBrainClient({baseUrl:"https://backend.test",fetch:async()=>json(body)});
    await assert.rejects(()=>client.getQueue("session"),/Malformed/);
  }
});

test("desktop queue wait is abortable and does not submit work", async () => {
  const controller=new AbortController();
  const client=createKBrainClient({baseUrl:"https://backend.test",fetch:async(url,init)=>{
    assert.equal(new URL(url).search,"?wait=1&after_revision=0");
    assert.equal(init.method,undefined);
    return new Promise((_,reject)=>init.signal.addEventListener("abort",()=>reject(init.signal.reason),{once:true}));
  }});
  const pending=client.waitQueue("session",0,controller.signal);
  controller.abort(new Error("closed"));
  await assert.rejects(pending,/closed/);
});

test("desktop queue recovers a truncated response body without replaying acceptance", async () => {
  let posts=0;
  const client=createKBrainClient({baseUrl:"https://backend.test",fetch:async(_url,init)=>{
    if(init.method==="POST") {
      posts++;
      return new Response(new ReadableStream({start(controller){controller.error(new TypeError("body connection reset"));}}));
    }
    return json(document({receipt:{id:"item",state:"queued"}}));
  }});
  assert.equal((await client.submitQueue({request:{conversation_id:"session",client_request_id:"once",prompt:"hello"}})).receipt.id,"item");
  assert.equal(posts,1);
});

test("desktop queue action transport failure never replays a revision mutation", async () => {
  let calls=0;
  const client=createKBrainClient({baseUrl:"https://backend.test",fetch:async()=>{calls++;throw new TypeError("lost");}});
  await assert.rejects(()=>client.queueAction("session",{action:"resume",revision:1}),/lost/);
  assert.equal(calls,1);
});
