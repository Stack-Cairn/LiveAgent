import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("share redaction preserves each consumer's callback and pending-state policy", async () => {
  let env;
  const Box=({children})=>env.React.createElement("div",null,children);
  const icons=Object.fromEntries("AlertCircle Check Copy ExternalLink Eye EyeOff Link2 Loader2 RefreshCw Search Share2".split(" ").map(n=>[n,()=>null]));
  env=await createDomTestEnv({mocks:{
    "@liveagent/ui/components/IconSet":icons,
    "@liveagent/ui/components/ui/dialog":Object.fromEntries("Dialog DialogBody DialogContent DialogDescription DialogHeader DialogTitle".split(" ").map(n=>[n,Box])),
    "@liveagent/ui/i18n/index":{useLocale:()=>({locale:"en",t:k=>k})},
  }});
  const {React,act,createRoot}=env;
  const {HistoryShareModal}=env.loadModule("@liveagent/ui/components/chat/HistoryShareModal.tsx");
  const {SharedHistoryManagerModal}=env.loadModule("@liveagent/ui/components/chat/SharedHistoryManagerModal.tsx");
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  const noop=()=>{};
  const items=()=>[...host.querySelector('[role="radiogroup"]').querySelectorAll('[role="radio"],input[type="radio"]:not([aria-hidden="true"])')];
  try {
    const changes=[];
    const props={conversation:{title:"Example"},share:{enabled:true,redactToolContent:false,conversationId:"id"},
      isLoading:false,isUpdating:false,errorMessage:null,onClose:noop,onToggle:noop,
      onRedactToolContentChange:v=>changes.push(v)};
    await act(async()=>root.render(React.createElement(HistoryShareModal,props)));
    await act(async()=>items()[0].click());assert.deepEqual(changes,[true]);
    await act(async()=>items()[0].click());assert.deepEqual(changes,[true]);
    await act(async()=>root.render(React.createElement(HistoryShareModal,{...props,isUpdating:true})));
    await act(async()=>items()[1].click());assert.deepEqual(changes,[true]);

    const conversation={id:"id",title:"Example",model:"model",providerId:"provider",updatedAt:0};
    const managed=[];
    const manager={conversations:[conversation],statuses:{id:{enabled:true,redactToolContent:false}},
      loadingIds:new Set(),updatingIds:new Set(),errors:{},onRefresh:noop,onLoadStatus:noop,onDisableShare:noop,onClose:noop,
      onSetRedactToolContent:(item,v)=>managed.push([item.id,v])};
    await act(async()=>root.render(React.createElement(SharedHistoryManagerModal,manager)));
    await act(async()=>items()[1].click());assert.deepEqual(managed,[]);
    await act(async()=>items()[0].click());assert.deepEqual(managed,[["id",true]]);
    await act(async()=>root.render(React.createElement(SharedHistoryManagerModal,{...manager,updatingIds:new Set(["id"])})));
    await act(async()=>items()[0].click());assert.equal(managed.length,1);
  } finally {await act(async()=>root.unmount());host.remove();env.cleanup();}
});
