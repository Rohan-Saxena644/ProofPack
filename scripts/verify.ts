import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { unzipSync, strFromU8 } from 'fflate';
import { loadConfig } from '../src/core/config';
import { Store } from '../src/db/store';
import { executeClaim } from '../src/execution/runner';
import { startLaunchDesk } from '../src/launchdesk/server';
import { FixtureAdapter, type Adapter } from '../src/ai/model';
import { htmlReport, markdownReport } from '../src/reports/report';
import { demoScenario } from '../src/core/demo';

const root = path.resolve('data/verification', randomUUID()),
  artifacts = path.join(root, 'artifacts');
await mkdir(root, { recursive: true });
const cfg = loadConfig({
  MODEL_MODE: 'fixture',
  DATABASE_PATH: path.join(root, 'proofpack.sqlite'),
  ARTIFACT_DIR: artifacts,
  ALLOWED_TARGET_ORIGINS:
    'http://127.0.0.1:4200,http://127.0.0.1:4201,http://127.0.0.1:4202,http://127.0.0.1:4203',
  ACTION_TIMEOUT_MS: 2000,
  LEASE_MS: 9000,
});
const store = new Store(cfg),
  working = startLaunchDesk(4200, 'working', path.join(root, 'working.sqlite')),
  broken = startLaunchDesk(4201, 'broken', path.join(root, 'broken.sqlite'));
const input = demoScenario;
const results: { check: string; status: string; runId?: string; assertions?: number }[] = [];
const execute = async (port: number, adapter?: Adapter) => {
  const run = store.create({ ...input, targetUrl: `http://127.0.0.1:${port}` });
  const result = await executeClaim(store, store.claim('verification-worker')!, adapter);
  console.log(`Browser run ${port}: ${result.status}${result.error ? ` — ${result.error}` : ''}`);
  return { ...result, runId: run.id, detail: store.detail(run.id)! };
};
let sinkHits = 0;
const sink = http
  .createServer((_req, res) => {
    sinkHits++;
    res.end('unexpected');
  })
  .listen(4204, '127.0.0.1');
const boundaryTarget = http
  .createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'http://127.0.0.1:4204/secret' });
      return res.end();
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(
      `<body><h1>Boundary check</h1><img src="http://127.0.0.1:4204/leak"><script>fetch('http://127.0.0.1:4204/api');window.open('http://127.0.0.1:4204/popup');new WebSocket('ws://127.0.0.1:4204/socket')</script></body>`,
    );
  })
  .listen(4203, '127.0.0.1');
