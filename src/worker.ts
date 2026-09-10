export interface Env {
  DB: D1Database;
  IVT_CONFIG: KVNamespace;
  REPLAY_GUARD: DurableObjectNamespace;
  IVT_MODE: string;
  RUNTIME_TTL_SECONDS: string;
  ALLOWED_ORIGINS: string;
}

type AdmitBody = { siteKey?: string; nonce?: string; page?: Record<string, unknown>; browser?: Record<string, unknown>; attribution?: Record<string, unknown> };
const json = (body: unknown, status = 200, origin?: string) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}) } });
function allowedOrigin(request: Request, env: Env) { const origin=request.headers.get("Origin"); if(!origin)return null; return new Set(env.ALLOWED_ORIGINS.split(",").map(v=>v.trim()).filter(Boolean)).has(origin)?origin:null; }
function edgeEvidence(request: Request) { const cf=(request as Request & {cf?:Record<string,any>}).cf||{}; const bm=cf.botManagement||{}; return {country:cf.country||null,colo:cf.colo||null,asn:cf.asn||null,botScore:typeof bm.score==="number"?bm.score:null,verifiedBot:bm.verifiedBot===true?1:bm.verifiedBot===false?0:null,ja4:bm.ja4||null}; }
async function sha256(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))).map(b=>b.toString(16).padStart(2,"0")).join("");}

export default { async fetch(request:Request,env:Env):Promise<Response>{
  const url=new URL(request.url);
  if(url.pathname==="/health")return json({ok:true,service:"thebes-ivt",mode:env.IVT_MODE});
  if(request.method==="OPTIONS"){const origin=allowedOrigin(request,env);if(!origin)return new Response(null,{status:403});return new Response(null,{status:204,headers:{"access-control-allow-origin":origin,"access-control-allow-methods":"POST,OPTIONS","access-control-allow-headers":"content-type","access-control-max-age":"600",vary:"Origin"}});}
  if(url.pathname==="/v1/admit"&&request.method==="POST"){
    const origin=allowedOrigin(request,env);if(!origin)return json({status:"NO_RUNTIME"},403);
    let body:AdmitBody;try{body=await request.json<AdmitBody>();}catch{return json({status:"NO_RUNTIME"},400,origin);}
    if(!body.siteKey||!body.nonce||body.nonce.length<24||body.nonce.length>256)return json({status:"NO_RUNTIME"},400,origin);
    const site=await env.DB.prepare("SELECT id, enabled, mode FROM sites WHERE site_key = ? LIMIT 1").bind(body.siteKey).first<{id:number;enabled:number;mode:string}>();
    if(!site||!site.enabled)return json({status:"NO_RUNTIME"},403,origin);
    const sessionId=crypto.randomUUID();const capability=crypto.randomUUID().replaceAll("-","")+crypto.randomUUID().replaceAll("-","");const now=Date.now();const ttl=Math.max(15,Math.min(300,Number(env.RUNTIME_TTL_SECONDS||"60")));const edge=edgeEvidence(request);const mode=site.mode||env.IVT_MODE||"shadow";const classification="UNCLASSIFIED";const decision=mode==="shadow"?"WOULD_OBSERVE":"OBSERVE";
    await env.DB.prepare(`INSERT INTO traffic_sessions (id,site_id,client_nonce_hash,country,colo,asn,cf_bot_score,cf_verified_bot,cf_ja4,risk_score,classification,decision,mode) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)`).bind(sessionId,site.id,await sha256(body.nonce),edge.country,edge.colo,edge.asn,edge.botScore,edge.verifiedBot,edge.ja4,classification,decision,mode).run();
    const guard=env.REPLAY_GUARD.get(env.REPLAY_GUARD.idFromName(capability));await guard.fetch("https://replay-guard/register",{method:"POST",body:JSON.stringify({sessionId,origin,expiresAt:now+ttl*1000})});
    return json({status:"ADMITTED",runtime:`/v1/runtime/${capability}`,expiresIn:ttl},200,origin);
  }
  if(url.pathname.startsWith("/v1/runtime/")&&request.method==="GET"){
    const origin=allowedOrigin(request,env);if(!origin)return new Response("",{status:403});const capability=url.pathname.slice("/v1/runtime/".length);if(!/^[a-f0-9]{64}$/i.test(capability))return new Response("",{status:404});
    const guard=env.REPLAY_GUARD.get(env.REPLAY_GUARD.idFromName(capability));const consumed=await guard.fetch("https://replay-guard/consume",{method:"POST",body:JSON.stringify({origin,now:Date.now()})});if(!consumed.ok)return new Response("",{status:404});
    const bootstrap=`(()=>{window.dispatchEvent(new CustomEvent("thebes:ivt-admitted",{detail:{v:1}}));})();`;return new Response(bootstrap,{headers:{"content-type":"application/javascript; charset=utf-8","cache-control":"no-store, private","x-content-type-options":"nosniff","access-control-allow-origin":origin,vary:"Origin"}});
  }
  return new Response("Not found",{status:404});
}};

export class ReplayGuard { constructor(private state:DurableObjectState){} async fetch(request:Request):Promise<Response>{const url=new URL(request.url);if(url.pathname==="/register"&&request.method==="POST"){const data=await request.json<{sessionId:string;origin:string;expiresAt:number}>();await this.state.storage.put("capability",{...data,consumed:false});return new Response("ok");}if(url.pathname==="/consume"&&request.method==="POST"){const input=await request.json<{origin:string;now:number}>();const cap=await this.state.storage.get<{origin:string;expiresAt:number;consumed:boolean}>("capability");if(!cap||cap.consumed||input.now>cap.expiresAt||input.origin!==cap.origin)return new Response("invalid",{status:404});await this.state.storage.put("capability",{...cap,consumed:true});return new Response("ok");}return new Response("Not found",{status:404});}}
