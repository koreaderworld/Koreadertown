/* Koreaderworld server — no dependencies, Node.js 18 or newer.
   - serves the game from ./public
   - WebSocket at /ws: who is online, positions, chat, emotes, and WebRTC signalling for voice chat
   - POST /api/claude: forwards staff conversations to the Anthropic API with the key kept on the server
   - /api/scores: the shared ranking, saved to ./data/scores.json
   Environment: PORT, ANTHROPIC_API_KEY, CLAUDE_MODEL, TURN_URL, TURN_USER, TURN_PASS, MAX_PLAYERS */
'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');

const PORT=Number(process.env.PORT)||3000;
const API_KEY=process.env.ANTHROPIC_API_KEY||'';
const MODEL=process.env.CLAUDE_MODEL||'claude-haiku-5-5';
const API_BASE=(process.env.ANTHROPIC_BASE_URL||'https://api.anthropic.com').replace(/\/$/,'');
const MAX_PLAYERS=Number(process.env.MAX_PLAYERS)||30;
const PUBLIC=path.join(__dirname,'public'),DATA=path.join(__dirname,'data'),SCORE_FILE=path.join(DATA,'scores.json');
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.webmanifest':'application/manifest+json'};

/* ---------------- ranking ---------------- */
let scores={};
try{scores=JSON.parse(fs.readFileSync(SCORE_FILE,'utf8'))||{};}catch(e){scores={};}
let saveTimer=null;
function saveScores(){if(saveTimer)return;saveTimer=setTimeout(()=>{saveTimer=null;try{fs.mkdirSync(DATA,{recursive:true});fs.writeFileSync(SCORE_FILE,JSON.stringify(scores));}catch(e){console.error('scores not saved',e.message);}},1500);}
const SCORE_KEYS=['jegi','grill','rhy','work','quiz','dict'];
function cleanScore(b){
  const o={n:String(b.n||'손님').slice(0,10),t:Date.now()};
  SCORE_KEYS.forEach(k=>{const v=Number(b[k]);o[k]=Number.isFinite(v)?Math.max(0,Math.min(1e6,Math.round(v))):0;});
  return o;
}