try {
  const pass = await execute(4200);
  assert.equal(pass.status, 'passed');
  assert.equal(pass.detail.assertions.length, 4);
  assert.ok(pass.detail.events.some((e) => e.type === 'context'));
  results.push({
    check: 'Working persistence, including fresh browser context',
    status: pass.status,
    runId: pass.runId,
    assertions: 4,
  });
  const fail = await execute(4201);
  assert.equal(fail.status, 'failed');
  assert.equal(fail.detail.assertions.find((a) => a.specId === 'persisted')?.passed, false);
  results.push({
    check: 'Broken persistence contradicts the final assertion',
    status: fail.status,
    runId: fail.runId,
    assertions: 4,
  });
  const blocked = await execute(4202);
  assert.equal(blocked.status, 'blocked');
  results.push({ check: 'Unreachable target', status: blocked.status, runId: blocked.runId });
  const invalid = await execute(4200, {
    async request() {
      return {
        value: { type: 'evaluate', code: 'unsafe' },
        provider: 'fixture',
        model: 'invalid-fixture',
      };
    },
  });
  assert.equal(invalid.status, 'blocked');
  assert.equal(invalid.detail.modelCalls.length, 3);
  assert.match(invalid.error!, /3 bounded attempts/);
  results.push({
    check: 'Invalid model output stops after 3 repairs',
    status: invalid.status,
    runId: invalid.runId,
  });
  const fixture = new FixtureAdapter();
  let cancelledRunId = '',
    cancelledStepCount = 0,
    cancelAt = 0;
  const cancelling: Adapter = {
    async request(stage, payload) {
      if (stage === 'decision') {
        cancelledStepCount++;
        if (cancelledStepCount === 2) {
          store.cancel(cancelledRunId);
          cancelAt = store.detail(cancelledRunId)!.events.filter((e) => e.type === 'step').length;
        }
      }
      return fixture.request(stage, payload);
    },
  };
  const cancelRun = store.create({ ...input, targetUrl: 'http://127.0.0.1:4200' });
  cancelledRunId = cancelRun.id;
  const cancelled = await executeClaim(store, store.claim('cancel-worker')!, cancelling);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(
    store.detail(cancelRun.id)!.events.filter((e) => e.type === 'step').length,
    cancelAt,
  );
  results.push({
    check: 'Cancellation stops further browser actions',
    status: cancelled.status,
    runId: cancelRun.id,
  });
  const crashRun = store.create({ ...input, targetUrl: 'http://127.0.0.1:4200' }),
    crashed = store.claim('crashed-worker')!;
  store.reap(crashed.attempt.leaseUntil + 1);
  assert.equal(store.get(crashRun.id)?.status, 'interrupted');
  assert.equal(store.retry(crashRun.id), true);
  const retry = await executeClaim(store, store.claim('replacement-worker')!);
  assert.equal(retry.status, 'passed');
  assert.equal(store.detail(crashRun.id)!.attempts[0].status, 'interrupted');
  assert.ok(store.detail(crashRun.id)!.assertions[0].expected.includes('-a2'));
  results.push({
    check: 'Expired lease preserved, fresh isolated retry passes',
    status: 'passed',
    runId: crashRun.id,
  });
  // Exercise requests, redirects, popups and WebSockets through the same runner.
  const boundaryAdapter: Adapter = {
    async request(stage, payload) {
      if (stage === 'plan')
        return {
          value: {
            name: 'Boundary enforcement',
            variables: ['project'],
            goals: [
              { instruction: 'Inspect the page', assertions: ['page'] },
              { instruction: 'Try a redirect', assertions: [] },
            ],
            assertions: [
              {
                id: 'page',
                description: 'Allowed page is visible',
                kind: 'text_visible',
                expected: 'Boundary check',
              },
            ],
            successCriteria: ['Allowed page visible'],
          },
          provider: 'fixture',
          model: 'boundary-fixture',
        };
      const p = payload as { goalIndex: number; completedAssertions: string[] };
      return {
        value:
          p.goalIndex === 1
            ? { type: 'navigate', url: '/redirect', description: 'Follow redirect' }
            : p.completedAssertions.length
              ? { type: 'complete_goal', description: 'Page checked' }
              : { type: 'assert', assertionId: 'page', description: 'Check allowed page' },
        provider: 'fixture',
        model: 'boundary-fixture',
      };
    },
  };
  const boundary = await execute(4203, boundaryAdapter);
  assert.equal(boundary.status, 'blocked');
  assert.equal(sinkHits, 0, 'Unauthorized requests reached sink');
  assert.ok(boundary.detail.events.some((e) => e.type === 'boundary'));
  results.push({
    check: 'Origin boundary blocks requests, redirect, popup and WebSocket',
    status: 'passed',
    runId: boundary.runId,
  });
  for (const run of [pass, fail]) {
    const html = htmlReport(run.detail, artifacts),
      md = markdownReport(run.detail);
    assert.ok(html.includes('data:image/png;base64,'));
    assert.ok(md.includes(`Outcome: ${run.status.toUpperCase()}`));
    await writeFile(path.join(root, `${run.status}.html`), html);
    await writeFile(path.join(root, `${run.status}.md`), md);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(html);
    assert.ok((await page.locator('img').count()) > 0);
    assert.equal(
      await page
        .locator('img')
        .evaluateAll((images) =>
          images.every(
            (img) =>
              (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0,
          ),
        ),
      true,
    );
    await browser.close();
    assert.ok(run.detail.artifacts.some((a) => a.kind === 'trace'));
    for (const trace of run.detail.artifacts.filter((a) => a.kind === 'trace')) {
      const zip = unzipSync(await readFile(path.join(artifacts, trace.filename)));
      const content = Object.values(zip)
        .map((bytes) => strFromU8(bytes))
        .join('\n');
      assert.ok(!/ld_session=[a-f0-9]{64}/.test(content), 'Trace leaked a session cookie');
    }
  }
  results.push({
    check:
      'HTML embeds loadable screenshots, Markdown matches ledger, finalized traces redact sessions',
    status: 'passed',
  });
  await mkdir('docs/screenshots', { recursive: true });
  for (const [label, r] of [
    ['working', pass],
    ['broken', fail],
  ] as const) {
    const finalCheck = r.detail.assertions.find((a) => a.specId === 'persisted')!;
    const shot = r.detail.artifacts.find((a) => a.id === finalCheck.evidenceIds[0])!;
    await copyFile(
      path.join(artifacts, shot.filename),
      `docs/screenshots/${label}-persistence.png`,
    );
  }
  const summary = {
    verifiedAt: new Date().toISOString(),
    mode: 'fixture',
    directory: root,
    results,
    liveInference:
      'Fixture-only suite; live verification is recorded separately in docs/live-verification-results.json.',
  };
  await writeFile('docs/verification-results.json', JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await working.close();
  await broken.close();
  await new Promise<void>((resolve) => sink.close(() => resolve()));
  await new Promise<void>((resolve) => boundaryTarget.close(() => resolve()));
  store.close();
}
