import assert from 'node:assert/strict';
import type { RunDetail } from '../src/core/contracts';

// Check actual ledger coverage as well as status: a live planner must not get a
// passing persistence demo merely by checking the landing-page URL.
export function verifyPersistenceCoverage(detail: RunDetail) {
  const attempt = detail.attempts.at(-1)!;
  const rows = detail.assertions.filter((a) => a.attemptId === attempt.id);
  const fresh = detail.events.find((e) => e.attemptId === attempt.id && e.type === 'context');
  assert.ok(fresh, 'Live decisions did not create a fresh browser context');
  const project = `Moonbase-${detail.run.id.slice(0, 8)}-a${attempt.number}`;
  assert.ok(
    rows.some((a) => a.expected === project && a.passed && a.createdAt < fresh.startedAt),
    'Project creation was not explicitly checked before logout',
  );
  assert.ok(
    rows.some(
      (a) =>
        a.kind === 'url_is' &&
        new URL(a.actual).pathname === '/login' &&
        a.passed &&
        a.createdAt < fresh.startedAt,
    ),
    'Logout URL was not checked before resetting the context',
  );
  assert.ok(
    rows.some(
      (a) =>
        a.kind === 'url_is' &&
        new URL(a.actual).pathname === '/projects' &&
        a.passed &&
        a.createdAt >= fresh.startedAt,
    ),
    'Fresh login URL was not checked',
  );
  const persisted = rows.find((a) => a.expected === project && a.createdAt >= fresh.startedAt);
  assert.ok(persisted, 'Project persistence was not explicitly checked after fresh login');
  assert.equal(persisted.passed, detail.run.status === 'passed');
  assert.ok(persisted.evidenceIds.length > 0, 'Persistence check needs screenshot evidence');
  assert.ok(detail.modelCalls.some((c) => c.stage === 'plan' && c.valid));
  assert.ok(detail.modelCalls.some((c) => c.stage === 'decision' && c.valid));
  assert.ok(
    detail.modelCalls.every((c) => c.provider !== 'fixture'),
    'Live run used fixture decisions',
  );
  return persisted;
}