/* ---------------- small helpers ---------------- */
function send(res,code,body,type){res.writeHead(code,{'Content-Type':type||'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));}
function readBody(req,limit){return new Promise((ok,bad)=>{let n=0;const parts=[];req.on('data',c=>{n+=c.length;if(n>limit){bad(new Error('too big'));req.destroy();}else parts.push(c);});req.on('end',()=>ok(Buffer.concat(parts).toString('utf8')));req.on('error',bad);});}
const hits=new Map();/* simple per-IP rate limit */
function limited(ip,key,max,perMs){const k=ip+'|'+key,now=Date.now();let h=hits.get(k);if(!h||now-h.t>perMs){h={t:now,n:0};hits.set(k,h);}h.n++;return h.n>max;}
setInterval(()=>{const now=Date.now();hits.forEach((v,k)=>{if(now-v.t>120000)hits.delete(k);});},60000).unref();
const ipOf=req=>String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();

/* ---------------- HTTP ---------------- */
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://x');const ip=ipOf(req);
  try{
    if(url.pathname==='/api/config'){
      const ice=[{urls:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302']}];
      if(process.env.TURN_URL)ice.push({urls:process.env.TURN_URL.split(','),username:process.env.TURN_USER||'',credential:process.env.TURN_PASS||''});
      return send(res,200,{ice,claude:!!API_KEY,max:MAX_PLAYERS});
    }
    if(url.pathname==='/api/claude'&&req.method==='POST'){
      if(!API_KEY)return send(res,503,{code:'not_granted',message:'ANTHROPIC_API_KEY is not set'});
      if(limited(ip,'claude',30,60000))return send(res,429,{code:'rate_limited'});
      const body=JSON.parse(await readBody(req,24000)||'{}');
      const msgs=(Array.isArray(body.messages)?body.messages:[]).slice(-12).map(m=>({role:m.role==='assistant'?'assistant':'user',content:String(m.content||'').slice(0,4000)})).filter(m=>m.content);
      if(!msgs.length||msgs[msgs.length-1].role!=='user')return send(res,400,{code:'bad_request'});
      const r=await fetch(API_BASE+'/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':API_KEY,'anthropic-version':'2023-06-01'},
        body:JSON.stringify({model:MODEL,max_tokens:400,messages:msgs,system:'You are part of a cozy Korean-language town game called Koreaderworld. Follow the format the user asks for exactly. Keep replies short and kind.'})});
      const j=await r.json().catch(()=>({}));
      if(!r.ok)return send(res,502,{code:'upstream',message:(j.error&&j.error.message)||('status '+r.status)});
      const text=(j.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('');
      return send(res,200,{text});
    }
    if(url.pathname==='/api/scores'&&req.method==='GET'){
      const k=SCORE_KEYS.includes(url.searchParams.get('k'))?url.searchParams.get('k'):'jegi';
      const rows=Object.entries(scores).map(([id,v])=>Object.assign({id},v)).filter(r=>r[k]>0).sort((a,b)=>b[k]-a[k]).slice(0,10);
      return send(res,200,{rows});
    }
    const m=url.pathname.match(/^\/api\/scores\/([A-Za-z0-9_-]{8,64})$/);
    if(m&&req.method==='PUT'){
      if(limited(ip,'score',20,60000))return send(res,429,{code:'rate_limited'});
      scores[m[1]]=cleanScore(JSON.parse(await readBody(req,4000)||'{}'));saveScores();
      return send(res,200,{ok:true});
    }
    /* static files */
    let p=decodeURIComponent(url.pathname);if(p==='/')p='/index.html';
    const file=path.normalize(path.join(PUBLIC,p));
    if(!file.startsWith(PUBLIC))return send(res,403,'forbidden','text/plain');
    fs.readFile(file,(err,buf)=>{
      if(err)return send(res,404,'not found','text/plain');
      res.writeHead(200,{'Content-Type':TYPES[path.extname(file)]||'application/octet-stream','Cache-Control':p==='/index.html'?'no-cache':'public, max-age=3600'});res.end(buf);
    });
  }catch(e){send(res,500,{code:'error',message:String(e.message||e)});}
});

/* ---------------- WebSocket (RFC 6455, text frames) ---------------- */
const clients=new Map();/* id -> {sock,presence,ip,alive} */
let changed=false;
function wsSend(c,obj){
  if(c.sock.destroyed)return;
  const data=Buffer.from(JSON.stringify(obj));const n=data.length;
  const head=n<126?Buffer.from([0x81,n]):n<65536?Buffer.from([0x81,126,n>>8,n&255]):Buffer.concat([Buffer.from([0x81,127,0,0,0,0]),Buffer.from([(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255])]);
  try{c.sock.write(Buffer.concat([head,data]));}catch(e){}
}
function peersList(){return [...clients].filter(([,c])=>c.presence).map(([id,c])=>({peer:id,presence:c.presence}));}
setInterval(()=>{if(!changed)return;changed=false;const list=peersList();clients.forEach(c=>wsSend(c,{t:'peers',peers:list}));},100).unref();
setInterval(()=>{clients.forEach((c,id)=>{if(!c.alive){c.sock.destroy();return;}c.alive=false;try{c.sock.write(Buffer.from([0x89,0]));}catch(e){}});},25000).unref();

function onMessage(id,c,text){
  let m;try{m=JSON.parse(text);}catch(e){return;}
  if(!m||typeof m!=='object')return;
  if(m.t==='pres'&&m.p&&typeof m.p==='object'){const s=JSON.stringify(m.p);if(s.length<1200){c.presence=m.p;changed=true;}}
  else if(m.t==='emit'&&typeof m.topic==='string'&&/^[a-z]{1,16}$/.test(m.topic)){
    if(limited(c.ip+id,'emit',40,10000))return;
    const s=JSON.stringify(m.data||null);if(s.length>2000)return;
    clients.forEach((o,oid)=>{if(oid!==id)wsSend(o,{t:'msg',topic:m.topic,data:m.data,peer:id});});
  }
  else if(m.t==='sig'&&typeof m.to==='string'){
    const o=clients.get(m.to);if(!o)return;const s=JSON.stringify(m.data||null);if(s.length>20000)return;
    wsSend(o,{t:'sig',from:id,data:m.data});
  }
}
server.on('upgrade',(req,sock)=>{
  const url=new URL(req.url,'http://x');
  if(url.pathname!=='/ws'||String(req.headers.upgrade).toLowerCase()!=='websocket'){sock.destroy();return;}
  if(clients.size>=MAX_PLAYERS){sock.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');return;}
  const key=req.headers['sec-websocket-key'];if(!key){sock.destroy();return;}
  const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  sock.setNoDelay(true);
  const id=crypto.randomBytes(6).toString('hex');
  const c={sock,presence:null,ip:ipOf(req),alive:true};clients.set(id,c);
  wsSend(c,{t:'welcome',id,peers:peersList()});
  let buf=Buffer.alloc(0),frag=[];
  sock.on('data',chunk=>{
    buf=Buffer.concat([buf,chunk]);
    if(buf.length>1<<20){sock.destroy();return;}
    for(;;){
      if(buf.length<2)return;
      const b0=buf[0],b1=buf[1],fin=b0&0x80,op=b0&0x0f,masked=b1&0x80;let len=b1&0x7f,off=2;
      if(len===126){if(buf.length<4)return;len=buf.readUInt16BE(2);off=4;}
      else if(len===127){if(buf.length<10)return;len=Number(buf.readBigUInt64BE(2));off=10;}
      if(!masked){sock.destroy();return;}
      if(buf.length<off+4+len)return;
      const mask=buf.slice(off,off+4);const data=Buffer.from(buf.slice(off+4,off+4+len));
      for(let i=0;i<data.length;i++)data[i]^=mask[i&3];
      buf=buf.slice(off+4+len);c.alive=true;
      if(op===8){sock.end(Buffer.from([0x88,0]));return;}
      if(op===9){try{sock.write(Buffer.concat([Buffer.from([0x8a,data.length]),data]));}catch(e){}continue;}
      if(op===10)continue;
      if(op===1||op===0){frag.push(data);if(fin){const text=Buffer.concat(frag).toString('utf8');frag=[];onMessage(id,c,text);}}
    }
  });
  const bye=()=>{if(clients.delete(id)){changed=true;}};
  sock.on('close',bye);sock.on('end',bye);sock.on('error',bye);
});

server.listen(PORT,()=>{
  console.log('Koreaderworld is running on http://localhost:'+PORT);
  console.log(API_KEY?'Claude: on ('+MODEL+')':'Claude: off (set ANTHROPIC_API_KEY to turn on staff conversations)');
});
