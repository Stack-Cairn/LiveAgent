import type { ImageTransport } from '@liveagent/ui/lib/imaging/client';
import fixture from '@liveagent/ui/lib/imaging/testdata/wire-v1.json';
const version = 'kbrain.image.v1';
const now = () => new Date().toISOString();
const settings = structuredClone(fixture.settings) as any;
settings.targets = [{ ...settings.targets[0], id: 'fake-enabled', name: 'TEST ONLY Enabled', enabled: true, disabledReason: undefined, capabilities: { ...settings.targets[0].capabilities, operations: ['generate','reference','edit','mask'], maxInputs: 4, supportsCancel: true, supportsContinuation: true } }, { ...settings.targets[0], id: 'fake-disabled', name: 'TEST ONLY Disabled', disabledReason: 'TEST fixture deliberately disabled' }];
const projects:any[] = []; const jobs:any[] = []; const keys = new Map<string,any>();
const audit:any[] = []; const streams:Record<string,number> = {};
export const state = { audit, projects, jobs, settings, mode: 'success', conflict: false };
(window as any).__fixture = state;
const json = (data:any, status=200) => new Response(JSON.stringify({version,...data}), {status, headers:{'Content-Type':'application/json'}});
const err = (code:string,status=409) => json({error:{code,message:'TEST fixture error',requestId:'fake-request',retryable:false}},status);
const asset = (id:string, jobId?:string) => ({id,hash:'fake-hash',mime:'image/png',bytes:100,width:320,height:240,source:jobId?'generated':'upload',parentAssetIds:[],...(jobId?{jobId}:{}),createdAt:now(),available:true});
const canvas = document.createElement('canvas'); canvas.width=320; canvas.height=240; const ctx=canvas.getContext('2d')!;ctx.fillStyle='#2266bb';ctx.fillRect(0,0,320,240);ctx.fillStyle='white';ctx.font='22px sans-serif';ctx.fillText('TEST FIXTURE',70,120);
const image = await new Promise<Blob>(resolve=>canvas.toBlob(blob=>resolve(blob!),'image/png'));
export const transport:ImageTransport = async (path, init) => {
 const url=new URL(path,'http://fixture.invalid'); const p=url.pathname.replace('/v1/image',''); const method=init.method||'GET'; const body=typeof init.body==='string'?JSON.parse(init.body):undefined;
 audit.push({path,method,key:new Headers(init.headers).get('Idempotency-Key'),after:new Headers(init.headers).get('Last-Event-ID'),body:p==='/secrets'?{connectionId:body.connectionId,purpose:body.purpose,value:'[REDACTED]'}:body});
 if(path==='/v1/health') return new Response(JSON.stringify({status:'ok',capabilities:{image:{supported:true,version}}}));
 if(p==='/targets') return json({items:settings.targets});
 if(p==='/settings' && method==='GET')return json({settings});
 if(p==='/settings' && method==='PUT'){if(state.conflict){state.conflict=false;settings.revision++;return err('IMAGE_REVISION_CONFLICT');} if(body.expectedRevision!==settings.revision)return err('IMAGE_REVISION_CONFLICT');Object.assign(settings,{...body,revision:settings.revision+1});return json({settings});}
 if(p==='/secrets')return json({ref:'fake-opaque-ref',configured:true});
 if(p==='/projects' && method==='GET')return json({items:projects});
 if(p==='/projects' && method==='POST'){const project={id:`project-${projects.length+1}-${Date.now()}`,title:body.title,revision:1,createdAt:now(),updatedAt:now()};projects.push(project);return json({project});}
 if(p.startsWith('/projects/')) {const index=projects.findIndex(x=>x.id===p.split('/')[2]);if(method==='DELETE'){projects.splice(index,1);return new Response(null,{status:204});}if(method==='PATCH'){Object.assign(projects[index],{title:body.title,revision:projects[index].revision+1});return json({project:projects[index]});}}
 if(p==='/assets' && method==='POST'){const f=(init.body as FormData).get('file') as File; audit[audit.length-1].upload={name:f.name,size:f.size,type:f.type};return json({asset:asset('ia_upload_1')});}
 if(p.startsWith('/assets/') && p.endsWith('/content')) return new Response(image,{headers:{'Content-Type':'image/png'}});
 if(p==='/jobs' && method==='GET')return json({items:jobs.filter(j=>j.projectId===url.searchParams.get('projectId'))});
 if(p==='/jobs' && method==='POST'){
  const key=new Headers(init.headers).get('Idempotency-Key')!;
  if(keys.has(key))return json({job:keys.get(key),replayed:true});
  if(state.mode==='error')return err('IMAGE_INVALID_INPUT',400);
  const target=settings.targets.find((x:any)=>x.id===body.targetId); const job={id:`job-${jobs.length+1}`,projectId:body.projectId,request:body,targetSnapshot:target,status:'running',revision:1,assetIds:[],items:[],usage:null,createdAt:now(),updatedAt:now(),lastEventSeq:0,firstAvailableSeq:1,fixtureMode:state.mode};
  jobs.push(job);keys.set(key,job);
  await new Promise(r=>setTimeout(r,450));
  if(state.mode==='unknown'){state.mode='success';throw new Error('TEST simulated lost receipt');}
  return json({job,replayed:false});
 }
 if(p.startsWith('/jobs/')){
  const id=p.split('/')[2];const job=jobs.find(j=>j.id===id);
  if(p.endsWith('/cancel')){job.status='cancelled';job.revision++;return json({job});}
  if(p.endsWith('/events')){
   streams[id]=(streams[id]||0)+1;
   if(job.fixtureMode==='hold'){return new Response(new ReadableStream({start(c){init.signal?.addEventListener('abort',()=>{try{c.close();}catch{}});}}),{headers:{'Content-Type':'text/event-stream'}});}
   const sse=(seq:number,type:string,data:any)=>`id: ${seq}\nevent: image.event\ndata: ${JSON.stringify({jobId:id,seq,revision:seq+1,type,timestamp:now(),data})}\n\n`;
   if(job.fixtureMode==='reconnect' && streams[id]===1)return new Response(sse(1,'job.state_changed',{status:'running'}),{headers:{'Content-Type':'text/event-stream'}});
   const ids=[`ia_${id}-a`,`ia_${id}-b`];job.assetIds=ids;job.status='succeeded';job.revision=5;job.lastEventSeq=4;job.items=ids.map((a,i)=>({id:`item-${i}`,status:'succeeded',attemptCount:1,outputAssetIds:[a]}));
   return new Response(sse(2,'asset.ready',{asset:asset(ids[0],id)})+sse(3,'asset.ready',{asset:asset(ids[1],id)})+sse(4,'job.finished',{status:'succeeded'}),{headers:{'Content-Type':'text/event-stream'}});
  }
  return json({job});
 }
 throw new Error(`Unhandled TEST route ${method} ${path}`);
};
