import assert from 'node:assert/strict';
import test from 'node:test';
import { createDomTestEnv } from '../helpers/dom-test-env.mjs';
const env = await createDomTestEnv({mocks:{
 '../IconSet':new Proxy({}, {get:()=>()=>null}),
 '@liveagent/adapters/chatHeaderChrome':{isDesktopChatHeaderInset:()=>true},
 '@liveagent/app/lib/settings':{getNextTheme:()=> 'dark'},
 '@liveagent/ui/components/IconSet':new Proxy({}, {get:()=>()=>null}),
}});
const {React,act,createRoot}=env;
const {ChatHeader}=env.loadModule('@liveagent/ui/components/chat/ChatHeader.tsx');
const {ProjectToolsPanelToggle}=env.loadModule('@liveagent/ui/components/project-tools/ProjectToolsPanelToggle.tsx');
test('project tools trigger stays in the header layout and remains clickable across toggles',async()=>{
 const host=document.createElement('div');host.style.overflow='hidden';document.body.append(host);
 const root=createRoot(host);let changes=0;
 function Harness(){const [open,setOpen]=React.useState(false);return React.createElement(ChatHeader,{settings:{theme:'light'},sidebarOpen:false,onOpenSettings(){},onOpenSidebar(){},onToggleTheme(){},trailingActions:React.createElement(ProjectToolsPanelToggle,{isOpen:open,sessionCount:0,onToggle:()=>{changes++;setOpen(x=>!x);}})});}
 try{
  await act(async()=>root.render(React.createElement(Harness)));
  const actions=document.querySelector('[data-app-workbench-actions]');
  assert.equal(actions.parentElement.tagName,"HEADER");
  assert.equal(host.contains(actions),true);
  assert.equal(actions.classList.contains("fixed"),false);
  const button=actions.querySelector('[aria-expanded]');
  await act(async()=>button.click());assert.equal(button.getAttribute('aria-expanded'),'true');
  await act(async()=>button.click());assert.equal(button.getAttribute('aria-expanded'),'false');
  assert.equal(changes,2);assert.equal(actions.querySelector('[aria-expanded]'),button);
 }finally{await act(async()=>root.unmount());host.remove();}
 assert.equal(document.querySelector('[data-app-workbench-actions]'),null);
});
