import assert from 'node:assert/strict';
import test from 'node:test';
import { createTsModuleLoader } from '../helpers/load-ts-module.mjs';
const { initialStudioState, applyImageEvent, applyJobSnapshot, freezeSubmission, markSubmissionUnknown, errorAction, jobResultCount }=createTsModuleLoader().loadModule('@liveagent/ui/features/image-studio/studioModel');
const job={id:'j',projectId:'p',revision:1,lastEventSeq:0,status:'running',assetIds:[],items:[],usage:null};
const event=(seq,revision,data,type='asset.ready')=>({jobId:'j',seq,revision,type,timestamp:'now',data});
test('events ignore duplicate and old revision, preserve partial results and selection on snapshot',()=>{
 let s=applyJobSnapshot(initialStudioState('o','b'),job); s=applyImageEvent(s,event(1,2,{asset:{id:'a',available:true}})); s={...s,selectedAssetId:'a'};
 assert.equal(applyImageEvent(s,event(1,2,{asset:{id:'a'}})),s); assert.equal(applyImageEvent(s,event(2,1,{status:'failed'})),s);
 s=applyImageEvent(s,event(2,3,{status:'partial_succeeded'},'job.finished')); assert.equal(jobResultCount(s.jobs.j),1);
 s=applyJobSnapshot(s,{...s.jobs.j,revision:4,lastEventSeq:3}); assert.equal(s.selectedAssetId,'a'); assert.equal(s.lastSeqByJob.j,3);
 assert.equal(initialStudioState('o','other').jobs.j,undefined);
});
test('event sequence gap requests snapshot without applying out-of-order state',()=>{
 const s=applyImageEvent(applyJobSnapshot(initialStudioState('o','b'),job),event(3,3,{status:'succeeded'},'job.finished'));
 assert.equal(s.jobs.j.status,'running'); assert.equal(s.snapshotNeeded.j,true);
});
test('empty successful response becomes failed; unknown usage remains unknown',()=>{
 const s=applyJobSnapshot(initialStudioState('o','b'),{...job,status:'succeeded'}); assert.equal(s.jobs.j.status,'failed'); assert.equal(s.jobs.j.usage,null);
 assert.match(errorAction({code:'HTTP_401'}),/设置/); assert.match(errorAction({code:'HTTP_429'}),/等待/);
});
test('submission freezes request, double clicks and unknown retries retain the original key',()=>{
 const request={projectId:'p',parameters:{size:'1K'},inputs:[],prompt:'first'};
 const one=freezeSubmission(request,()=> 'key1'); request.parameters.size='4K'; request.prompt='changed';
 assert.equal(one.request.parameters.size,'1K'); assert.equal(one.key,'key1');
 assert.equal(markSubmissionUnknown(one).key,'key1');
});
