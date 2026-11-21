// 全局根隔离（P003-T050 A2）：必须是本文件第一个 import——它要在 server.js / wiki-store.js 求值前
// 把 HIDS_DATA_DIR 指到本进程的临时根；否则缺省库指着真全局根（wiki/rules 读→种子，fp-sessions 写）。
import { assertIsolatedRoot } from './evidence/test/P003-T034/isolate-data-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PromptStore } from './src/contexts/knowledge/infrastructure/prompt-store.js';
import { UpdateStore, sealPackage } from './src/contexts/dataops/infrastructure/update-store.js';
import { createMaintenanceServer } from './src/interfaces/http/maintenance/server.js';
import { createServer } from './server.js';

async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hids-policy-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prompts = new PromptStore(path.join(directory, 'prompts.json'));
  const {privateKey,publicKey} = generateKeyPairSync('ed25519');
  const encryptionKey = randomBytes(32);
  const options = {directory:path.join(directory,'packages'),encryptionKey,publicKey,target:'test-customer'};
  const store = new UpdateStore(prompts, options);
  const snapshot = await prompts.snapshot();
  const makePayload = (extra={}) => ({type:'hids-prompts',api_version:1,target:'test-customer',
    version:'26.11.007',sequence:1,date:'2026-11-06',title:'策略更新',summary:'更新研判策略的公开说明',
    changes:{features:['加入维护版本管理'],improvements:[],fixes:['修正判据调用适配']},
    ...snapshot,sections:{...snapshot.sections,triage:'不可回显的提示词-PRIVATE-CANARY'},...extra});
  return {directory,prompts,store,options,makePayload,seal:p=>sealPackage(p,{privateKey,encryptionKey})};
}
async function listen(t,server) {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return 'http://127.0.0.1:'+server.address().port;
}
const auth = {Authorization:'Basic '+Buffer.from('maintainer:test-maintenance-secret').toString('base64')};
const writeHeaders = {...auth,'X-Hids-Maintenance':'1','Content-Type':'application/octet-stream','X-Package-Filename':'update.hids-policy'};
const privateText = /PRIVATE-CANARY|ciphertext|sections|evidence_id/;

// 隔离自证（P003-T050 A5 的牙）：删掉文件头那行 import，这条立刻红。
test('全局根隔离（P003-T050 A2）：本文件的数据根是临时根，不是真实全局根', () => assertIsolatedRoot());

test('customer has version metadata only and legacy prompt upload is closed',async t=>{
  const {prompts}=await setup(t);
  const base=await listen(t,createServer(null,null,null,null,prompts,null,null,{},null,'old-token'));
  const overview=await fetch(base+'/api/updates');
  assert.equal(overview.status,200);
  const body=await overview.text();
  assert.doesNotMatch(body,/合并后的执行口径|sections|prompts|判定程序/);
  assert.equal(JSON.parse(body).modules.length,3);
  assert.equal((await fetch(base+'/api/maintenance/overview')).status,404);
  assert.equal((await fetch(base+'/maintenance.html')).status,404);
  assert.equal((await fetch(base+'/backend/prompts/triage.md')).status,404);
  assert.equal((await fetch(base+'/api/agent/prompts/upload',{method:'POST',headers:{'X-Prompt-Admin-Token':'old-token'},body:'明文'})).status,410);
});

