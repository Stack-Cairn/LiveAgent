import test from 'node:test';
import assert from 'node:assert/strict';
import {createTsModuleLoader} from '../helpers/load-ts-module.mjs';
const loader=createTsModuleLoader({mocks:{'../lib/host':{isTauriHost:()=>false}}});
const {createDesktopImageStudioHost}=loader.loadModule('src/agent-ui-adapters/imageStudio.ts');
const {submissionKey,serializeSubmission,draftKey}=loader.loadModule('@liveagent/ui/features/image-studio/drafts.ts');
test('managed backend restart must retain unresolved paid request identity across ephemeral ports',()=>{
 const data=new Map();const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 const connection={baseUrl:'http://127.0.0.1:51001',token:'session-token-a',managedLocal:true,storageId:'local-stable-data-root',protocolVersion:'kbrain.agent.v1'};
 const first=createDesktopImageStudioHost(connection,'/same/workspace',storage);
 const scope={ownerId:first.host.ownerId,backendId:first.host.backendId,projectId:'ip_existing'};
 const pending={key:'same-paid-request',status:'unknown',request:{projectId:'ip_existing',targetId:'it_existing',prompt:'saved prompt',operation:'generate',count:1,inputs:[],parameters:{}}};
 first.host.storage.setItem(submissionKey(scope),serializeSubmission(scope,pending,[]));
 first.host.storage.setItem(draftKey(scope.ownerId,scope.backendId,scope.projectId),'saved draft');
 const attempt={version:1,targetId:'it_existing',key:'verification-key',input:{expectedRevision:1,projectId:'ip_existing',connectionId:'ic_test',remoteId:'gpt-image-2',targetRevision:1,operation:'generate',count:1,prompt:'fixture',confirmPaid:true}};
 data.set(JSON.stringify(['local',first.host.backendId,'/same/workspace'])+':image-verification:v1:it_existing',JSON.stringify(attempt));
 first.dispose();
 const restarted=createDesktopImageStudioHost({...connection,baseUrl:'http://127.0.0.1:51002',token:'session-token-b'},'/same/workspace',storage);
 try{const nextScope={...scope,backendId:restarted.host.backendId};assert.equal(JSON.parse(restarted.host.storage.getItem(submissionKey(nextScope))).submission.key,'same-paid-request');assert.equal(restarted.host.storage.getItem(draftKey(nextScope.ownerId,nextScope.backendId,nextScope.projectId)),'saved draft');assert.equal(restarted.host.client.loadVerificationAttempt('it_existing').key,'verification-key');}finally{restarted.dispose();}
});

test('distinct managed data roots and workspaces remain isolated',()=>{
 const values=new Map();const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const connection={baseUrl:'http://127.0.0.1:51001',token:'test',managedLocal:true,storageId:'root-a',protocolVersion:'kbrain.agent.v1'};
 const a=createDesktopImageStudioHost(connection,'/repo',storage);
 const b=createDesktopImageStudioHost({...connection,storageId:'root-b'},'/repo',storage);
 const c=createDesktopImageStudioHost(connection,'/other',storage);
 try{
  const scope={ownerId:'local',backendId:a.host.backendId,projectId:'ip_a'};
  a.host.storage.setItem(submissionKey(scope),'sentinel');
  assert.equal(b.host.storage.getItem(submissionKey({...scope,backendId:b.host.backendId})),null);
  assert.equal(c.host.storage.getItem(submissionKey(scope)),null);
  assert.throws(()=>createDesktopImageStudioHost({...connection,storageId:undefined},'/repo',storage),/storage identity/);
 }finally{a.dispose();b.dispose();c.dispose();}
});
