# Safe local GitHub updates

This is an opt-in managed launcher for a Windows/macOS/Linux local SQLite installation. It is not a production deployment system and does not update Pharmacy-App. Only the official `mo7amed789/educational-center-platform` repository's `main` branch is accepted.

## One-time setup

Use Node.js 22 and Git on PATH. Keep the existing `.env` and actual database. Stop `npm run dev` or any older server before using the launcher. Only this one managed process may write to this SQLite database. Shared databases, multiple app servers, production and remote databases are not supported by this updater.

After reviewing and merging this PR, back up the actual database, pull the reviewed main normally, then:

```powershell
npm ci
npm run db:generate
npm run build
```

Set these values in the existing `.env`:

```dotenv
AUTO_UPDATE_ENABLED=true
AUTO_UPDATE_INTERVAL_MINUTES=60
```

Then start with:

```powershell
npm run start:managed
```

The launcher reads `.env` without replacing existing environment variables. `DATABASE_URL=file:./dev.db` resolves to `prisma/dev.db`, as with Prisma's schema. Absolute SQLite file paths are accepted. URLs with query/fragment parameters are refused rather than guessed.

Automatic application is disabled by default. To disable it, set `AUTO_UPDATE_ENABLED=false` and restart the launcher. Ordinary `npm run dev` and `npm start` do not self-update. The first enabled check runs after startup readiness, then hourly by default. The interval supports 15 minutes to 7 days.

## Safety sequence

1. Verify the official origin, the checked-out `main` branch, a clean tracked/untracked worktree and a fast-forward ancestry. Feature branches, divergence and local edits block application without stopping the current server.
2. Stop the managed server. Make a consistent SQLite `VACUUM INTO` backup in Git's private updater directory. No update is applied if backup fails. Recheck local edits before checkout.
3. Fast-forward to the exact fetched commit, never merge another branch or overwrite local edits. Run `npm ci`, `npm run db:generate`, non-interactive `prisma db push --skip-generate`, then build. No `--accept-data-loss`, reset, seed or force-reset is used. A destructive-change warning fails the schema step.
4. Restart and verify database readiness from this exact child process using a per-start identifier. An unrelated process on the same port cannot satisfy readiness.
5. On failure after stopping, stop the candidate server, switch to the old commit, restore its database backup, reinstall/generate/build the old version, restart and verify it. Rollback uses detached HEAD deliberately; automatic updates remain disabled until the operator reviews the failure and safely returns to main. There is no hard reset or clean.

If rollback itself fails, the launcher tries to stop the server, retains the backup and shows manual recovery. Verify that no server remains running before manual recovery. It never calls that a successful update or successful rollback. Do not delete backups or blindly re-enable. Check the failing step in the launcher console, retain `.env`, and ask for recovery help. Backups contain private student data and must stay local. They are never committed or uploaded. Keep sufficient disk space; backups are retained, not silently deleted.

Use Ctrl+C for shutdown. During an update the launcher finishes the current update/rollback transaction before shutdown. Do not terminate the computer or kill the process mid-update. Abrupt machine failure, power loss, disk failure and another writer are outside automatic recovery guarantees. A stale lock is only removed automatically when its recorded process no longer exists; PID ambiguity is left for manual review.

## Owner status

The owner sees update status, current commit, last/next check and any failing step under account/security settings. "تحديث الحالة" reads status only; it does not force an update or grant permission. Other roles receive HTTP 403 even with custom permissions. No paths, raw install output or secrets are returned. Refresh the page after the brief update downtime. A failed status read is reported as unavailable, not success.

## Validation and limits

175 checks pass on this main-based branch, including 18 new updater/order/rollback/access checks. A disposable SQLite `VACUUM INTO` backup was reopened and verified. The actual managed launcher and owner UI are exercised using a disposable database. No live user database or installation is changed. Windows-specific shell quoting is avoided by invoking the Node npm CLI with argument arrays, but native Windows execution still needs confirmation on the target laptop. Production migration/deployment policy remains separate.
