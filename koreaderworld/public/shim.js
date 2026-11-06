/* Koreaderworld standalone: stands in for claude.ai's window.claude.use(...) using our own server.
   room -> WebSocket /ws, sample -> /api/claude, db -> /api/scores, user -> an id kept in this browser. */
(function(){
  const store=(k,v)=>{try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v);}catch(e){}return null;};
  let uid=store('kdw.uid');
  if(!uid){uid=Array.from(crypto.getRandomValues(new Uint8Array(12))).map(b=>b.toString(16).padStart(2,'0')).join('');store('kdw.uid',uid);}
  const K={id:null,peers:[],handlers:{},peerFns:[],connFns:[],sigFns:[],extra:{},lastPres:null,ws:null};
  window.KDW=K;
  const fire=(arr,...a)=>arr.forEach(f=>{try{f(...a);}catch(e){console.error(e);}});
  const sendRaw=o=>{if(K.ws&&K.ws.readyState===1)K.ws.send(JSON.stringify(o));};
  const view=()=>K.peers.map(p=>({peer:p.peer,isMe:p.peer===K.id,kind:'viewer',presence:p.presence}));
  const emitPeers=()=>fire(K.peerFns,{peers:view()});
  function connect(){
    const ws=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/ws');K.ws=ws;
    ws.onopen=()=>{K.sendPresence();fire(K.connFns);};
    ws.onmessage=e=>{let m;try{m=JSON.parse(e.data);}catch(x){return;}
      if(m.t==='welcome'){K.id=m.id;K.peers=m.peers||[];emitPeers();K.sendPresence();}
      else if(m.t==='peers'){K.peers=m.peers||[];emitPeers();}
      else if(m.t==='msg')fire(K.handlers[m.topic]||[],{topic:m.topic,data:m.data,peer:m.peer,sameTab:false});
      else if(m.t==='sig')fire(K.sigFns,m.from,m.data);};
    ws.onclose=()=>{K.id=null;K.peers=[];emitPeers();fire(K.connFns);setTimeout(connect,2500);};
  }
  K.sendPresence=()=>{if(K.lastPres)sendRaw({t:'pres',p:Object.assign({},K.lastPres,K.extra)});};
  K.signal=(to,data)=>sendRaw({t:'sig',to,data});
  K.onSignal=f=>K.sigFns.push(f);
  const room={
    emit:(topic,data)=>{sendRaw({t:'emit',topic,data});return Promise.resolve();},
    on:(topic,fn)=>{(K.handlers[topic]||(K.handlers[topic]=[])).push(fn);},
    onPeers:fn=>{K.peerFns.push(fn);fn({peers:view()});},
    onConnection:fn=>{K.connFns.push(fn);},
    peers:()=>view(),
    presence:p=>{K.lastPres=p;K.sendPresence();return Promise.resolve();}
  };
  const cfgP=fetch('/api/config').then(r=>r.json()).catch(()=>({ice:[{urls:'stun:stun.l.google.com:19302'}],claude:false}));
  K.config=()=>cfgP;
  const sample=async input=>{
    const messages=typeof input==='string'?[{role:'user',content:input}]:input;
    const r=await fetch('/api/claude',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw {code:j.code||'error',message:j.message||''};
    return {text:j.text||'',truncated:false};
  };
  sample.json=async(input,opts)=>{const t=(await sample(input,opts)).text;const a=t.indexOf('{'),b=t.lastIndexOf('}');if(a<0||b<a)throw {code:'bad_json'};return JSON.parse(t.slice(a,b+1));};
  const db={
    doc:p=>({set:async obj=>{const id=String(p).split('/')[1];const r=await fetch('/api/scores/'+encodeURIComponent(id),{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(obj)});if(!r.ok)throw {code:'error'};}}),
    collection:()=>{const q={k:'jegi',orderBy(k){q.k=k;return q;},limit(){return q;},async get(){const r=await fetch('/api/scores?k='+encodeURIComponent(q.k));const j=await r.json();return {docs:(j.rows||[]).map(x=>({id:x.id,data:()=>x}))};}};return q;}
  };
  const user={id:async()=>uid,me:async()=>({id:uid,name:''}),isOwner:()=>false,canEdit:()=>false,can:()=>true};
  window.claude={use:async name=>{
    if(name==='room'){if(!K.ws)connect();return room;}
    if(name==='sample'){const c=await cfgP;return c.claude?sample:null;}
    if(name==='db')return db;
    if(name==='user')return user;
    return null;
  }};
})();
