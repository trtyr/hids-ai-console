import http from 'node:http';
import { createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PromptStore } from './prompt-store.js';
import { UpdateStore, PACKAGE_LIMIT } from './update-store.js';

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
  const role=access.role||'updater';
  const authorized=['updater','viewer'].includes(role);
  const loginEnabled=Boolean(access.user&&access.password);
  const recordFailure=key=>{
    const now=Date.now(),state=failures.get(key);
    const count=state&&now-state.at<60000?state.count+1:1;
    failures.set(key,{count,at:now,until:count>=10?now+60000:0});
  };
  return http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy','no-referrer');
    if(!loopback(req.socket.remoteAddress))return json(res,403,{error:'维护服务仅允许本机或 SSH 隧道访问'});
    if(preview&&!loopback(req.socket.localAddress))return json(res,403,{error:'预览仅允许本机监听'});
    let url;try{url=new URL(req.url,'http://localhost');}catch{return json(res,400,{error:'请求地址无效'});}
    if(!url.pathname.startsWith('/api/maintenance/'))return json(res,404,{error:'接口不存在'});
    const token=(req.headers.cookie||'').split(';').map(item=>item.trim()).find(item=>item.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    const session=token?sessions.get(token):null;
    if(session&&session.expires<=Date.now())sessions.delete(token);
    const loggedIn=Boolean(session&&session.expires>Date.now())||authenticated(req,access);
    const previewAccess=preview&&!loginEnabled;
    const key=req.socket.remoteAddress;
    const cookie=(value,age)=>cookieName+'='+value+'; HttpOnly; SameSite=Strict; Path=/; Max-Age='+age+(req.socket.encrypted?'; Secure':'');
    const write=req.method!=='GET'&&req.method!=='HEAD';
    if(write&&!writeAllowed(req))return json(res,403,{error:'维护请求校验失败，拒绝跨站请求'});
    try {
      if(url.pathname==='/api/maintenance/session'&&req.method==='GET')
        return json(res,200,{authenticated:loggedIn,preview,login_enabled:loginEnabled,
          user:loggedIn?access.user:null,role:loggedIn?role:null});
      if(url.pathname==='/api/maintenance/login'&&req.method==='POST') {
        if(!loginEnabled)return json(res,503,{error:preview?'只读预览未配置维护账号，不可登录执行更新':'维护账号尚未配置'});
        if(failures.get(key)?.until>Date.now())return json(res,429,{error:'登录失败过多，请稍后重试'});
        if((req.headers['content-type']||'').split(';')[0]!=='application/json')
          return json(res,415,{error:'登录请求须为 JSON'});
        let data;
        try{data=JSON.parse((await readBody(req,8192)).toString('utf8'));}
        catch(cause){return json(res,cause.status||400,{error:cause.status?cause.message:'登录请求格式不正确'});}
        const correct=data&&typeof data.username==='string'&&typeof data.password==='string'&&
          equal(Buffer.from(data.username),Buffer.from(access.user))&&equal(Buffer.from(data.password),Buffer.from(access.password));
        if(!correct){recordFailure(key);return json(res,401,{error:'账号或密码错误'});}
        if(!authorized)return json(res,403,{error:'该账号没有后台访问权限'});
        failures.delete(key);
        for(const [id,value]of sessions)if(value.expires<=Date.now())sessions.delete(id);
        if(token)sessions.delete(token);
        if(sessions.size>=100)sessions.delete(sessions.keys().next().value);
        const id=randomBytes(32).toString('hex');
        sessions.set(id,{expires:Date.now()+sessionDuration});
        res.setHeader('Set-Cookie',cookie(id,sessionDuration/1000));
        return json(res,200,{user:access.user,role});
      }
      if(!previewAccess) {
        if(!loggedIn) {
          if(failures.get(key)?.until>Date.now())return json(res,429,{error:'登录失败过多，请稍后重试'});
          recordFailure(key);
          return json(res,401,{error:'请使用独立维护账号登录'});
        }
        if(!authorized)return json(res,403,{error:'该账号没有后台访问权限'});
      }
      if(url.pathname==='/api/maintenance/logout'&&req.method==='POST') {
        if(token)sessions.delete(token);
        res.setHeader('Set-Cookie',cookie('',0));
        return json(res,200,{logged_out:true});
      }
      if(write) {
        if(preview)return json(res,403,{error:'本地只读预览不允许上传或替换'});
        if(role!=='updater')return json(res,403,{error:'当前账号没有产品更新权限'});
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
          return json(res,415,{error:'仅接受加密策略包文件'});
        let name;try{name=decodeURIComponent(req.headers['x-package-filename']||'');}
        catch{return json(res,400,{error:'升级包名称编码无效'});}
        const record=await store.stage(await readBody(req),name);
        return json(res,201,{id:record.id,version:record.version});
      }
      const match=url.pathname.match(/^\/api\/maintenance\/packages\/([0-9a-f]{64})(\/apply)?$/);
      if(match) {
        if(!match[2]&&req.method==='GET')return json(res,200,await store.detail(match[1]));
        if(match[2]&&req.method==='POST') {
          const revision=req.headers['if-match'];
          if(typeof revision!=='string')return json(res,428,{error:'请先刷新版本后确认替换'});
          return json(res,200,await store.apply(match[1],revision,access.user));
        }
      }
      return json(res,404,{error:'接口或文件不存在'});
    } catch(cause) {
      return json(res,cause.status||500,{error:cause.status?cause.message:'维护服务处理失败，请检查后端记录'});
    }
  });
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

if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  const preview=process.argv.includes('--preview');
  const server=await maintenanceFromEnv(process.env,{preview});
  const port=Number(process.env.HIDS_MAINTENANCE_PORT||18081);
  server.listen(port,'127.0.0.1',()=>console.log('HIDS maintenance'+(preview?'（只读预览）':'')+': http://127.0.0.1:'+port));
}
