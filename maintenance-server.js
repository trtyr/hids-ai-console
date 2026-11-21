import http from 'node:http';
import { createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PromptStore } from './src/contexts/knowledge/infrastructure/prompt-store.js';
import { UpdateStore, PACKAGE_LIMIT } from './update-store.js';
import { log } from './src/shared/logging/log.js';
import { sendMaintenanceFailure, maintenanceCodeFor } from './src/shared/errors.js';
import { runWithRequestContext, currentRequestContext } from './src/shared/logging/log.js';
import { AuditStore } from './src/contexts/audit/infrastructure/audit-store.js';
import { createAuditor } from './src/contexts/audit/application/audit-service.js';

const json = (res,status,data) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data)); };
const equal = (actual,expected) => actual.length===expected.length && timingSafeEqual(actual,expected);
const loopback = address => ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
const cookieName = 'hids_maintenance_session';
const sessionDuration = 8 * 60 * 60 * 1000;
function authenticated(req,access) {
  if(!access?.user||!access?.password)return false;
  const header=req.headers.authorization||'';
  return header.startsWith('Basic ') && equal(Buffer.from(header.slice(6),'base64'),Buffer.from(access.user+':'+access.password));
}
async function readBody(req,limit=PACKAGE_LIMIT) {
  const chunks=[];let size=0;
  for await(const chunk of req) {
    size+=chunk.length;
    if(size>limit)throw Object.assign(new Error(limit===PACKAGE_LIMIT?'升级包超过 2 MB':'请求正文过大'),{status:413});
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function writeAllowed(req) {
  if(req.headers['x-hids-maintenance']!=='1')return false;
  const site=req.headers['sec-fetch-site'];
  if(site && !['same-origin','none'].includes(site))return false;
  if(req.headers.origin) {
    try {
      const origin=new URL(req.headers.origin);
      if(!['http:','https:'].includes(origin.protocol)||origin.host!==req.headers.host)return false;
    } catch {return false;}
  }
  return true;
}
export function createMaintenanceServer(store,{access={},preview=false}={}) {
  const failures=new Map(),sessions=new Map();
  // 审计流（P003-T062）：维护端与业务端共用同一份 append-only 存储（`<数据根>/audit/`）。
  const auditor=createAuditor(new AuditStore(),{currentRequestContext});
  const role=access.role||'updater';
  const authorized=['updater','viewer'].includes(role);
  const loginEnabled=Boolean(access.user&&access.password);
  const recordFailure=key=>{
    const now=Date.now(),state=failures.get(key);
    const count=state&&now-state.at<60000?state.count+1:1;
    failures.set(key,{count,at:now,until:count>=10?now+60000:0});
  };
  // T072：维护端请求同样进 ALS 上下文（request_id 贯穿 + user：登录态或 Basic 凭据都可识别）。
  return http.createServer((req,res)=>runWithRequestContext({request_id:randomBytes(16).toString('hex'),user:null},
    ()=>handle(req,res)));
  async function handle(req,res){
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy','no-referrer');
    if(!loopback(req.socket.remoteAddress))return sendMaintenanceFailure(res,403,'loopback_only');
    if(preview&&!loopback(req.socket.localAddress))return sendMaintenanceFailure(res,403,'preview_loopback_only');
    let url;try{url=new URL(req.url,'http://localhost');}catch{return sendMaintenanceFailure(res,400,'invalid_url');}
    if(!url.pathname.startsWith('/api/maintenance/'))return sendMaintenanceFailure(res,404,'not_found');
    const token=(req.headers.cookie||'').split(';').map(item=>item.trim()).find(item=>item.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    const session=token?sessions.get(token):null;
    if(session&&session.expires<=Date.now())sessions.delete(token);
    const loggedIn=Boolean(session&&session.expires>Date.now())||authenticated(req,access);
    if(loggedIn)currentRequestContext().user=access.user||'maint';
    const previewAccess=preview&&!loginEnabled;
    const key=req.socket.remoteAddress;
    const cookie=(value,age)=>cookieName+'='+value+'; HttpOnly; SameSite=Strict; Path=/; Max-Age='+age+(req.socket.encrypted?'; Secure':'');
    const write=req.method!=='GET'&&req.method!=='HEAD';
    if(write&&!writeAllowed(req))return sendMaintenanceFailure(res,403,'csrf_rejected');
    try {
      if(url.pathname==='/api/maintenance/session'&&req.method==='GET')
        return json(res,200,{authenticated:loggedIn,preview,login_enabled:loginEnabled,
          user:loggedIn?access.user:null,role:loggedIn?role:null});
      if(url.pathname==='/api/maintenance/login'&&req.method==='POST') {
        if(!loginEnabled)return sendMaintenanceFailure(res,503,preview?'login_disabled_preview':'login_disabled');
        if(failures.get(key)?.until>Date.now())return sendMaintenanceFailure(res,429,'rate_limited');
        if((req.headers['content-type']||'').split(';')[0]!=='application/json')
          return sendMaintenanceFailure(res,415,'json_required');
        let data;
        try{data=JSON.parse((await readBody(req,8192)).toString('utf8'));}
        catch(cause){return sendMaintenanceFailure(res,cause.status||400,maintenanceCodeFor(cause),cause.status?cause.message:'登录请求格式不正确');}
        const correct=data&&typeof data.username==='string'&&typeof data.password==='string'&&
          equal(Buffer.from(data.username),Buffer.from(access.user))&&equal(Buffer.from(data.password),Buffer.from(access.password));
        if(!correct){recordFailure(key);
          // 审计（P003-T062）：登录失败记 denied——actor 用「尝试的用户名」（截断），密钥不进审计。
          void auditor({actor:{kind:'user',id:String(data?.username||'unknown').slice(0,100)},
            action:'maintenance.login',object:{kind:'maintenance_session'},result:'denied'});
          return sendMaintenanceFailure(res,401,'invalid_credentials');}
        if(!authorized)return sendMaintenanceFailure(res,403,'forbidden_role');
        failures.delete(key);
        for(const [id,value]of sessions)if(value.expires<=Date.now())sessions.delete(id);
        if(token)sessions.delete(token);
        if(sessions.size>=100)sessions.delete(sessions.keys().next().value);
        const id=randomBytes(32).toString('hex');
        sessions.set(id,{expires:Date.now()+sessionDuration});
        res.setHeader('Set-Cookie',cookie(id,sessionDuration/1000));
        void auditor({actor:{kind:'user',id:String(data?.username||access.user).slice(0,100)},
          action:'maintenance.login',object:{kind:'maintenance_session'}});
        return json(res,200,{user:access.user,role});
      }
      if(!previewAccess) {
        if(!loggedIn) {
          if(failures.get(key)?.until>Date.now())return sendMaintenanceFailure(res,429,'rate_limited');
          recordFailure(key);
          return sendMaintenanceFailure(res,401,'unauthorized');
        }
        if(!authorized)return sendMaintenanceFailure(res,403,'forbidden_role');
      }
      if(url.pathname==='/api/maintenance/logout'&&req.method==='POST') {
        if(token)sessions.delete(token);
        res.setHeader('Set-Cookie',cookie('',0));
        void auditor({actor:{kind:'user',id:String(access.user||'maint').slice(0,100)},
          action:'maintenance.logout',object:{kind:'maintenance_session'}});
        return json(res,200,{logged_out:true});
      }
      if(write) {
        if(preview)return sendMaintenanceFailure(res,403,'preview_read_only');
        if(role!=='updater')return sendMaintenanceFailure(res,403,'not_updater');
      }
      if(url.pathname==='/api/maintenance/overview'&&req.method==='GET') {
        const overview=await store.overview();
        const packages=preview?[{
          id:'preview-only',filename:'研判策略更新示例（演示包）.hids-policy',version:'26.11.007-preview',
          title:'研判策略更新示例',summary:'仅用于查看包详情和替换确认的界面，不包含提示词',
          date:'2026-11-06',modules:['告警研判','深度溯源','知识经验'],
          changes:{features:['演示升级包详情展示。'],improvements:['演示上传与应用分离的维护流程。'],fixes:[]},
          uploaded_at:'2026-11-06T08:00:00Z',compatible:true,current:false,applied:false
        }]:await store.list();
        return json(res,200,{...overview,packages,preview,writable:!preview&&role==='updater'&&store.configured});
      }
      if(url.pathname==='/api/maintenance/packages'&&req.method==='POST') {
        if((req.headers['content-type']||'').split(';')[0]!=='application/octet-stream')
          return sendMaintenanceFailure(res,415,'package_media_type');
        let name;try{name=decodeURIComponent(req.headers['x-package-filename']||'');}
        catch{return sendMaintenanceFailure(res,400,'package_name_invalid');}
        const record=await store.stage(await readBody(req),name);
        void auditor({actor:{kind:'user',id:String(access.user||'maint').slice(0,100)},
          action:'maintenance.package.stage',object:{kind:'policy_package',id:record.id,version:record.version,filename:name}});
        return json(res,201,{id:record.id,version:record.version});
      }
      const match=url.pathname.match(/^\/api\/maintenance\/packages\/([0-9a-f]{64})(\/apply)?$/);
      if(match) {
        if(!match[2]&&req.method==='GET')return json(res,200,await store.detail(match[1]));
        if(match[2]&&req.method==='POST') {
          const revision=req.headers['if-match'];
          if(typeof revision!=='string')return sendMaintenanceFailure(res,428,'revision_required');
          const applied=await store.apply(match[1],revision,access.user);
          // 审计（P003-T062）：应用升级包是最高权限写动作；actor 全程可见（publicRelease 不再丢 actor）。
          void auditor({actor:{kind:'user',id:String(access.user||'maint').slice(0,100)},
            action:'maintenance.package.apply',object:{kind:'policy_package',id:match[1],version:applied.version}});
          return json(res,200,applied);
        }
      }
      return sendMaintenanceFailure(res,404,'not_found');
    } catch(cause) {
      // P003-T073：动态 catch 也走统一出口——带 status 的实现错按类归码（4xx=caller_error），意外归 internal_error。
      return sendMaintenanceFailure(res,cause.status||500,maintenanceCodeFor(cause),cause.status?cause.message:null);
    }
  }
}

export async function maintenanceFromEnv(env=process.env,{preview=false}={}) {
  if(!preview&&(!env.HIDS_MAINTENANCE_USER||!env.HIDS_MAINTENANCE_PASSWORD))
    throw new Error('必须设置独立的 HIDS_MAINTENANCE_USER 和 HIDS_MAINTENANCE_PASSWORD');
  const role=env.HIDS_MAINTENANCE_ROLE||'updater';
  if(!['updater','viewer'].includes(role))throw new Error('HIDS_MAINTENANCE_ROLE 只能为 updater 或 viewer');
  const prompts=new PromptStore(env.HIDS_PROMPT_STORE_FILE);
  let encryptionKey=null,publicKey=null;
  if(env.HIDS_UPDATE_KEY_FILE) {
    encryptionKey=await readFile(env.HIDS_UPDATE_KEY_FILE);
    if(encryptionKey.length!==32)throw new Error('HIDS_UPDATE_KEY_FILE 必须是 32 字节二进制密钥');
  }
  if(env.HIDS_UPDATE_PUBLIC_KEY_FILE) {
    publicKey=createPublicKey(await readFile(env.HIDS_UPDATE_PUBLIC_KEY_FILE));
    if(publicKey.asymmetricKeyType!=='ed25519')throw new Error('升级包验签公钥必须为 Ed25519');
  }
  const store=new UpdateStore(prompts,{directory:env.HIDS_UPDATE_STORE_DIR,encryptionKey,publicKey,target:env.HIDS_UPDATE_TARGET});
  return createMaintenanceServer(store,{preview,access:{user:env.HIDS_MAINTENANCE_USER,password:env.HIDS_MAINTENANCE_PASSWORD,role}});
}

// 启动行：一行 JSON 落 stdout（旧的中文文案留在 message 里，部署端照旧 grep 得到）。
// 维护端自己的账号口令与升级包密钥从不进这条日志。
export function logListening({ port, preview, host = '127.0.0.1' }) {
  log('maintenance.listening', { host, port, preview,
    message: `HIDS maintenance${preview ? '（只读预览）' : ''}: http://127.0.0.1:${port}` });
}

if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  const preview=process.argv.includes('--preview');
  const server=await maintenanceFromEnv(process.env,{preview});
  const port=Number(process.env.HIDS_MAINTENANCE_PORT||18081);
  server.listen(port,'127.0.0.1',()=>logListening({port,preview}));
}
