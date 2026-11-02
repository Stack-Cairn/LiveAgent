import assert from 'node:assert/strict';
import test from 'node:test';
import { createTsModuleLoader } from '../helpers/load-ts-module.mjs';
const { validateParameters, migrateParameters } = createTsModuleLoader().loadModule('@liveagent/ui/features/image-studio/parameterModel');
const target = (sizes) => ({parameters:[{key:'size',label:'尺寸',type:'string',required:true,enum:sizes},{key:'quality',label:'质量',type:'string',required:false,enum:['high']},{key:'transparent',label:'透明',type:'boolean',required:false},{key:'steps',label:'步数',type:'integer',required:false,minimum:1,maximum:10}]});
test('target migration retains compatible values and reports incompatible values',()=>{
 const result=migrateParameters(target(['1:1','4K']),target(['1:1']),{size:'4K',quality:'high'});
 assert.equal(result.values.quality,'high'); assert.deepEqual([...result.dropped],['size']);
 assert.equal(migrateParameters(target(['1:1']),target(['1:1']),{size:'1:1'}).values.size,'1:1');
});
test('required, enum, strict boolean, finite integer, unknown parameters are rejected',()=>{
 for(const params of [{},{size:'4K'},{size:'1:1',transparent:'true'},{size:'1:1',steps:1.5},{size:'1:1',steps:Infinity},{size:'1:1',secret:'x'}]) assert.ok(validateParameters(target(['1:1']),params).length);
 assert.equal(validateParameters(target(['1:1']),{size:'1:1',transparent:false,steps:3}).length,0);
});
