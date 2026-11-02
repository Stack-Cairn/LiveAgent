import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// “/”指令弹层的真实渲染：分组标题、键盘导航、选中、Esc 与输入法组合。

const locale = { locale: "en-US", t: (key) => key };
const EmptyIcon = () => null;
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => locale },
    "@liveagent/ui/components/IconSet": new Proxy(
      {},
      {
        get: (_target, name) =>
          name === "__esModule"
            ? true
            : String(name).endsWith("_SVG_MARKUP")
              ? "<svg></svg>"
              : EmptyIcon,
      },
    ),
  },
});
// jsdom 没有布局，弹层高亮行的 scrollIntoView 需要占位。
window.HTMLElement.prototype.scrollIntoView = () => {};
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => ({left:0,top:0,right:0,bottom:0,width:0,height:0});
const { MentionComposer } = env.loadModule("@liveagent/ui/components/chat/MentionComposer.tsx");
const { clearCommandRecoveries, moveCommandRecovery } = env.loadModule("@liveagent/ui/lib/chat/composerCommandRecovery.ts");
document.execCommand = () => true;

const skill = (name) => ({
  name,
  description: `${name} skill`,
  skillFile: `${name}/SKILL.md`,
  baseDir: name,
});

const calls = [];
const commandHost = {
 listCommands: async () => [{name:"model",kind:"action",source:"builtin",description:"Model"},{name:"plan",kind:"action",source:"builtin",description:"Plan"},{name:"deploy",kind:"prompt",source:"user",description:"Deploy"}],
 sendTurn: async (...args) => calls.push(args), enablePlanMode: () => calls.push("plan"),
 openModelPicker: () => calls.push("picker"),selectModel: name => calls.push(`select:${name}`),
};

let sends = 0;
let host;
let root;
let editor;

async function mount(props) {
  if (root) {
    await env.act(async () => root.unmount());
    host.remove();
  }
  host = document.createElement("div");
  document.body.append(host);
  root = env.createRoot(host);
  await env.act(async () =>
    root.render(
      env.React.createElement(MentionComposer, {
        workdir: "",
        enabledSkills: [],
        conversations: [],
        mentionApps: [],
        onSend: () => sends++,
        ...props,
      }),
    ),
  );
  editor = host.querySelector('[contenteditable="true"]');
  assert.ok(editor);
}

