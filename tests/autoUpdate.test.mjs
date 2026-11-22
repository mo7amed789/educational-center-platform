import { describe, it, expect } from 'vitest';
import { createUpdater, sqlitePath, updateInterval } from '../scripts/update-core.mjs';
const old='a'.repeat(40), next='b'.repeat(40);
function fixture(fail) {
  let head=old, status=[], calls=[], failed=false;
  const step=async(name,args)=>{calls.push([name,args]);if(fail===name&&!failed){failed=true;throw Error('simulated');}};
  const io={
    git:async args=>{await step('git:'+args[0],args);if(args[0]==='remote')return 'https://github.com/mo7amed789/educational-center-platform.git';if(args[0]==='branch')return 'main';if(args[0]==='status')return '';if(args[0]==='rev-parse')return args[1]==='HEAD'?head:next;if(args[0]==='merge')head=next;if(args[0]==='switch')head=old;return '';},
    npm:async args=>step('npm:'+args.join(' '),args),status:async data=>{status.push(data);},
    stop:async()=>step('stop'),start:async()=>step('start'),health:async()=>step('health'),backup:async()=>{await step('backup');return '/retained-backup.db';},restore:async file=>step('restore',file),
  };
  return {io,status,calls,head:()=>head};
}
describe('managed updater safety order',()=>{
  it('backs up before advancing, never accepts data loss, and verifies restart',async()=>{const f=fixture();expect((await createUpdater(f.io)()).state).toBe('updated');expect(f.head()).toBe(next);const names=f.calls.map(x=>x[0]);expect(names.indexOf('backup')).toBeLessThan(names.indexOf('git:merge'));expect(names).toContain('npm:exec -- prisma db push --skip-generate');expect(JSON.stringify(f.calls)).not.toMatch(/accept-data-loss|force-reset|reset|clean/);expect(f.status.at(-1).state).toBe('updated');expect(names.at(-1)).toBe('health');});
  it.each(['npm:ci','npm:run db:generate','npm:exec -- prisma db push --skip-generate','npm:run build','start','health'])('restores previous code and database after %s failure',async failure=>{const f=fixture(failure);expect((await createUpdater(f.io)()).state).toBe('rolled_back');expect(f.head()).toBe(old);expect(f.calls.some(x=>x[0]==='restore')).toBe(true);expect(f.status.at(-1)).toMatchObject({enabled:false,state:'rolled_back',currentCommit:old});});
  it('does not advance if backup fails and restarts the unchanged version',async()=>{const f=fixture('backup');expect((await createUpdater(f.io)()).state).toBe('rolled_back');expect(f.head()).toBe(old);expect(f.calls.some(x=>x[0]==='git:merge')).toBe(false);expect(f.calls.some(x=>x[0]==='restore')).toBe(false);});
  it('never reports successful rollback when restoration fails',async()=>{const f=fixture('npm:ci');f.io.restore=async()=>{throw Error('disk');};expect((await createUpdater(f.io)()).state).toBe('manual_recovery');expect(f.status.at(-1).enabled).toBe(false);});
  it.each(['origin','branch','dirty','diverged'])('blocks %s without stopping the app or touching its database',async kind=>{const f=fixture(),git=f.io.git;f.io.git=async args=>{if(kind==='origin'&&args[0]==='remote')return 'https://example.com/other.git';if(kind==='branch'&&args[0]==='branch')return 'feature/work';if(kind==='dirty'&&args[0]==='status')return ' M src/server.ts';if(kind==='diverged'&&args[0]==='merge-base')throw Error('not ancestor');return git(args);};expect((await createUpdater(f.io)()).state).toBe('blocked');expect(f.calls.some(x=>x[0]==='stop'||x[0]==='backup')).toBe(false);});
  it('rejects local edits introduced during backup without overwriting them',async()=>{const f=fixture();let checks=0;const git=f.io.git;f.io.git=async args=>args[0]==='status'&&++checks>1?' M user-file':git(args);await createUpdater(f.io)();expect(f.calls.some(x=>x[0]==='git:merge'||x[0]==='git:switch')).toBe(false);});
  it('does nothing when already current',async()=>{const f=fixture(),git=f.io.git;f.io.git=async args=>args[0]==='rev-parse'?old:git(args);expect((await createUpdater(f.io)()).state).toBe('up_to_date');expect(f.calls.some(x=>x[0]==='stop')).toBe(false);});
  it('rejects remote or ambiguous database URLs and unsafe intervals',()=>{for(const url of ['postgres://db','file::memory:','file:db?mode=ro',''])expect(()=>sqlitePath('/app',url)).toThrow();expect(sqlitePath('/app','file:./dev.db')).toBe('/app/prisma/dev.db');expect(updateInterval()).toBe(3600000);for(const n of ['0','-1','0.5','text'])expect(()=>updateInterval(n)).toThrow();});
});
