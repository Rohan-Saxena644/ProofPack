import path from 'node:path';
import { constants, createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../db/store';
import type { ArtifactRecord } from '../core/contracts';
import { contained, evidencePath, isWithin } from './paths';

const day = 86400000;
const terminal = ['passed', 'failed', 'blocked', 'interrupted', 'cancelled'];
export function retentionPolicy(store: Store) {
  const c = store.config;
  return {
    enabled: c.RETENTION_DAYS > 0,
    archiveAfterDays: c.RETENTION_DAYS,
    keepNewestRuns: c.RETENTION_KEEP_RUNS,
    expireArchiveAfterDays: c.ARCHIVE_RETENTION_DAYS,
    batchSize: 20,
  };
}
function validateRoots(store: Store) {
  const a = store.config.artifactDir,
    b = store.config.archiveDir;
  if (path.relative(a, b) === '' || isWithin(a, b) || isWithin(b, a))
    throw new Error(
      'Working evidence and archive directories must be separate and must not contain each other.',
    );
}
function artifacts(store: Store, runId: string) {
  return store.sqlite
    .prepare(
      'SELECT t.* FROM artifacts t JOIN attempts a ON a.id=t.attemptId LEFT JOIN archived_artifacts aa ON aa.artifactId=t.id WHERE a.runId=? AND aa.artifactId IS NULL ORDER BY t.rowid',
    )
    .all(runId) as ArtifactRecord[];
}
export async function previewRetention(store: Store, now = Date.now()) {
  validateRoots(store);
  const policy = retentionPolicy(store);
  const archive = policy.enabled
    ? (store.sqlite
        .prepare(
          `SELECT r.id,r.brief,r.status,r.updatedAt FROM runs r WHERE r.status IN ('passed','failed','blocked','interrupted','cancelled') AND r.updatedAt<? AND r.id NOT IN (SELECT id FROM runs ORDER BY createdAt DESC LIMIT ?) AND EXISTS (SELECT 1 FROM artifacts t JOIN attempts a ON a.id=t.attemptId LEFT JOIN archived_artifacts aa ON aa.artifactId=t.id WHERE a.runId=r.id AND aa.artifactId IS NULL) ORDER BY r.updatedAt LIMIT 20`,
        )
        .all(now - policy.archiveAfterDays * day, policy.keepNewestRuns) as {
        id: string;
        brief: string;
        status: string;
        updatedAt: number;
      }[])
    : [];
  const purge =
    policy.enabled && policy.expireArchiveAfterDays > 0
      ? (store.sqlite
          .prepare(
            `SELECT ar.id,ar.runId,ar.bytes,ar.createdAt,ar.state FROM evidence_archives ar JOIN runs r ON r.id=ar.runId WHERE ar.state IN ('ready','purging') AND ar.createdAt<? AND r.status IN ('passed','failed','blocked','interrupted','cancelled') AND r.id NOT IN (SELECT id FROM runs ORDER BY createdAt DESC LIMIT ?) ORDER BY ar.createdAt LIMIT 20`,
          )
          .all(now - policy.expireArchiveAfterDays * day, policy.keepNewestRuns) as {
          id: string;
          runId: string;
          bytes: number;
          createdAt: number;
          state: string;
        }[])
      : [];
  const candidates = [];
  for (const run of archive) {
    const files = artifacts(store, run.id);
    let bytes = 0,
      missingFiles = 0;
    for (const file of files) {
      try {
        bytes += (await lstat(evidencePath(file, store.config.artifactDir))).size;
      } catch {
        missingFiles++;
      }
    }
    candidates.push({
      ...run,
      artifactIds: files.map((f) => f.id),
      artifactCount: files.length,
      bytes,
      missingFiles,
    });
  }
  const token = createHash('sha256')
    .update(JSON.stringify({ policy, archive: candidates, purge }))
    .digest('hex');
  return {
    policy,
    token,
    archive: candidates,
    purge,
    archiveBytes: candidates.reduce((n, r) => n + r.bytes, 0),
    purgeBytes: purge.reduce((n, r) => n + r.bytes, 0),
  };
}
async function hash(file: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function regular(file: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Evidence must be a regular file.');
  return stat;
}
function lock(store: Store, runId: string, owner: string) {
  store.sqlite
    .transaction(() => {
      const run = store.get(runId);
      if (!run || !terminal.includes(run.status))
        throw new Error('Run became active; refresh the retention preview.');
      const current = store.sqlite
        .prepare('SELECT leaseUntil FROM maintenance_locks WHERE runId=?')
        .get(runId) as { leaseUntil: number } | undefined;
      if (current && current.leaseUntil > Date.now())
        throw new Error('Another worker is maintaining this evidence.');
      store.sqlite
        .prepare(
          'INSERT INTO maintenance_locks VALUES (?,?,?) ON CONFLICT(runId) DO UPDATE SET owner=excluded.owner,leaseUntil=excluded.leaseUntil',
        )
        .run(runId, owner, Date.now() + 60000);
    })
    .immediate();
}
function assertLock(store: Store, runId: string, owner: string) {
  const row = store.sqlite
    .prepare('SELECT owner,leaseUntil FROM maintenance_locks WHERE runId=?')
    .get(runId) as { owner: string; leaseUntil: number } | undefined;
  if (!row || row.owner !== owner || row.leaseUntil < Date.now())
    throw new Error('Evidence maintenance lease was lost.');
}
interface Manifest {
  version: 1;
  id: string;
  runId: string;
  createdAt: number;
  snapshotHash: string;
  files: { artifactId: string; filename: string; bytes: number; sha256: string }[];
}
async function archiveRun(store: Store, runId: string, signal?: AbortSignal) {
  const owner = randomUUID(),
    id = randomUUID(),
    root = store.config.archiveDir;
  lock(store, runId, owner);
  const staging = contained(root, `.partial-${id}`),
    destination = contained(root, id);
  let committed = false,
    madeStaging = false,
    madeDestination = false;
  const heartbeat = setInterval(
    () =>
      store.sqlite
        .prepare('UPDATE maintenance_locks SET leaseUntil=? WHERE runId=? AND owner=?')
        .run(Date.now() + 60000, runId, owner),
    5000,
  );
  try {
    const detail = store.detail(runId)!,
      files = artifacts(store, runId);
    if (!files.length) return { runId, artifacts: 0, bytes: 0 };
    await mkdir(root, { recursive: true });
    await mkdir(staging);
    madeStaging = true;
    const manifest: Manifest = {
      version: 1,
      id,
      runId,
      createdAt: Date.now(),
      snapshotHash: '',
      files: [],
    };
    for (const file of files) {
      signal?.throwIfAborted();
      assertLock(store, runId, owner);
      const source = evidencePath(file, store.config.artifactDir),
        dest = contained(staging, 'artifacts', file.filename);
      const info = await regular(source);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(source, dest, constants.COPYFILE_EXCL);
      const sha256 = await hash(source);
      if ((await regular(dest)).size !== info.size || (await hash(dest)) !== sha256)
        throw new Error('Archive checksum verification failed. Original evidence was preserved.');
      manifest.files.push({
        artifactId: file.id,
        filename: file.filename,
        bytes: info.size,
        sha256,
      });
    }
    await writeFile(contained(staging, 'run.json'), JSON.stringify(detail, null, 2) + '\n', {
      flag: 'wx',
    });
    manifest.snapshotHash = await hash(contained(staging, 'run.json'));
    const json = JSON.stringify(manifest, null, 2) + '\n';
    await writeFile(contained(staging, 'manifest.json'), json, { flag: 'wx' });
    signal?.throwIfAborted();
    assertLock(store, runId, owner);
    await rename(staging, destination);
    madeDestination = true;
    madeStaging = false;
    const bytes = manifest.files.reduce((n, f) => n + f.bytes, 0);
    store.sqlite
      .transaction(() => {
        assertLock(store, runId, owner);
        if (!terminal.includes(store.get(runId)!.status))
          throw new Error('Run became active; originals preserved.');
        store.sqlite
          .prepare(
            'INSERT INTO evidence_archives(id,runId,createdAt,state,manifestHash,bytes) VALUES (?,?,?,?,?,?)',
          )
          .run(
            id,
            runId,
            manifest.createdAt,
            'ready',
            createHash('sha256').update(json).digest('hex'),
            bytes,
          );
        const insert = store.sqlite.prepare('INSERT INTO archived_artifacts VALUES (?,?,?,?)');
        for (const file of manifest.files) insert.run(file.artifactId, id, file.sha256, file.bytes);
      })
      .immediate();
    committed = true;
    // Only exact verified files are removed. Directory trees are never deleted
    // from the working evidence root.
    for (const file of manifest.files) {
      signal?.throwIfAborted();
      assertLock(store, runId, owner);
      const source = contained(store.config.artifactDir, file.filename);
      await regular(source);
      if ((await hash(source)) !== file.sha256)
        throw new Error('Original evidence changed; the changed file was preserved.');
      await unlink(source);
    }
    store.compactChanges(runId);
    return { runId, archiveId: id, artifacts: files.length, bytes };
  } finally {
    clearInterval(heartbeat);
    store.sqlite
      .prepare('DELETE FROM maintenance_locks WHERE runId=? AND owner=?')
      .run(runId, owner);
    if (!committed && madeStaging)
      await rm(contained(root, `.partial-${id}`), { recursive: true, force: true });
    if (!committed && madeDestination)
      await rm(contained(root, id), { recursive: true, force: true });
  }
}
async function listFiles(root: string, dir = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = contained(root, path.relative(root, path.join(dir, entry.name)));
    if (entry.isSymbolicLink()) throw new Error('Archive contains an unexpected symlink.');
    if (entry.isDirectory()) found.push(...(await listFiles(root, file)));
    else found.push(path.relative(root, file));
  }
  return found.sort();
}
async function purgeArchive(store: Store, id: string, signal?: AbortSignal) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid archive identity.');
  const row = store.sqlite.prepare('SELECT * FROM evidence_archives WHERE id=?').get(id) as {
    runId: string;
    state: string;
    manifestHash: string;
  };
  const owner = randomUUID();
  lock(store, row.runId, owner);
  const heartbeat = setInterval(
    () =>
      store.sqlite
        .prepare('UPDATE maintenance_locks SET leaseUntil=? WHERE runId=? AND owner=?')
        .run(Date.now() + 60000, row.runId, owner),
    5000,
  );
  const directory = contained(store.config.archiveDir, id);
  try {
    signal?.throwIfAborted();
    if (row.state === 'ready') {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Archive directory is not a regular managed directory.');
      const raw = await readFile(contained(directory, 'manifest.json'), 'utf8');
      if (createHash('sha256').update(raw).digest('hex') !== row.manifestHash)
        throw new Error('Archive manifest changed; expiry stopped.');
      const manifest = JSON.parse(raw) as Manifest;
      if (
        manifest.id !== id ||
        manifest.runId !== row.runId ||
        (await hash(contained(directory, 'run.json'))) !== manifest.snapshotHash
      )
        throw new Error('Archive identity or snapshot verification failed.');
      for (const file of manifest.files) {
        signal?.throwIfAborted();
        await regular(contained(directory, 'artifacts', file.filename));
        if ((await hash(contained(directory, 'artifacts', file.filename))) !== file.sha256)
          throw new Error('Archive evidence changed; expiry stopped.');
      }
      const expected = [
        'manifest.json',
        'run.json',
        ...manifest.files.map((f) => path.join('artifacts', f.filename)),
      ].sort();
      if (JSON.stringify(await listFiles(directory)) !== JSON.stringify(expected))
        throw new Error('Archive contains unrecognized files; expiry stopped.');
      assertLock(store, row.runId, owner);
      store.sqlite
        .prepare("UPDATE evidence_archives SET state='purging' WHERE id=? AND state='ready'")
        .run(id);
    }
    // A persisted purging state permits recovery after a partial filesystem
    // deletion. It never authorizes removing a different directory.
    const current = await lstat(directory).catch(() => null);
    if (current?.isSymbolicLink())
      throw new Error('Archive directory was replaced with a symlink.');
    await rm(contained(store.config.archiveDir, id), { recursive: true, force: true });
    store.sqlite
      .prepare("UPDATE evidence_archives SET state='purged',purgedAt=? WHERE id=?")
      .run(Date.now(), id);
    store.compactChanges(row.runId);
    return { archiveId: id, runId: row.runId };
  } finally {
    clearInterval(heartbeat);
    store.sqlite
      .prepare('DELETE FROM maintenance_locks WHERE runId=? AND owner=?')
      .run(row.runId, owner);
  }
}
export async function applyRetention(store: Store, token: string, signal?: AbortSignal) {
  const preview = await previewRetention(store);
  if (preview.token !== token)
    throw new Error('Retention preview changed. Refresh and review the new candidates.');
  if (!preview.policy.enabled)
    throw new Error('Retention is disabled. Configure RETENTION_DAYS to enable it.');
  const archived = [],
    purged = [],
    errors = [];
  for (const run of preview.archive) {
    signal?.throwIfAborted();
    try {
      archived.push(await archiveRun(store, run.id, signal));
    } catch (e) {
      if (signal?.aborted) throw e;
      errors.push({ id: run.id, error: e instanceof Error ? e.message : 'Archival failed' });
    }
  }
  for (const archive of preview.purge) {
    signal?.throwIfAborted();
    try {
      purged.push(await purgeArchive(store, archive.id, signal));
    } catch (e) {
      if (signal?.aborted) throw e;
      errors.push({ id: archive.id, error: e instanceof Error ? e.message : 'Expiry failed' });
    }
  }
  return { archived, purged, errors };
}
export async function processRetentionJob(store: Store, signal?: AbortSignal) {
  const job = store.claimRetention();
  if (!job) return false;
  const timer = setInterval(
    () =>
      store.sqlite
        .prepare("UPDATE retention_jobs SET leaseUntil=? WHERE id=? AND status='running'")
        .run(Date.now() + 30000, job.id),
    5000,
  );
  try {
    const result = await applyRetention(store, job.previewToken, signal);
    store.sqlite
      .prepare(
        "UPDATE retention_jobs SET status=?,finishedAt=?,result=? WHERE id=? AND status='running'",
      )
      .run(
        result.errors.length ? 'partial' : 'completed',
        Date.now(),
        JSON.stringify(result),
        job.id,
      );
  } catch (e) {
    store.sqlite
      .prepare(
        "UPDATE retention_jobs SET status=?,finishedAt=?,error=? WHERE id=? AND status='running'",
      )
      .run(
        signal?.aborted ? 'interrupted' : 'blocked',
        Date.now(),
        e instanceof Error ? e.message : 'Maintenance stopped',
        job.id,
      );
  } finally {
    clearInterval(timer);
  }
  return true;
}
