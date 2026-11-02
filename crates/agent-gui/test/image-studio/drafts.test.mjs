import assert from 'node:assert/strict';
import test from 'node:test';
import { createTsModuleLoader } from '../helpers/load-ts-module.mjs';
const { draftKey, serializeDraft, restoreDraft }=createTsModuleLoader().loadModule('@liveagent/ui/features/image-studio/drafts');
const scope={ownerId:'owner',backendId:'backend',projectId:'project'};
const target={id:'t',parameters:[{key:'quality',type:'string',label:'质量',required:false}]};
const value={prompt:'画一只猫',targetId:'t',parameters:{quality:'high',secret:'never',url:'https://private'},inputs:[{assetId:'ia_ok',role:'source'},{assetId:'ia_gone',role:'reference'}],parentAssetId:'ia_ok',secret:'never',downloadUrl:'https://private'};
test('scope keys are collision-free and scoped',()=>{assert.notEqual(draftKey('a:b','c','d'),draftKey('a','b:c','d')); assert.notEqual(draftKey('a','b','c'),draftKey('a','other','c'));});
test('only versioned scoped public fields survive, restored assets must be available',async()=>{
 const raw=serializeDraft(scope,value,[target]); assert.ok(!raw.includes('never')); assert.ok(!raw.includes('https://'));
 const result=await restoreDraft(raw,scope,[target],async id=>id==='ia_ok');
 assert.equal(result.draft.prompt,value.prompt); assert.equal(result.draft.inputs.length,1); assert.equal(result.invalidAssetIds[0],'ia_gone');
 assert.equal(await restoreDraft(raw,{...scope,backendId:'other'},[target],async()=>true),null);
 assert.equal(await restoreDraft(raw.replace('"version":1','"version":2'),scope,[target],async()=>true),null);
});
test('malformed drafts cannot smuggle arbitrary parameter keys or unknown asset roles',async()=>{
 const raw=JSON.stringify({version:1,scope,...value,inputs:[{assetId:'ia_ok',role:'evil'}]});
 const result=await restoreDraft(raw,scope,[target],async()=>true); assert.equal(result.draft.inputs.length,0); assert.deepEqual(Object.keys(result.draft.parameters),['quality']);
});