async function type(text) {
  await env.act(async () => {
    editor.focus();
    editor.textContent = text;
    const range = document.createRange();
    if (editor.firstChild) range.setStart(editor.firstChild, text.length);
    else range.setStart(editor, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // 提示词列表是异步取的，等它落进弹层。
  await env.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

async function key(name, options = {}) {
  const event = new KeyboardEvent("keydown", {
    key: name,
    code: name,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  await env.act(async () => editor.dispatchEvent(event));
  await env.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return event;
}

const options = () => [...document.querySelectorAll("[data-command-name]")];
const optionNames = () => options().map((option) => option.getAttribute("data-command-name"));
const groups = () =>
  [...document.querySelectorAll("[data-command-group]")].map((header) =>
    header.getAttribute("data-command-group"),
  );
const highlighted = () =>
  options()
    .find((option) => option.getAttribute("aria-selected") === "true")
    ?.getAttribute("data-command-name");

test.beforeEach(async () => {
  await env.act(async () => clearCommandRecoveries());
  calls.length = 0;
  sends = 0;
  await mount({ enabledSkills: [skill("code-review")], commandHost });
});


test("slash root offers commands and skills with separate navigation", async()=>{
 await type("/");assert.equal(optionNames().length,0);
 const categories=[...document.querySelectorAll('[role="option"]')];assert.equal(categories.length,2);
 await key("Enter");
 assert.deepEqual(optionNames(),["model","plan","deploy"]);
 await key("Escape");assert.equal(document.querySelectorAll('[role="option"]').length,2);
});
test("model selection opens picker immediately without sending",async()=>{
 await type("/mod");await key("Enter");assert.deepEqual(calls,["picker"]);assert.equal(sends,0);assert.equal(editor.textContent,"");
});
test("manual model name selects directly",async()=>{
 await type("/model Sonnet");await key("Enter");assert.deepEqual(calls,["select:Sonnet"]);assert.equal(sends,0);
});
test("plan selection drafts first and second Enter enables plan",async()=>{
 await type("/pla");await key("Tab");assert.equal(editor.textContent,"/plan ");assert.deepEqual(calls,[]);await key("Enter");assert.deepEqual(calls,["plan"]);
});
test("Escape closes search and preserves draft",async()=>{await type("/mod");await key("Escape");assert.equal(options().length,0);assert.equal(editor.textContent,"/mod");});
test("IME does not select a model",async()=>{await type("/mod");await key("Enter",{isComposing:true});assert.deepEqual(calls,[]);});
test("unknown slash text sends normally",async()=>{await type("/usr/path");await key("Enter");assert.equal(sends,1);});
test("without skills catalog commands remain usable",async()=>{await mount({enabledSkills:[],commandHost});await type("/");assert.ok(optionNames().includes("model"));});
test("without a host enabled skills remain available",async()=>{await mount({enabledSkills:[skill("reviewer")]});await type("/");assert.ok(document.body.textContent.includes("reviewer"));});

test("rejected command send restores the draft and shows the error",async()=>{
 const rejecting={...commandHost,sendTurn:async()=>{throw new Error("busy now");}};
 await mount({enabledSkills:[],commandHost:rejecting});await type("/deploy staging");await key("Enter");
 assert.equal(editor.textContent.replace(/\u200b/g,""),"/deploy staging");assert.equal(sends,0);
 assert.ok(document.querySelector('[data-composer-command-panel="error"]')?.textContent.includes("busy now"));
});
test("asynchronous rejection preserves newly typed input until it is empty", async () => {
 let reject;
 await mount({currentConversationId:"c1",enabledSkills:[],commandHost:{...commandHost,sendTurn:()=>new Promise((_,fail)=>{reject=fail;})}});
 await type("/deploy staging");await key("Enter");assert.equal(editor.textContent,"");
 await type("new draft");await env.act(async()=>reject(new Error("chat.commands.busy")));
 assert.equal(editor.textContent,"new draft");assert.ok(host.querySelector('[data-composer-command-panel="error"]'));
 await type("");assert.equal(editor.textContent.replace(/\u200b/g,""),"/deploy staging");
});
test("background Pane rejection restores only its own conversation after remount", async () => {
 let reject;
 const delayed={...commandHost,sendTurn:()=>new Promise((_,fail)=>{reject=fail;})};
 await mount({currentConversationId:"background",enabledSkills:[],commandHost:delayed});
 await type("/plan inspect");await key("Enter");
 await mount({currentConversationId:"main",enabledSkills:[],commandHost});await type("main draft");
 await env.act(async()=>reject(new Error("chat.commands.busy")));
 assert.equal(editor.textContent,"main draft");assert.equal(host.querySelector('[data-composer-command-panel]'),null);
 await mount({currentConversationId:"background",enabledSkills:[],commandHost});
 assert.equal(editor.textContent.replace(/\u200b/g,""),"/plan inspect");assert.ok(host.querySelector('[data-composer-command-panel="error"]'));
});
test("draft binding keeps late rejection recovery on the real conversation", async () => {
 let reject;
 await mount({currentConversationId:"draft",enabledSkills:[],commandHost:{...commandHost,sendTurn:()=>new Promise((_,fail)=>{reject=fail;})}});
 await type("/plan inspect");await key("Enter");
 await env.act(async()=>moveCommandRecovery("draft","bound"));
 await mount({currentConversationId:"bound",enabledSkills:[],commandHost});
 await env.act(async()=>reject(new Error("chat.commands.busy")));
 assert.equal(editor.textContent.replace(/\u200b/g,""),"/plan inspect");assert.ok(host.querySelector('[data-composer-command-panel="error"]'));
});
test("editing a queued turn keeps slash drafts as plain sends",async()=>{
 await mount({enabledSkills:[],commandHost:{...commandHost,isDraftReserved:()=>true}});await type("/deploy staging");await key("Enter");
 assert.equal(sends,1);assert.deepEqual(calls,[]);
});
test("a leading skill chip is not executed as a same-named command",async()=>{
 const ref=env.React.createRef();await mount({enabledSkills:[skill("deploy")],commandHost,ref});
 await env.act(async()=>new Promise((resolve)=>setTimeout(resolve,0)));
 await env.act(async()=>ref.current.setDraft({segments:[{type:"skillMention",skill:skill("deploy")},{type:"text",text:" now"}],text:"/deploy now",textWithoutLargePastes:"/deploy now",largePastes:[],skillMentions:[],appMentions:[],commitMentions:[],gitFileMentions:[],codeMentions:[],isEmpty:false}));
 assert.equal(ref.current.runCommandDraft(),false);
 await env.act(async()=>ref.current.setText("/deploy now"));assert.equal(ref.current.runCommandDraft(),true);
});

test.after(async () => {
  await env.act(async () => root.unmount());
  env.cleanup();
});
