import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/core/config';
import { actionSchema, planSchema } from '../src/core/contracts';
import { fixturePlan } from '../src/ai/fixture';
import { Store } from '../src/db/store';
import { allowedUrl } from '../src/execution/boundaries';
import { assertionOutcome } from '../src/execution/runner';
import { markdownReport, htmlReport, reportData } from '../src/reports/report';
import { localRequest } from '../src/server/service';
import { LiveAdapter } from '../src/ai/model';

const origins = ['http://127.0.0.1:4100'];
const input = { targetUrl: origins[0], brief: 'Create a project and log out then log in', expected: 'The project should persist' };
function store() { mkdirSync('data', { recursive: true }); const dir = mkdtempSync(path.resolve('data/unit-')); return new Store(loadConfig({ DATABASE_PATH: path.join(dir, 'test.sqlite'), ARTIFACT_DIR: path.join(dir, 'artifacts'), MODEL_MODE: 'fixture' })); }
test('action vocabulary rejects code, unknown fields and unsupported actions', () => {
  assert.equal(actionSchema.safeParse({ type: 'evaluate', code: 'process.exit()' }).success, false);
  assert.equal(actionSchema.safeParse({ type: 'click', controlId: 'c1', description: 'Click', javascript: 'bad' }).success, false);
  assert.equal(actionSchema.safeParse({ type: 'click', controlId: 'c1', description: 'Click' }).success, true);
});
test('plans require explicit nonduplicated assertions assigned once', () => {
  assert.equal(planSchema.safeParse(fixturePlan).success, true);
  assert.equal(planSchema.safeParse({ ...fixturePlan, assertions: [] }).success, false);
  const plan = structuredClone(fixturePlan); plan.goals[0].assertions.push('persisted');
  assert.equal(planSchema.safeParse(plan).success, false);
});
test('origin checks reject credentials, schemes, metadata and unintended ports', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'http://127.0.0.1:4101', 'http://127.0.0.1:4100.evil.test', 'http://user:secret@127.0.0.1:4100', 'http://169.254.169.254/latest/meta-data']) assert.equal(allowedUrl(url, origins), false, url);
  assert.equal(allowedUrl('http://127.0.0.1:4100/projects', origins), true);
  assert.equal(allowedUrl('http://169.254.169.254', ['http://169.254.169.254']), false);
});
test('ledger cannot pass with missing or contradicted checks', () => {
  assert.equal(assertionOutcome(['a'], []), 'blocked');
  assert.equal(assertionOutcome([], []), 'blocked');
  assert.equal(assertionOutcome(['a'], [{ specId: 'a', passed: false }]), 'failed');
  assert.equal(assertionOutcome(['a'], [{ specId: 'a', passed: true }]), 'passed');
});
test('transactional claims are exclusive across connections; expired attempts remain interrupted', () => {
  const a = store(), b = new Store(a.config);
  try {
    const run = a.create(input), first = a.claim('worker-a')!;
    assert.equal(b.claim('worker-b'), null);
    b.reap(first.attempt.leaseUntil + 1);
    assert.equal(a.get(run.id)?.status, 'interrupted');
    assert.equal(a.heartbeat(first.attempt.id), false);
    assert.equal(a.retry(run.id), true);
    const second = b.claim('worker-b')!;
    assert.equal(second.attempt.number, 2); assert.notEqual(first.attempt.id, second.attempt.id);
    b.finish(second.attempt.id, 'blocked', 'Unavailable'); assert.equal(a.retry(run.id), false);
    assert.equal(a.detail(run.id)?.attempts[0].status, 'interrupted');
  } finally { a.close(); b.close(); }
});
test('evidence references must belong to the current attempt', () => {
  const s = store(); try { s.create(input); const c = s.claim('test')!;
    assert.throws(() => s.assertion({ attemptId: c.attempt.id, specId: 'created', description: 'Check', kind: 'text_visible', expected: 'Project', actual: 'Missing', passed: false, evidenceIds: ['nonexistent'] }), /Invalid evidence/);
    const a = s.artifact(c.attempt.id, 'screenshot', 'missing.png', 'Check');
    s.assertion({ attemptId: c.attempt.id, specId: 'created', description: 'Check', kind: 'text_visible', expected: 'Project', actual: 'Missing', passed: false, evidenceIds: [a.id] });
    assert.equal(s.detail(c.run.id)!.assertions[0].passed, false);
  } finally { s.close(); }
});
test('reports derive passed status from immutable checks and escape hostile target text', () => {
  const s = store(); try {
    const run = s.create({ ...input, brief: '<script>alert(1)</script> project and login' }); const c = s.claim('test')!;
    s.setPlan(c.attempt.id, fixturePlan); s.finish(c.attempt.id, 'passed');
    const d = s.detail(run.id)!;
    assert.equal(reportData(d).outcome, 'blocked');
    assert.match(markdownReport(d), /Outcome: BLOCKED/);
    assert.match(markdownReport(d), /FIXTURE MODE/);
    assert.ok(!htmlReport(d, s.config.artifactDir).includes('<script>'));
    d.run.status = 'failed'; assert.equal(reportData(d).outcome, 'failed');
    d.assertions.push({ id: 'fake', attemptId: c.attempt.id, specId: 'created', description: 'x', kind: 'text_visible', expected: 'x', actual: 'x', passed: true, evidenceIds: ['forged'], createdAt: 0 });
    assert.throws(() => reportData(d), /invalid evidence/);
  } finally { s.close(); }
});
test('dashboard rejects cross-origin writes and nonlocal hosts', () => {
  assert.equal(localRequest(new Request('http://127.0.0.1:3000/api/runs', { method: 'POST', headers: { origin: 'https://evil.test', 'Content-Type': 'application/json' } }), true), false);
  assert.equal(localRequest(new Request('http://evil.test/api/runs')), false);
  assert.equal(localRequest(new Request('http://127.0.0.1:3000/api/runs', { headers: { 'Content-Type': 'application/json', origin: 'http://127.0.0.1:3000' } }), true), true);
});
test('live adapter sends schema, records actual provider metadata, and unwraps decisions', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)); assert.equal(body.response_format.type, 'json_schema'); assert.equal(body.messages[0].role, 'system');
      return Response.json({ model: 'test-actual-model', provider: 'actual-provider', usage: { prompt_tokens: 20, completion_tokens: 12 }, choices: [{ message: { content: JSON.stringify({ action: { type: 'capture', description: 'Collect evidence' } }) } }] });
    };
    const adapter = new LiveAdapter(loadConfig({ MODEL_MODE: 'live', MODEL_PROVIDER: 'local', MODEL_FORMAT: 'json_schema', MODEL_BASE_URL: 'http://127.0.0.1:9999/v1' }));
    const reply = await adapter.request('decision', {}, actionSchema, null, new AbortController().signal);
    assert.equal(reply.provider, 'actual-provider'); assert.equal(reply.model, 'test-actual-model'); assert.equal(reply.inputTokens, 20); assert.equal(actionSchema.parse(reply.value).type, 'capture');
  } finally { globalThis.fetch = original; }
});
