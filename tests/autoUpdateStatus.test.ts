import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/server.js';
import { prisma } from '../src/prisma.js';

describe('owner-only managed update status',()=>{
 const app=buildApp();let directory:string|undefined;
 afterAll(async()=>{delete process.env.EDU_MANAGED_STATE;await app.close();await prisma.$disconnect();if(directory)await rm(directory,{recursive:true,force:true});});
 async function session(role:'CENTER_OWNER'|'TEACHER'){
  const center=await prisma.center.create({data:{slug:'updater-'+role,name:'Updater fixture'}});
  const user=await prisma.user.create({data:{name:'Update fixture',email:role+'@updates.test',passwordHash:'not-a-login',centerId:center.id,role}});
  const token='updater-session-'+role;await prisma.session.create({data:{id:createHash('sha256').update(token).digest('hex'),userId:user.id,centerId:center.id,expiresAt:new Date(Date.now()+3600000)}});return 'center_session='+token;
 }
 it('requires an authenticated owner and does not promote custom staff permissions',async()=>{expect((await app.inject({url:'/api/center/system/update-status'})).statusCode).toBe(401);expect((await app.inject({url:'/api/center/system/update-status',headers:{cookie:await session('TEACHER')}})).statusCode).toBe(403);});
 it('reports unmanaged mode honestly, then strips paths and raw command output from managed state',async()=>{
  const cookie=await session('CENTER_OWNER');delete process.env.EDU_MANAGED_STATE;
  expect((await app.inject({url:'/api/center/system/update-status',headers:{cookie}})).json()).toEqual({enabled:false,state:'disabled',managed:false});
  directory=await mkdtemp(path.join(tmpdir(),'updater-status-'));process.env.EDU_MANAGED_STATE=path.join(directory,'state.json');
  await writeFile(process.env.EDU_MANAGED_STATE,JSON.stringify({enabled:false,state:'rolled_back',currentCommit:'a'.repeat(40),failureStage:'schema',privatePath:'do-not-share',message:'raw-command-output'}));
  const res=await app.inject({url:'/api/center/system/update-status',headers:{cookie}});expect(res.statusCode).toBe(200);expect(res.json()).toMatchObject({state:'rolled_back',managed:true,enabled:false});expect(res.body).not.toMatch(/do-not-share|raw-command-output/);
  await writeFile(process.env.EDU_MANAGED_STATE,'invalid');expect((await app.inject({url:'/api/center/system/update-status',headers:{cookie}})).statusCode).toBe(503);
 });
});
