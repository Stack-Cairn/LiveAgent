import assert from 'node:assert/strict';
import test from 'node:test';
import { createTsModuleLoader } from '../helpers/load-ts-module.mjs';
const { ImageStudioController }=createTsModuleLoader().loadModule('@liveagent/ui/features/image-studio/studioController');
const target={id:'t',enabled:true,parameters:[],capabilities:{operations:['generate','edit'],maxCount:4,maxInputs:2}};
const job={id:'j',projectId:'p',revision:1,lastEventSeq:0,status:'running',assetIds:[],items:[],usage:null};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fake(overrides={}) {return {capabilities:async()=>({supported:true}),listTargets:async()=>[target],listProjects:async()=>({items:[{id:'p',title:'P'}]}),listJobs:async()=>({items:[]}),getJob:async()=>job,subscribe:async()=>{},readAsset:async()=>new Blob(),...overrides};}
test('UI controller ignores a click while a request is in flight; every later click is a fresh request',async()=>{
 const pending=deferred();const calls=[];const c=new ImageStudioController(fake({createJob:(request,key)=>{calls.push({request,key});return pending.promise;}}),'o','b');
 await c.start();c.updateDraft({prompt:'first'});const first=c.submit();c.updateDraft({prompt:'second'});await c.submit();assert.equal(calls.length,1);
 pending.reject(new Error('network'));await first;assert.equal(c.view.submission.status,'unknown');
 c.client.createJob=async(request,key)=>{calls.push({request,key});return job;}; await c.submit();assert.notEqual(calls[0].key,calls[1].key);assert.equal(calls[1].request.prompt,'second');
 await c.submit();assert.notEqual(calls[1].key,calls[2].key);c.dispose();
});
test('explicit input rejection preserves editable draft; server or protocol ambiguity retains the same submission',async()=>{
 for(const error of [{status:422,code:'IMAGE_INVALID_INPUT'},{status:401,code:'IMAGE_AUTH_REQUIRED'}]) {
  const calls=[]; const c=new ImageStudioController(fake({createJob:async(request,key)=>{calls.push({request,key});throw error;}}),'o','b');
  await c.start();c.updateDraft({prompt:'draft'});await c.submit();assert.equal(c.view.submission,null);assert.equal(c.view.draft.prompt,'draft');assert.match(c.view.notice,/请求已被拒绝/);
  c.updateDraft({prompt:'corrected'});c.client.createJob=async(request,key)=>{calls.push({request,key});return job;};await c.submit();assert.equal(calls[1].request.prompt,'corrected');assert.notEqual(calls[0].key,calls[1].key);c.dispose();
 }
 for(const error of [{status:503,code:'IMAGE_UNAVAILABLE'},{status:422,code:'IMAGE_PROTOCOL_ERROR'}]) {
  const c=new ImageStudioController(fake({createJob:async()=>{throw error;}}),'o','b');await c.start();c.updateDraft({prompt:'draft'});await c.submit();assert.equal(c.view.submission.status,'unknown');c.dispose();
 }
});
test('disabled target never submits and old backend never calls image routes',async()=>{
 let calls=0;const c=new ImageStudioController(fake({listTargets:async()=>[{...target,enabled:false}],createJob:async()=>{calls++;return job;}}),'o','b');await c.start();c.updateDraft({prompt:'x'});await c.submit();assert.equal(calls,0);c.dispose();
 const old=new ImageStudioController(fake({capabilities:async()=>({supported:false}),listTargets:async()=>{throw Error('must not fetch');}}),'o','b');await old.start();assert.equal(old.view.supported,false);old.dispose();
});
test('scope disposal aborts uploads and late completion cannot change the next project',async()=>{
 const pending=deferred();let signal;const c=new ImageStudioController(fake({upload:(_file,_name,s)=>{signal=s;return pending.promise;}}),'o','b');await c.start();const upload=c.upload(new Blob(['image'],{type:'image/png'}),'cat.png','source');for(let i=0;i<50&&!signal;i++)await new Promise(r=>setImmediate(r));c.dispose();assert.equal(signal.aborted,true);pending.resolve({id:'ia_a',available:true});await upload;assert.equal(c.view.draft.inputs.length,0);
});
test('event gaps get a snapshot and resume from snapshot sequence',async()=>{
 const after=[];let reads=0;const c=new ImageStudioController(fake({listJobs:async()=>({items:[job]}),getJob:async()=>{reads++;return {...job,revision:3,lastEventSeq:8};},subscribe:async(_id,seq,callback)=>{after.push(seq);if(after.length===1)callback({jobId:'j',seq:5,revision:2,type:'job.state_changed',data:{status:'running'}});}}),'o','b');await c.start();await new Promise(r=>setTimeout(r,20));assert.equal(reads,1);assert.deepEqual(after,[0,8]);c.dispose();
});
test('disposing while the file format is still being checked never sends the upload',async()=>{
 let calls=0;const c=new ImageStudioController(fake({upload:async()=>{calls++;return {id:'ia_never',available:true};}}),'o','b');await c.start();const upload=c.upload(new Blob(['image'],{type:'image/png'}),'cat.png','source');c.dispose();await upload;assert.equal(calls,0);assert.equal(c.view.draft.inputs.length,0);
});
