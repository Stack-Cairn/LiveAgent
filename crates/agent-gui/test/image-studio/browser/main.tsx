import React from 'react';
import {createRoot} from 'react-dom/client';
import '@liveagent/app/index.css';
import {ImageStudioPage} from '@liveagent/ui/features/image-studio/ImageStudioPage';
import {createImageStudioClient} from '@liveagent/ui/lib/imaging/client';
import {transport,state} from './fixture';
const client=createImageStudioClient({transport,reconnectDelaysMs:[20,40]});
const memory=new Map<string,string>();
const storage={getItem:(key:string)=>memory.get(key)??null,setItem:(key:string,v:string)=>{memory.set(key,v)},removeItem:(key:string)=>{memory.delete(key)}};
const isSettings=new URLSearchParams(location.search).has('settings');
createRoot(document.getElementById('root')!).render(<div style={{height:'100dvh',display:'flex',flexDirection:'column'}}>
 <header style={{background:'#fff0a8',color:'#222',padding:'6px',fontSize:12}}>
  TEST MODE — fake transport only / no provider calls / NOT production dual-host acceptance
  <nav><a href="/">Workbench test</a> | <a href="/?settings">Settings test (reloads fixture)</a></nav>
  <label> Fixture <select aria-label="Fixture mode" onChange={e=>state.mode=e.target.value}><option value="success">Success</option><option value="unknown">Lost receipt</option><option value="error">Submit error</option><option value="hold">Pending / cancel</option><option value="reconnect">SSE reconnect</option></select></label>
  <label> <input type="checkbox" aria-label="Conflict on next settings save" onChange={e=>state.conflict=e.target.checked}/> Conflict on next settings save</label>
 </header>
 <div style={{flex:1,minHeight:0,overflow:isSettings?'auto':undefined}}>{isSettings?<pre>{JSON.stringify(state.settings,null,2)}</pre>:<ImageStudioPage client={client} ownerId="fake-owner" backendId="fake-backend" storage={storage}/>}</div>
</div>);
