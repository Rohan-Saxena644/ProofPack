import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runs, attempts } from './schema';
import { assertionOutcome } from '../core/outcomes';
import type { Config } from '../core/config';
import { publicConfig } from '../core/config';
import { quotaScope } from '../core/quota';
import type {
  RunInput,
  Status,
  Plan,
  EventRecord,
  AssertionRecord,
  ArtifactRecord,
  ModelCall,
  RunDetail,
  RunDelta,
} from '../core/contracts';

export class Store {
  sqlite: Database.Database;
  db: ReturnType<typeof drizzle>;
  constructor(readonly config: Config) {
    mkdirSync(path.dirname(config.databasePath), { recursive: true });
    this.sqlite = new Database(config.databasePath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('busy_timeout = 5000');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, targetUrl TEXT NOT NULL, brief TEXT NOT NULL, expected TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, mode TEXT NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL, cancelRequested INTEGER NOT NULL DEFAULT 0, attemptCount INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES runs(id), number INTEGER NOT NULL, status TEXT NOT NULL, worker TEXT NOT NULL, leaseUntil INTEGER NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER, error TEXT, plan TEXT, UNIQUE(runId, number));
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, attemptId TEXT NOT NULL REFERENCES attempts(id), type TEXT NOT NULL, description TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER, outcome TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assertions (id TEXT PRIMARY KEY, attemptId TEXT NOT NULL REFERENCES attempts(id), specId TEXT NOT NULL, description TEXT NOT NULL, kind TEXT NOT NULL, expected TEXT NOT NULL, actual TEXT NOT NULL, passed INTEGER NOT NULL, evidenceIds TEXT NOT NULL, createdAt INTEGER NOT NULL, UNIQUE(attemptId,specId));
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, attemptId TEXT NOT NULL REFERENCES attempts(id), kind TEXT NOT NULL, filename TEXT NOT NULL, label TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS model_calls (id TEXT PRIMARY KEY, attemptId TEXT NOT NULL REFERENCES attempts(id), stage TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, latencyMs INTEGER NOT NULL, inputTokens INTEGER, outputTokens INTEGER, valid INTEGER NOT NULL, error TEXT);
      CREATE INDEX IF NOT EXISTS run_queue ON runs(status,createdAt);
      CREATE INDEX IF NOT EXISTS events_attempt ON events(attemptId,startedAt);
      CREATE INDEX IF NOT EXISTS attempts_active_lease ON attempts(status,leaseUntil);
      CREATE INDEX IF NOT EXISTS artifacts_attempt ON artifacts(attemptId);
      CREATE INDEX IF NOT EXISTS model_calls_attempt ON model_calls(attemptId);
      CREATE TABLE IF NOT EXISTS provider_budgets (scope TEXT PRIMARY KEY,owner TEXT,leaseUntil INTEGER NOT NULL DEFAULT 0,nextAt INTEGER NOT NULL DEFAULT 0,cooldownUntil INTEGER NOT NULL DEFAULT 0,tokenLimit REAL,tokens REAL,requests REAL,requestsResetAt INTEGER,updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS maintenance_locks (runId TEXT PRIMARY KEY,owner TEXT NOT NULL,leaseUntil INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS run_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT,runId TEXT NOT NULL,kind TEXT NOT NULL,entityId TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS changes_run ON run_changes(runId,seq);
      CREATE TABLE IF NOT EXISTS run_streams (runId TEXT PRIMARY KEY,floorSeq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS evidence_archives (id TEXT PRIMARY KEY,runId TEXT NOT NULL,createdAt INTEGER NOT NULL,state TEXT NOT NULL,manifestHash TEXT NOT NULL,bytes INTEGER NOT NULL,purgedAt INTEGER);
      CREATE INDEX IF NOT EXISTS archives_run ON evidence_archives(runId,createdAt);
      CREATE TABLE IF NOT EXISTS archived_artifacts (artifactId TEXT PRIMARY KEY,archiveId TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS retention_jobs (id TEXT PRIMARY KEY,status TEXT NOT NULL,createdAt INTEGER NOT NULL,startedAt INTEGER,finishedAt INTEGER,leaseUntil INTEGER NOT NULL DEFAULT 0,previewToken TEXT NOT NULL,result TEXT,error TEXT);
      PRAGMA user_version = 1;
    `);
    for (const [table, kind] of [
      ['runs', 'run'],
      ['attempts', 'attempt'],
      ['events', 'event'],
      ['assertions', 'assertion'],
      ['artifacts', 'artifact'],
      ['model_calls', 'model'],
    ] as const) {
      const runId =
        table === 'runs'
          ? 'new.id'
          : table === 'attempts'
            ? 'new.runId'
            : '(SELECT runId FROM attempts WHERE id=new.attemptId)';
      for (const operation of ['INSERT', 'UPDATE'] as const) {
        const columns =
          table === 'attempts' && operation === 'UPDATE' ? ' OF status,plan,error,finishedAt' : '';
        this.sqlite.exec(
          `CREATE TRIGGER IF NOT EXISTS feed_${table}_${operation} AFTER ${operation}${columns} ON ${table} BEGIN INSERT INTO run_changes(runId,kind,entityId) VALUES (${runId},'${kind}',new.id); END;`,
        );
      }
    }
    this.sqlite
      .exec(`CREATE TRIGGER IF NOT EXISTS feed_archive_insert AFTER INSERT ON archived_artifacts BEGIN INSERT INTO run_changes(runId,kind,entityId) SELECT a.runId,'artifact',t.id FROM artifacts t JOIN attempts a ON a.id=t.attemptId WHERE t.id=new.artifactId; END;
      CREATE TRIGGER IF NOT EXISTS feed_archive_state AFTER UPDATE OF state ON evidence_archives BEGIN INSERT INTO run_changes(runId,kind,entityId) SELECT new.runId,'artifact',artifactId FROM archived_artifacts WHERE archiveId=new.id; END;`);
    this.db = drizzle(this.sqlite);
  }
  create(input: RunInput) {
    const cfg = publicConfig(this.config),
      now = Date.now();
    const run = {
      ...input,
      id: randomUUID(),
      status: 'queued' as const,
      createdAt: now,
      updatedAt: now,
      mode: cfg.mode,
      model: cfg.model,
      provider: cfg.provider,
      cancelRequested: false,
      attemptCount: 0,
    };
    this.db.insert(runs).values(run).run();
    return run;
  }
  list() {
    return this.db.select().from(runs).orderBy(desc(runs.createdAt)).limit(100).all();
  }
  get(id: string) {
    return this.db.select().from(runs).where(eq(runs.id, id)).get();
  }
  claim(worker: string) {
    return this.sqlite
      .transaction(() => {
        this.reap();
        if (this.config.MODEL_MODE === 'live' && (this.quotaWait()?.until ?? 0) > Date.now())
          return null;
        const row = this.db
          .select()
          .from(runs)
          .where(eq(runs.status, 'queued'))
          .orderBy(runs.createdAt)
          .get();
        if (!row) return null;
        const now = Date.now(),
          id = randomUUID(),
          number = row.attemptCount + 1;
        this.db
          .update(runs)
          .set({ status: 'planning', attemptCount: number, updatedAt: now })
          .where(eq(runs.id, row.id))
          .run();
        this.db
          .insert(attempts)
          .values({
            id,
            runId: row.id,
            number,
            status: 'planning',
            worker,
            leaseUntil: now + this.config.LEASE_MS,
            startedAt: now,
          })
          .run();
        return {
          run: this.get(row.id)!,
          attempt: this.db.select().from(attempts).where(eq(attempts.id, id)).get()!,
        };
      })
      .immediate();
  }
  reap(now = Date.now()) {
    this.sqlite
      .transaction(() => {
        const stale = this.db
          .select()
          .from(attempts)
          .where(
            and(inArray(attempts.status, ['running', 'planning']), lt(attempts.leaseUntil, now)),
          )
          .all();
        for (const a of stale) {
          this.finish(
            a.id,
            this.get(a.runId)?.cancelRequested ? 'cancelled' : 'interrupted',
            'Worker lease expired; browser session was lost.',
            now,
          );
        }
      })
      .immediate();
  }
  heartbeat(id: string) {
    return (
      this.sqlite
        .prepare("UPDATE attempts SET leaseUntil=? WHERE id=? AND status IN ('planning','running')")
        .run(Date.now() + this.config.LEASE_MS, id).changes > 0
    );
  }
  active(id: string) {
    const a = this.db.select().from(attempts).where(eq(attempts.id, id)).get();
    return !!a && ['planning', 'running'].includes(a.status);
  }
  setPlan(id: string, plan: Plan) {
    this.db.update(attempts).set({ plan, status: 'running' }).where(eq(attempts.id, id)).run();
    const a = this.db.select().from(attempts).where(eq(attempts.id, id)).get()!;
    this.db
      .update(runs)
      .set({ status: 'running', updatedAt: Date.now() })
      .where(eq(runs.id, a.runId))
      .run();
  }
  finish(id: string, status: Status, error: string | null = null, now = Date.now()) {
    this.sqlite.transaction(() => {
      const a = this.db.select().from(attempts).where(eq(attempts.id, id)).get();
      if (!a || !['planning', 'running'].includes(a.status)) return;
      if (this.get(a.runId)?.cancelRequested) status = 'cancelled';
      if (status === 'passed') {
        const results = this.sqlite
          .prepare('SELECT specId,passed FROM assertions WHERE attemptId=?')
          .all(id) as { specId: string; passed: boolean }[];
        status = assertionOutcome(a.plan?.assertions.map((s) => s.id) ?? [], results);
        if (status !== 'passed')
          error ??= 'The durable assertion ledger does not establish a pass.';
      }
      this.db
        .update(attempts)
        .set({ status, error, finishedAt: now, leaseUntil: 0 })
        .where(eq(attempts.id, id))
        .run();
      this.db.update(runs).set({ status, updatedAt: now }).where(eq(runs.id, a.runId)).run();
      this.sqlite
        .prepare("UPDATE events SET outcome=?,finishedAt=? WHERE attemptId=? AND outcome='running'")
        .run(status, now, id);
      this.compactChanges(a.runId);
    })();
  }
  cancel(id: string) {
    const run = this.get(id);
    if (!run) return false;
    this.db
      .update(runs)
      .set({
        cancelRequested: true,
        ...(run.status === 'queued' ? { status: 'cancelled' as const } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(runs.id, id))
      .run();
    return true;
  }
  retry(id: string) {
    return this.sqlite
      .transaction(() => {
        const r = this.get(id);
        if (!r || !this.retryPolicy(id).allowed) return false;
        this.db
          .update(runs)
          .set({ status: 'queued', cancelRequested: false, updatedAt: Date.now() })
          .where(eq(runs.id, id))
          .run();
        return true;
      })
      .immediate();
  }
  quotaWait() {
    if (this.config.MODEL_MODE !== 'live') return null;
    const row = this.sqlite
      .prepare('SELECT cooldownUntil,requests,requestsResetAt FROM provider_budgets WHERE scope=?')
      .get(quotaScope(this.config)) as
      | { cooldownUntil: number; requests: number | null; requestsResetAt: number | null }
      | undefined;
    const until = Math.max(
      row?.cooldownUntil ?? 0,
      row?.requests === 0 ? (row.requestsResetAt ?? 0) : 0,
    );
    return until > Date.now()
      ? {
          until,
          reason: 'Waiting for shared provider quota. No attempt will start during the cooldown.',
        }
      : null;
  }
  retryPolicy(id: string) {
    const run = this.get(id),
      remaining = Math.max(0, this.config.MAX_ATTEMPTS - (run?.attemptCount ?? 0));
    const lock = this.sqlite
      .prepare('SELECT leaseUntil FROM maintenance_locks WHERE runId=?')
      .get(id) as { leaseUntil: number } | undefined;
    const reason = !run
      ? 'Run not found.'
      : !['interrupted', 'blocked', 'failed'].includes(run.status)
        ? 'This run is not eligible for a retry.'
        : !remaining
          ? `Attempt limit reached (${this.config.MAX_ATTEMPTS}). Earlier evidence is retained.`
          : lock && lock.leaseUntil > Date.now()
            ? 'Evidence maintenance is in progress. Retry when it finishes.'
            : null;
    return { allowed: reason === null, reason, remaining, maxAttempts: this.config.MAX_ATTEMPTS };
  }
  event(
    attemptId: string,
    type: string,
    description: string,
    data: Record<string, unknown> = {},
    outcome = 'recorded',
  ) {
    const id = randomUUID(),
      now = Date.now();
    this.sqlite
      .prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?)')
      .run(
        id,
        attemptId,
        type,
        description,
        now,
        outcome === 'running' ? null : now,
        outcome,
        JSON.stringify(data),
      );
    return id;
  }
  endEvent(id: string, outcome: string, data: Record<string, unknown>) {
    this.sqlite
      .prepare("UPDATE events SET finishedAt=?,outcome=?,data=? WHERE id=? AND outcome='running'")
      .run(Date.now(), outcome, JSON.stringify(data), id);
  }
  artifact(attemptId: string, kind: ArtifactRecord['kind'], filename: string, label: string) {
    const row = { id: randomUUID(), attemptId, kind, filename, label, createdAt: Date.now() };
    this.sqlite
      .prepare('INSERT INTO artifacts VALUES (@id,@attemptId,@kind,@filename,@label,@createdAt)')
      .run(row);
    return row;
  }
  assertion(row: Omit<AssertionRecord, 'id' | 'createdAt'>) {
    const validIds = new Set(
      (
        this.sqlite.prepare('SELECT id FROM artifacts WHERE attemptId=?').all(row.attemptId) as {
          id: string;
        }[]
      ).map((a) => a.id),
    );
    if (row.evidenceIds.some((id) => !validIds.has(id)))
      throw new Error('Invalid evidence reference');
    this.sqlite
      .prepare(
        'INSERT INTO assertions VALUES (@id,@attemptId,@specId,@description,@kind,@expected,@actual,@passed,@evidenceIds,@createdAt)',
      )
      .run({
        ...row,
        id: randomUUID(),
        passed: Number(row.passed),
        evidenceIds: JSON.stringify(row.evidenceIds),
        createdAt: Date.now(),
      });
  }
  modelCall(row: Omit<ModelCall, 'id'>) {
    this.sqlite
      .prepare(
        'INSERT INTO model_calls VALUES (@id,@attemptId,@stage,@provider,@model,@latencyMs,@inputTokens,@outputTokens,@valid,@error)',
      )
      .run({ ...row, id: randomUUID(), valid: Number(row.valid) });
  }
  detail(id: string): RunDetail | null {
    return this.sqlite.transaction(() => this.detailData(id))();
  }
  private cursor() {
    return (
      (
        this.sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name='run_changes'").get() as
          { seq: number } | undefined
      )?.seq ?? 0
    );
  }
  private detailData(id: string): RunDetail | null {
    const run = this.get(id);
    if (!run) return null;
    const ats = this.db
      .select()
      .from(attempts)
      .where(eq(attempts.runId, id))
      .orderBy(attempts.number)
      .all();
    return {
      run,
      attempts: ats,
      ...this.parts(id),
      cursor: this.cursor(),
      retry: this.retryPolicy(id),
      queueWait: run.status === 'queued' ? this.quotaWait() : null,
    };
  }
  private parts(id: string, changed?: Map<string, string[]>) {
    const rows = <T>(table: string, kind: string) => {
      const ids = changed?.get(kind);
      if (changed && !ids?.length) return [] as T[];
      return this.sqlite
        .prepare(
          `SELECT t.* FROM ${table} t JOIN attempts a ON a.id=t.attemptId WHERE a.runId=? ${ids ? `AND t.id IN (${ids.map(() => '?').join(',')})` : ''} ORDER BY t.rowid`,
        )
        .all(id, ...(ids ?? [])) as T[];
    };
    return {
      events: rows<Omit<EventRecord, 'data'> & { data: string }>('events', 'event').map((e) => ({
        ...e,
        data: JSON.parse(e.data),
      })),
      assertions: rows<
        Omit<AssertionRecord, 'evidenceIds' | 'passed'> & { evidenceIds: string; passed: number }
      >('assertions', 'assertion').map((a) => ({
        ...a,
        passed: !!a.passed,
        evidenceIds: JSON.parse(a.evidenceIds),
      })),
      artifacts: this.decorateArtifacts(rows<ArtifactRecord>('artifacts', 'artifact')),
      modelCalls: rows<ModelCall>('model_calls', 'model').map((c) => ({ ...c, valid: !!c.valid })),
    };
  }
  changes(id: string, after: number, limit = 200): RunDelta | null {
    return this.sqlite.transaction(() => {
      const run = this.get(id);
      if (!run) return null;
      const current = this.cursor();
      const floor =
        (
          this.sqlite.prepare('SELECT floorSeq FROM run_streams WHERE runId=?').get(id) as
            { floorSeq: number } | undefined
        )?.floorSeq ?? 0;
      if (after < floor || after > current)
        return { cursor: current, hasMore: false, reset: true, detail: this.detailData(id)! };
      const size = Math.max(1, Math.min(200, limit));
      const rows = this.sqlite
        .prepare(
          'SELECT seq,kind,entityId FROM run_changes WHERE runId=? AND seq>? ORDER BY seq LIMIT ?',
        )
        .all(id, after, size + 1) as { seq: number; kind: string; entityId: string }[];
      const hasMore = rows.length > size,
        included = rows.slice(0, size);
      const changed = new Map<string, string[]>();
      for (const row of included)
        changed.set(row.kind, [...new Set([...(changed.get(row.kind) ?? []), row.entityId])]);
      const attemptIds = changed.get('attempt') ?? [];
      const ats = attemptIds.length
        ? this.db
            .select()
            .from(attempts)
            .where(and(eq(attempts.runId, id), inArray(attempts.id, attemptIds)))
            .orderBy(attempts.number)
            .all()
        : [];
      const cursor = hasMore ? included.at(-1)!.seq : current;
      return {
        cursor,
        hasMore,
        reset: false,
        detail: {
          run,
          attempts: ats,
          ...this.parts(id, changed),
          retry: this.retryPolicy(id),
          queueWait: run.status === 'queued' ? this.quotaWait() : null,
          cursor,
        },
      };
    })();
  }
  compactChanges(id: string, keep = 200) {
    this.sqlite
      .transaction(() => {
        const row = this.sqlite
          .prepare('SELECT seq FROM run_changes WHERE runId=? ORDER BY seq DESC LIMIT 1 OFFSET ?')
          .get(id, Math.max(0, keep)) as { seq: number } | undefined;
        if (!row) return;
        this.sqlite
          .prepare(
            'INSERT INTO run_streams(runId,floorSeq) VALUES (?,?) ON CONFLICT(runId) DO UPDATE SET floorSeq=MAX(floorSeq,excluded.floorSeq)',
          )
          .run(id, row.seq);
        this.sqlite.prepare('DELETE FROM run_changes WHERE runId=? AND seq<=?').run(id, row.seq);
      })
      .immediate();
  }
  decorateArtifacts(rows: ArtifactRecord[]) {
    if (!rows.length) return rows;
    const archives = this.sqlite
      .prepare(
        `SELECT aa.artifactId,aa.archiveId,ar.state FROM archived_artifacts aa JOIN evidence_archives ar ON ar.id=aa.archiveId WHERE aa.artifactId IN (${rows.map(() => '?').join(',')})`,
      )
      .all(...rows.map((a) => a.id)) as { artifactId: string; archiveId: string; state: string }[];
    const map = new Map(archives.map((a) => [a.artifactId, a]));
    return rows.map((row) => {
      const archive = map.get(row.id);
      return {
        ...row,
        storage: archive
          ? archive.state === 'ready'
            ? ('archived' as const)
            : ('expired' as const)
          : ('active' as const),
        ...(archive ? { archiveId: archive.archiveId } : {}),
      };
    });
  }
  enqueueRetention(previewToken: string) {
    return this.sqlite
      .transaction(() => {
        const existing = this.sqlite
          .prepare(
            "SELECT id FROM retention_jobs WHERE previewToken=? AND status IN ('queued','running')",
          )
          .get(previewToken) as { id: string } | undefined;
        if (existing) return existing.id;
        const id = randomUUID();
        this.sqlite
          .prepare('INSERT INTO retention_jobs(id,status,createdAt,previewToken) VALUES (?,?,?,?)')
          .run(id, 'queued', Date.now(), previewToken);
        return id;
      })
      .immediate();
  }
  retentionJob(id: string) {
    const row = this.sqlite.prepare('SELECT * FROM retention_jobs WHERE id=?').get(id) as
      | {
          id: string;
          status: string;
          createdAt: number;
          startedAt: number | null;
          finishedAt: number | null;
          previewToken: string;
          result: string | null;
          error: string | null;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          status: row.status,
          createdAt: row.createdAt,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          result: row.result ? JSON.parse(row.result) : null,
          error: row.error,
        }
      : null;
  }
  claimRetention() {
    return this.sqlite
      .transaction(() => {
        const now = Date.now();
        this.reapRetentionJobs(now);
        const row = this.sqlite
          .prepare(
            "SELECT id,previewToken FROM retention_jobs WHERE status='queued' ORDER BY createdAt LIMIT 1",
          )
          .get() as { id: string; previewToken: string } | undefined;
        if (!row) return null;
        this.sqlite
          .prepare("UPDATE retention_jobs SET status='running',startedAt=?,leaseUntil=? WHERE id=?")
          .run(now, now + 30000, row.id);
        return row;
      })
      .immediate();
  }
  reapRetentionJobs(now = Date.now()) {
    this.sqlite
      .prepare(
        "UPDATE retention_jobs SET status='interrupted',finishedAt=?,error='Maintenance worker lease expired; refresh the preview before retrying.' WHERE status='running' AND leaseUntil<?",
      )
      .run(now, now);
  }
  close() {
    this.sqlite.close();
  }
}
