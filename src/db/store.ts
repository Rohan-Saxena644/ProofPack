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
import type {
  RunInput,
  Status,
  Plan,
  EventRecord,
  AssertionRecord,
  ArtifactRecord,
  ModelCall,
  RunDetail,
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
      PRAGMA user_version = 1;
    `);
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
        if (
          !r ||
          !['interrupted', 'blocked', 'failed'].includes(r.status) ||
          r.attemptCount >= this.config.MAX_ATTEMPTS
        )
          return false;
        this.db
          .update(runs)
          .set({ status: 'queued', cancelRequested: false, updatedAt: Date.now() })
          .where(eq(runs.id, id))
          .run();
        return true;
      })
      .immediate();
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
    const run = this.get(id);
    if (!run) return null;
    const ats = this.db
      .select()
      .from(attempts)
      .where(eq(attempts.runId, id))
      .orderBy(attempts.number)
      .all();
    const rows = <T>(table: string) =>
      this.sqlite
        .prepare(
          `SELECT t.* FROM ${table} t JOIN attempts a ON a.id=t.attemptId WHERE a.runId=? ORDER BY t.rowid`,
        )
        .all(id) as T[];
    return {
      run,
      attempts: ats,
      events: rows<Omit<EventRecord, 'data'> & { data: string }>('events').map((e) => ({
        ...e,
        data: JSON.parse(e.data),
      })),
      assertions: rows<
        Omit<AssertionRecord, 'evidenceIds' | 'passed'> & { evidenceIds: string; passed: number }
      >('assertions').map((a) => ({
        ...a,
        passed: !!a.passed,
        evidenceIds: JSON.parse(a.evidenceIds),
      })),
      artifacts: rows<ArtifactRecord>('artifacts'),
      modelCalls: rows<ModelCall>('model_calls').map((c) => ({ ...c, valid: !!c.valid })),
    };
  }
  close() {
    this.sqlite.close();
  }
}
