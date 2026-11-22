import path from 'node:path';

export const OFFICIAL_ORIGINS = new Set(['https://github.com/mo7amed789/educational-center-platform.git', 'https://github.com/mo7amed789/educational-center-platform', 'git@github.com:mo7amed789/educational-center-platform.git']);
export function sqlitePath(root, url) {
  if (!url?.startsWith('file:') || url.includes('?') || url.includes('#')) throw new Error('LOCAL_SQLITE_REQUIRED');
  const value = decodeURIComponent(url.slice(5));
  if (!value || value === ':memory:') throw new Error('LOCAL_SQLITE_REQUIRED');
  return path.isAbsolute(value) ? value : path.resolve(root, 'prisma', value);
}
export function updateInterval(value) {
  const n = Number(value || 60);
  if (!Number.isInteger(n) || n < 15 || n > 10080) throw new Error('INVALID_UPDATE_INTERVAL');
  return n * 60000;
}
const sha = value => /^[a-f0-9]{40}$/.test(value);

// Effects are injected so the safety sequence and every failure can be tested offline.
export function createUpdater(io) {
  let busy = false;
  return async function check() {
    if (busy) return { state: 'busy' };
    busy = true;
    let old, target, backup, stopped = false, advanced = false, stage = 'checking';
    const state = value => io.status({ enabled: true, checkedAt: new Date().toISOString(), ...value });
    try {
      await state({ state: 'checking' });
      if (!OFFICIAL_ORIGINS.has((await io.git(['remote', 'get-url', 'origin'])).trim())) throw new Error('OFFICIAL_ORIGIN_REQUIRED');
      if ((await io.git(['branch', '--show-current'])).trim() !== 'main') throw new Error('MAIN_BRANCH_REQUIRED');
      if ((await io.git(['status', '--porcelain', '--untracked-files=normal'])).trim()) throw new Error('CLEAN_WORKTREE_REQUIRED');
      old = (await io.git(['rev-parse', 'HEAD'])).trim();
      if (!sha(old)) throw new Error('INVALID_COMMIT');
      await io.git(['fetch', '--no-tags', 'origin', 'main']);
      target = (await io.git(['rev-parse', 'FETCH_HEAD'])).trim();
      if (!sha(target)) throw new Error('INVALID_COMMIT');
      if (old === target) { await state({ state: 'up_to_date', currentCommit: old }); return { state: 'up_to_date' }; }
      await io.git(['merge-base', '--is-ancestor', old, target]);
      stage = 'backup'; await state({ state: 'backing_up', currentCommit: old, availableCommit: target });
      stopped = true; await io.stop();
      backup = await io.backup();
      // A local edit during fetch/backup must never be overwritten.
      if ((await io.git(['status', '--porcelain', '--untracked-files=normal'])).trim()) throw new Error('CLEAN_WORKTREE_REQUIRED');
      stage = 'checkout'; await io.git(['merge', '--ff-only', target]); advanced = true;
      if ((await io.git(['rev-parse', 'HEAD'])).trim() !== target) throw new Error('TARGET_CHANGED');
      stage = 'install'; await state({ state: 'installing', currentCommit: old, availableCommit: target });
      await io.npm(['ci']);
      await io.npm(['run', 'db:generate']);
      stage = 'schema'; await state({ state: 'applying_schema', currentCommit: old, availableCommit: target });
      // Non-interactive db push refuses data-loss warnings. Never add accept-data-loss/force-reset.
      await io.npm(['exec', '--', 'prisma', 'db', 'push', '--skip-generate']);
      stage = 'build'; await io.npm(['run', 'build']);
      stage = 'restart'; await state({ state: 'restarting', currentCommit: target });
      await io.start(); await io.health(); stopped = false;
      await state({ state: 'updated', currentCommit: target, updatedAt: new Date().toISOString() });
      return { state: 'updated' };
    } catch (error) {
      if (!stopped && !advanced) {
        await state({ state: 'blocked', currentCommit: old, failureStage: stage, message: ['OFFICIAL_ORIGIN_REQUIRED', 'MAIN_BRANCH_REQUIRED', 'CLEAN_WORKTREE_REQUIRED', 'INVALID_COMMIT'].includes(error.message) ? error.message : 'UPDATE_CHECK_FAILED' });
        return { state: 'blocked' };
      }
      if (stopped && old) {
        try { advanced = advanced || (await io.git(['rev-parse', 'HEAD'])).trim() !== old; }
        catch { await io.stop().catch(() => {}); await state({ state: 'manual_recovery', enabled: false, failureStage: stage, message: 'COMMIT_STATE_UNVERIFIED' }); return { state: 'manual_recovery' }; }
      }
      await state({ state: 'rolling_back', currentCommit: old, failureStage: stage }).catch(() => {});
      try {
        await io.stop();
        // Switch refuses conflicting local edits. No reset --hard and no git clean.
        if (advanced) await io.git(['switch', '--detach', old]);
        if (backup) await io.restore(backup);
        if (advanced) { await io.npm(['ci']); await io.npm(['run', 'db:generate']); await io.npm(['run', 'build']); }
        await io.start(); await io.health();
        await state({ state: 'rolled_back', enabled: false, currentCommit: old, failureStage: stage, message: 'UPDATE_ROLLED_BACK_REVIEW_REQUIRED' }).catch(() => {});
        return { state: 'rolled_back' };
      } catch {
        await io.stop().catch(() => {});
        await state({ state: 'manual_recovery', enabled: false, currentCommit: old, failureStage: stage, message: 'SERVER_STOPPED_BACKUP_RETAINED' }).catch(() => {});
        return { state: 'manual_recovery' };
      }
    } finally { busy = false; }
  };
                      }
