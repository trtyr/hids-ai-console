import test from 'node:test';
import assert from 'node:assert/strict';
import { createMaintenanceServer } from './maintenance-server.js';
import { PromptStore } from './prompt-store.js';
import { UpdateStore } from './update-store.js';

async function listen(t,server) {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return 'http://127.0.0.1:'+server.address().port;
}
const access={user:'test-maintainer',password:'test-only-maintenance-password'};
const login=(base,extra={},headers={})=>fetch(base+'/api/maintenance/login',{method:'POST',
  headers:{'Content-Type':'application/json','X-Hids-Maintenance':'1',...headers},
  body:JSON.stringify({username:access.user,password:access.password,...extra})});
const store=()=>new UpdateStore(new PromptStore());
const cookieOf=response=>response.headers.get('set-cookie').split(';')[0];

test('login issues an HttpOnly session; logout revokes it and rejects cross-site requests',async t=>{
  const base=await listen(t,createMaintenanceServer(store(),{access}));
  assert.equal((await fetch(base+'/login')).status,404);
  const unauthenticated=await fetch(base+'/api/maintenance/overview');
  assert.equal(unauthenticated.status,401);
  assert.equal(unauthenticated.headers.get('www-authenticate'),null);
  assert.equal((await login(base,{}, {Origin:'https://another-site.invalid'})).status,403);
  assert.equal((await login(base,{}, {'X-Hids-Maintenance':''})).status,403);
  assert.equal((await login(base,{password:'wrong'})).status,401);
  const response=await login(base,{role:'updater'});
  assert.equal(response.status,200);
  assert.match(response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  const text=await response.text();
  assert(!text.includes(access.password));
  assert(!text.includes('hids_maintenance_session'));
  const Cookie=cookieOf(response);
  assert.equal((await fetch(base+'/api/maintenance/overview',{headers:{Cookie}})).status,200);
  assert.equal((await fetch(base+'/api/maintenance/logout',{method:'POST',headers:{Cookie}})).status,403);
  assert.equal((await fetch(base+'/api/maintenance/logout',{method:'POST',headers:{Cookie,'X-Hids-Maintenance':'1'}})).status,200);
  assert.equal((await fetch(base+'/api/maintenance/overview',{headers:{Cookie}})).status,401);
});

test('viewer can log in but cannot upload or apply even by forging its client role',async t=>{
  const base=await listen(t,createMaintenanceServer(store(),{access:{...access,role:'viewer'}}));
  const response=await login(base,{role:'updater'});
  assert.equal(response.status,200);
  assert.equal((await response.clone().json()).role,'viewer');
  const Cookie=cookieOf(response);
  const overview=await (await fetch(base+'/api/maintenance/overview',{headers:{Cookie}})).json();
  assert.equal(overview.writable,false);
  const headers={Cookie,'X-Hids-Maintenance':'1','Content-Type':'application/octet-stream'};
  assert.equal((await fetch(base+'/api/maintenance/packages',{method:'POST',headers,body:'untrusted'})).status,403);
  assert.equal((await fetch(base+'/api/maintenance/packages/'+ 'a'.repeat(64)+'/apply',{method:'POST',headers})).status,403);
  const unauthorized=await listen(t,createMaintenanceServer(store(),{access:{...access,role:'customer'}}));
  assert.equal((await login(unauthorized)).status,403);
});

test('expired and fabricated session cookies do not authorize maintenance',async t=>{
  let now=Date.now();
  t.mock.method(Date,'now',()=>now);
  const base=await listen(t,createMaintenanceServer(store(),{access}));
  const Cookie=cookieOf(await login(base));
  now+=8*60*60*1000+1;
  assert.equal((await fetch(base+'/api/maintenance/overview',{headers:{Cookie}})).status,401);
  assert.equal((await fetch(base+'/api/maintenance/overview',{headers:{Cookie:'hids_maintenance_session=forged'}})).status,401);
});

test('login failures are rate limited; read-only preview never grants a write session',async t=>{
  const base=await listen(t,createMaintenanceServer(store(),{access}));
  for(let i=0;i<10;i++)assert.equal((await login(base,{password:'wrong'})).status,401);
  assert.equal((await login(base)).status,429);
  const preview=await listen(t,createMaintenanceServer(store(),{preview:true}));
  const state=await (await fetch(preview+'/api/maintenance/session')).json();
  assert.equal(state.login_enabled,false);
  assert.equal(state.authenticated,false);
  assert.equal((await login(preview)).status,503);
  assert.equal((await fetch(preview+'/api/maintenance/packages',{method:'POST',headers:{'X-Hids-Maintenance':'1'},body:'x'})).status,403);
});

