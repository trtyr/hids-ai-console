import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('maintenance CLI starts when the deployment current path is a symlink',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'hids-maintenance-startup-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  await symlink(root,path.join(directory,'current'),'dir');
  const child=spawn(process.execPath,[path.join(directory,'current/backend/maintenance-server.js'),'--preview'],{
    env:{PATH:process.env.PATH,HOME:directory,HIDS_MAINTENANCE_PORT:'0'},stdio:['ignore','pipe','pipe']
  });
  const exited=new Promise(resolve=>child.once('exit',resolve));
  let output='',errors='';
  child.stderr.on('data',chunk=>{errors+=chunk;});
  try{
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('维护服务未就绪：'+errors)),5000);
      child.stdout.on('data',chunk=>{
        output+=chunk;
        if(output.includes('HIDS maintenance')){clearTimeout(timeout);resolve();}
      });
      child.once('error',error=>{clearTimeout(timeout);reject(error);});
      child.once('exit',code=>{clearTimeout(timeout);reject(new Error('维护服务提前退出：'+code+' '+errors));});
    });
    assert.match(output,/只读预览/);
    assert.equal(child.exitCode,null);
  }finally{
    if(child.exitCode===null)child.kill('SIGTERM');
    await exited;
  }
});
