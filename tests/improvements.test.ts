import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, type Config } from '../src/core/config';
import { durationMs } from '../src/core/quota';
import { actionSchema } from '../src/core/contracts';
import { mergeRunDelta } from '../src/core/run-feed';
import { Store } from '../src/db/store';
import { fixturePlan } from '../src/ai/fixture';
import { QuotaGate, QuotaUnavailable } from '../src/ai/quota';
import { LiveAdapter, ModelSession } from '../src/ai/model';
import { applyRetention, previewRetention, processRetentionJob } from '../src/storage/retention';
import { evidencePath, contained } from '../src/storage/paths';
import { htmlReport, markdownReport } from '../src/reports/report';

const input = {
  targetUrl: 'http://127.0.0.1:4100',
  brief: 'Synthetic unit test only',
  expected: 'No browser feature claim',
};
function make(overrides: Partial<Config> = {}) {
  mkdirSync('data', { recursive: true });
  const root = mkdtempSync(path.resolve('data/improvements-'));
  return new Store({
    ...loadConfig({
      MODEL_MODE: 'fixture',
      MODEL_PROVIDER: 'local',
      MODEL_FORMAT: 'json_schema',
      MODEL_API_KEY: 'synthetic-key',
      DATABASE_PATH: path.join(root, 'store.sqlite'),
      ARTIFACT_DIR: path.join(root, 'artifacts'),
      ARCHIVE_DIR: path.join(root, 'archives'),
      RETENTION_DAYS: 1,
      RETENTION_KEEP_RUNS: 0,
      ARCHIVE_RETENTION_DAYS: 0,
    }),
    ...overrides,
  });
}
test('shared quota leases serialize real adapter dispatches across database connections', async () => {
  const a = make({ MODEL_TIMEOUT_MS: 2000, MODEL_MAX_QUOTA_WAIT_MS: 2000 }),
    b = new Store(a.config),
    original = globalThis.fetch;
  let active = 0,
    maximum = 0,
    calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      maximum = Math.max(maximum, ++active);
      await delay(40);
      active--;
      return Response.json(
        {
          choices: [
            {
              message: { content: '{"action":{"type":"capture","description":"Synthetic test"}}' },
            },
          ],
        },
        {
          headers: {
            'x-ratelimit-limit-tokens': '100000',
            'x-ratelimit-remaining-tokens': '99000',
          },
        },
      );
    };
    const payload = {
      goalIndex: 0,
      goal: fixturePlan.goals[0],
      observation: { url: input.targetUrl, text: '', controls: [] },
      history: [],
      completedAssertions: [],
      plan: fixturePlan,
    };
    const replies = await Promise.all(
      [a, b].map((store) =>
        new LiveAdapter(store.config, new QuotaGate(store)).request(
          'decision',
          payload,
          actionSchema,
          null,
          new AbortController().signal,
        ),
      ),
    );
    assert.equal(calls, 2);
    assert.equal(maximum, 1);
    assert.ok(replies.every((r) => actionSchema.parse(r.value).type === 'capture'));
  } finally {
    globalThis.fetch = original;
    a.close();
    b.close();
  }
});
test('provider headers pace tokens, share long cooldowns and defer queued attempts', async () => {
  const a = make({ MODEL_MODE: 'live' }),
    b = new Store(a.config);
  try {
    const gate = new QuotaGate(a),
      other = new QuotaGate(b),
      now = Date.now();
    assert.equal(gate.reserve(1000, 'first', now).waitMs, 0);
    assert.ok(other.reserve(1000, 'second', now).waitMs > 0);
    gate.release(
      'first',
      new Headers({ 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '100' }),
      200,
      now,
    );
    assert.ok(other.reserve(1000, 'second', now + 1).waitMs > 0);
    assert.equal(other.reserve(1000, 'second', now + 10000).waitMs, 0);
    other.release('second', new Headers({ 'retry-after': '442' }), 429, Date.now());
    const run = a.create(input);
    assert.equal(b.claim('other-worker'), null);
    assert.equal(a.get(run.id)?.attemptCount, 0);
    assert.ok(a.quotaWait()!.until > Date.now() + 400000);
    await assert.rejects(other.acquire(1000, new AbortController().signal), QuotaUnavailable);
    assert.equal(durationMs('2m59.56s'), 179560);
    assert.equal(durationMs('1h2m3.5s'), 3723500);
    assert.equal(durationMs('invalid'), null);
  } finally {
    a.close();
    b.close();
  }
});
test('stale provider owners cannot overwrite a replacement lease; cancellation does not steal it', async () => {
  const a = make(),
    gate = new QuotaGate(a),
    now = Date.now();
  try {
    gate.reserve(10, 'old', now);
    gate.reserve(10, 'replacement', now + a.config.MODEL_TIMEOUT_MS + 6000);
    gate.release('old', new Headers({ 'retry-after': '999' }), 429, now + 1);
    assert.deepEqual(a.sqlite.prepare('SELECT owner,cooldownUntil FROM provider_budgets').get(), {
      owner: 'replacement',
      cooldownUntil: 0,
    });
    const controller = new AbortController();
    // The replacement lease is deliberately in the future for this test.
    const waiting = gate.acquire(10, controller.signal);
    controller.abort(new Error('User cancelled'));
    await assert.rejects(waiting, { name: 'AbortError' });
    assert.equal(controller.signal.reason.message, 'User cancelled');
    assert.equal(
      (a.sqlite.prepare('SELECT owner FROM provider_budgets').get() as { owner: string }).owner,
      'replacement',
    );
  } finally {
    a.close();
  }
});
test('quota preflight failure dispatches no HTTP and does not consume repair attempts', async () => {
  const s = make({ MODEL_MODE: 'live' }),
    original = globalThis.fetch;
  let calls = 0;
  try {
    s.create(input);
    const claim = s.claim('worker')!,
      gate = new QuotaGate(s);
    gate.reserve(10, 'blocker');
    gate.release('blocker', new Headers({ 'retry-after': '442' }), 429);
    globalThis.fetch = async () => {
      calls++;
      throw new Error('Unexpected HTTP');
    };
    const session = new ModelSession(s.config, s, claim.attempt.id, new AbortController().signal);
    await assert.rejects(session.plan(input), QuotaUnavailable);
    assert.equal(calls, 0);
    assert.equal(session.calls, 1);
  } finally {
    globalThis.fetch = original;
    s.close();
  }
});
test('incremental feed includes mutable step completion, bounded pages and no unrelated history', () => {
  const s = make();
  try {
    const run = s.create(input),
      claim = s.claim('worker')!;
    let detail = s.detail(run.id)!;
    const event = s.event(claim.attempt.id, 'step', 'In progress', {}, 'running');
    let update = s.changes(run.id, detail.cursor!)!;
    detail = mergeRunDelta(detail, update);
    assert.equal(detail.events[0].outcome, 'running');
    s.endEvent(event, 'passed', { observed: true });
    update = s.changes(run.id, detail.cursor!)!;
    assert.equal(update.detail.events.length, 1);
    detail = mergeRunDelta(detail, update);
    assert.equal(detail.events.length, 1);
    assert.equal(detail.events[0].outcome, 'passed');
    assert.equal(detail.events[0].data.observed, true);
    const stale = update;
    for (let i = 0; i < 7; i++) s.event(claim.attempt.id, 'note', `Note ${i}`);
    let pages = 0;
    do {
      update = s.changes(run.id, detail.cursor!, 2)!;
      assert.ok(update.detail.events.length <= 2);
      detail = mergeRunDelta(detail, update);
      pages++;
    } while (update.hasMore);
    assert.ok(pages > 1);
    assert.equal(detail.events.length, 8);
    assert.equal(mergeRunDelta(detail, stale), detail);
    s.create({ ...input, brief: 'Another synthetic test run' });
    const unchanged = s.changes(run.id, detail.cursor!)!;
    assert.equal(
      unchanged.detail.events.length +
        unchanged.detail.attempts.length +
        unchanged.detail.artifacts.length +
        unchanged.detail.modelCalls.length,
      0,
    );
    assert.deepEqual(mergeRunDelta(detail, unchanged).events, s.detail(run.id)!.events);
    s.compactChanges(run.id, 2);
    const reset = s.changes(run.id, 0)!;
    assert.equal(reset.reset, true);
    assert.equal(reset.detail.events.length, 8);
  } finally {
    s.close();
  }
});
async function evidence(s: Store) {
  const run = s.create(input),
    claim = s.claim('synthetic')!;
  s.setPlan(claim.attempt.id, fixturePlan);
  const filename = path.join(run.id, claim.attempt.id, 'synthetic.png');
  await mkdir(path.dirname(path.join(s.config.artifactDir, filename)), { recursive: true });
  const data = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII=',
    'base64',
  );
  await writeFile(path.join(s.config.artifactDir, filename), data);
  const artifact = s.artifact(claim.attempt.id, 'screenshot', filename, 'Synthetic unit evidence');
  s.assertion({
    attemptId: claim.attempt.id,
    specId: fixturePlan.assertions[0].id,
    description: 'Synthetic assertion',
    kind: 'text_visible',
    expected: 'Synthetic',
    actual: 'Missing in synthetic test',
    passed: false,
    evidenceIds: [artifact.id],
  });
  s.finish(claim.attempt.id, 'failed', 'Synthetic assertion failure');
  s.sqlite
    .prepare('UPDATE runs SET createdAt=?,updatedAt=? WHERE id=?')
    .run(Date.now() - 3 * 86400000, Date.now() - 3 * 86400000, run.id);
  return { run, claim, artifact, data };
}
test('retention verifies archives before removing originals; reports and delta keep evidence available', async () => {
  const s = make();
  try {
    const { run, artifact, data } = await evidence(s);
    const snapshot = s.detail(run.id)!;
    const preview = await previewRetention(s);
    assert.equal(preview.archive.length, 1);
    const result = await applyRetention(s, preview.token);
    assert.equal(result.errors.length, 0);
    assert.equal(result.archived.length, 1);
    await assert.rejects(access(path.join(s.config.artifactDir, artifact.filename)));
    const update = s.changes(run.id, snapshot.cursor!)!;
    const merged = mergeRunDelta(snapshot, update);
    assert.equal(merged.artifacts[0].storage, 'archived');
    assert.deepEqual(
      await readFile(evidencePath(merged.artifacts[0], s.config.artifactDir, s.config.archiveDir)),
      data,
    );
    assert.ok(
      htmlReport(merged, s.config.artifactDir, s.config.archiveDir).includes(
        'data:image/png;base64,',
      ),
    );
    assert.equal(merged.run.status, 'failed');
    assert.ok(markdownReport(merged).includes('Outcome: FAILED'));
    assert.equal((await previewRetention(s)).purge.length, 0);
    assert.equal(s.retry(run.id), true);
    const second = s.claim('retry')!;
    assert.equal(second.attempt.number, 2);
    assert.equal(s.detail(run.id)!.artifacts[0].storage, 'archived');
  } finally {
    s.close();
  }
});
test('explicit archive expiry preserves ledger and refuses unrecognized archive files', async () => {
  const s = make({ ARCHIVE_RETENTION_DAYS: 1 });
  try {
    const { run } = await evidence(s);
    await applyRetention(s, (await previewRetention(s)).token);
    s.sqlite.prepare('UPDATE evidence_archives SET createdAt=?').run(Date.now() - 2 * 86400000);
    const archived = s.detail(run.id)!.artifacts[0],
      extra = path.join(s.config.archiveDir, archived.archiveId!, 'personal-note.txt');
    await writeFile(extra, 'Preserve unexpected data');
    let result = await applyRetention(s, (await previewRetention(s)).token);
    assert.equal(result.purged.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(await readFile(extra, 'utf8'), 'Preserve unexpected data');
    const { unlink } = await import('node:fs/promises');
    await unlink(extra);
    result = await applyRetention(s, (await previewRetention(s)).token);
    assert.equal(result.purged.length, 1);
    const expired = s.detail(run.id)!;
    assert.equal(expired.artifacts[0].storage, 'expired');
    assert.equal(expired.assertions[0].passed, false);
    assert.equal(expired.run.status, 'failed');
    assert.throws(
      () => evidencePath(expired.artifacts[0], s.config.artifactDir, s.config.archiveDir),
      /expired/,
    );
    assert.ok(
      htmlReport(expired, s.config.artifactDir, s.config.archiveDir).includes(
        'expired under the configured retention policy',
      ),
    );
  } finally {
    s.close();
  }
});
test('retention defaults, stale previews, missing evidence and active runs fail closed', async () => {
  const s = make();
  try {
    const { run, artifact } = await evidence(s),
      preview = await previewRetention(s);
    s.sqlite.prepare('UPDATE runs SET updatedAt=updatedAt+1 WHERE id=?').run(run.id);
    await assert.rejects(applyRetention(s, preview.token), /preview changed/);
    const { unlink } = await import('node:fs/promises');
    await unlink(path.join(s.config.artifactDir, artifact.filename));
    const result = await applyRetention(s, (await previewRetention(s)).token);
    assert.equal(result.errors.length, 1);
    assert.equal(result.archived.length, 0);
    assert.equal(s.detail(run.id)!.artifacts[0].storage, 'active');
    s.retry(run.id);
    s.claim('active');
    assert.equal((await previewRetention(s)).archive.length, 0);
    const disabled = new Store({ ...s.config, RETENTION_DAYS: 0 });
    try {
      assert.equal((await previewRetention(disabled)).policy.enabled, false);
      await assert.rejects(
        applyRetention(disabled, (await previewRetention(disabled)).token),
        /disabled/,
      );
    } finally {
      disabled.close();
    }
  } finally {
    s.close();
  }
});
test('managed evidence paths reject traversal and overlapping archive roots', async () => {
  const s = make();
  try {
    assert.throws(() => contained(s.config.artifactDir, '..', 'outside.txt'), /escapes/);
    const overlap = new Store({
      ...s.config,
      archiveDir:
        process.platform === 'win32' ? s.config.artifactDir.toUpperCase() : s.config.artifactDir,
    });
    try {
      await assert.rejects(previewRetention(overlap), /must be separate/);
    } finally {
      overlap.close();
    }
  } finally {
    s.close();
  }
});
test('retry policy enforces maintenance and limits; maintenance jobs deduplicate and recover honestly', async () => {
  const s = make();
  try {
    const { run } = await evidence(s);
    s.sqlite
      .prepare('INSERT INTO maintenance_locks VALUES (?,?,?)')
      .run(run.id, 'maintainer', Date.now() + 30000);
    assert.equal(s.retryPolicy(run.id).allowed, false);
    assert.match(s.retryPolicy(run.id).reason!, /maintenance/);
    assert.equal(s.retry(run.id), false);
    s.sqlite.prepare('DELETE FROM maintenance_locks').run();
    assert.equal(s.retry(run.id), true);
    const second = s.claim('retry')!;
    s.finish(second.attempt.id, 'blocked');
    assert.equal(s.retryPolicy(run.id).remaining, 0);
    assert.match(s.retryPolicy(run.id).reason!, /limit/);
    assert.equal(s.retry(run.id), false);
    const token = (await previewRetention(s)).token,
      id = s.enqueueRetention(token);
    assert.equal(s.enqueueRetention(token), id);
    s.claimRetention();
    s.reapRetentionJobs(Date.now() + 40000);
    assert.equal(s.retentionJob(id)?.status, 'interrupted');
    const next = s.enqueueRetention((await previewRetention(s)).token);
    assert.notEqual(next, id);
    await processRetentionJob(s);
    assert.equal(s.retentionJob(next)?.status, 'completed');
  } finally {
    s.close();
  }
});