test('maintenance login is independent; upload stages before explicit apply without returning plaintext',async t=>{
  const env=await setup(t);
  const initial=await env.prompts.load();
  const base=await listen(t,createMaintenanceServer(env.store,{access:{user:'maintainer',password:'test-maintenance-secret'}}));
  assert.equal((await fetch(base+'/')).status,404);
  assert.equal((await fetch(base+'/api/maintenance/overview',{headers:{Authorization:'Basic '+Buffer.from('operator:customer-password').toString('base64')}})).status,401);
  assert.equal((await fetch(base+'/',{headers:auth})).status,404);
  const buffer=env.seal(env.makePayload());
  assert(!buffer.includes(Buffer.from('PRIVATE-CANARY')));
  const denied=await fetch(base+'/api/maintenance/packages',{method:'POST',headers:{...writeHeaders,'Sec-Fetch-Site':'cross-site'},body:buffer});
  assert.equal(denied.status,403);
  assert.equal((await fetch(base+'/api/maintenance/packages',{method:'POST',headers:{...writeHeaders,'X-Hids-Maintenance':''},body:buffer})).status,403);
  const response=await fetch(base+'/api/maintenance/packages',{method:'POST',headers:writeHeaders,body:buffer});
  assert.equal(response.status,201);
  const staged=await response.json();
  assert.equal((await env.prompts.load()).revision,initial.revision);
  const detail=await (await fetch(base+'/api/maintenance/packages/'+staged.id,{headers:auth})).text();
  assert.doesNotMatch(detail,privateText);
  assert.equal(JSON.parse(detail).applied,false);
  const route=base+'/api/maintenance/packages/'+staged.id+'/apply';
  assert.equal((await fetch(route,{method:'POST',headers:{...auth,'X-Hids-Maintenance':'1'}})).status,428);
  assert.equal((await fetch(route,{method:'POST',headers:{...auth,'X-Hids-Maintenance':'1','If-Match':'stale'}})).status,409);
  assert.equal((await env.prompts.load()).revision,initial.revision);
  const applied=await fetch(route,{method:'POST',headers:{...auth,'X-Hids-Maintenance':'1','If-Match':initial.revision}});
  assert.equal(applied.status,200);
  const installed=await new PromptStore(env.prompts.filename).load();
  assert.equal(installed.version,'26.11.007');
  assert.match(installed.prompts.triage,/PRIVATE-CANARY/);
  const overviewText=await (await fetch(base+'/api/maintenance/overview',{headers:auth})).text();
  assert.doesNotMatch(overviewText,privateText);
  assert.equal(JSON.parse(overviewText).history.length,2);
  assert.equal((await fetch(route,{method:'POST',headers:{...auth,'X-Hids-Maintenance':'1','If-Match':installed.revision}})).status,409);
});

test('tampered, wrong-customer, incomplete and knowledge-incompatible packages never stage',async t=>{
  const env=await setup(t);
  const initial=(await env.prompts.load()).revision;
  const tampered=JSON.parse(env.seal(env.makePayload()));
  tampered.ciphertext='AAAA'+tampered.ciphertext.slice(4);
  await assert.rejects(env.store.stage(Buffer.from(JSON.stringify(tampered)),'bad.hids-policy'),/签名/);
  await assert.rejects(env.store.stage(Buffer.from('plain prompt'),'bad.hids-policy'),/格式/);
  await assert.rejects(env.store.stage(env.seal(env.makePayload({target:'another-customer'})),'bad.hids-policy'),/客户/);
  await assert.rejects(env.store.stage(env.seal(env.makePayload({sections:{triage:'x'}})),'bad.hids-policy'),/章节/);
  await assert.rejects(env.store.stage(env.seal(env.makePayload({knowledge_revision:'wrong'})),'bad.hids-policy'),/知识库/);
  await assert.rejects(env.store.stage(env.seal(env.makePayload()),'../bad.hids-policy'),/请选择/);
  assert.equal((await env.prompts.load()).revision,initial);
  assert.deepEqual(await env.store.list(),[]);
});

test('apply rechecks compatibility and monotonic release sequence; encrypted package survives restart',async t=>{
  const env=await setup(t);
  const first=await env.store.stage(env.seal(env.makePayload()),'first.hids-policy');
  const old=await env.store.stage(env.seal(env.makePayload({version:'26.11.008',sequence:1})),'old.hids-policy');
  const third=await env.store.stage(env.seal(env.makePayload({version:'26.11.009',sequence:3})),'third.hids-policy');
  const source=await readFile(path.join(env.options.directory,first.id+'.json'),'utf8');
  assert.doesNotMatch(source,/PRIVATE-CANARY/);
  const restored=new UpdateStore(new PromptStore(env.prompts.filename),env.options);
  await restored.apply(first.id,(await env.prompts.load()).revision,'maintainer');
  await assert.rejects(restored.apply(old.id,(await env.prompts.load()).revision,'maintainer'),/降级/);
  const data=await env.prompts.readOverrides();
  data.triage='本地维护期间变化';
  await writeFile(env.prompts.filename,JSON.stringify(data));
  const revision=(await env.prompts.load()).revision;
  await restored.apply(third.id,revision,'maintainer');
  assert.equal((await env.prompts.load()).version,'26.11.009');
});

test('preview is read-only and no credentials or update keys are required',async t=>{
  const {store,prompts}=await setup(t);
  const base=await listen(t,createMaintenanceServer(store,{preview:true}));
  const response=await (await fetch(base+'/api/maintenance/overview')).json();
  assert.equal(response.preview,true);
  assert.equal(response.writable,false);
  assert.match(response.packages[0].filename,/演示包/);
  const before=(await prompts.load()).revision;
  assert.equal((await fetch(base+'/api/maintenance/packages',{method:'POST',body:'x'})).status,403);
  assert.equal((await prompts.load()).revision,before);
});
