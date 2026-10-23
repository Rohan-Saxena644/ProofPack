import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/core/config';
import { demoScenario } from '../src/core/demo';
import { Store } from '../src/db/store';
import { executeClaim } from '../src/execution/runner';
import { startLaunchDesk } from '../src/launchdesk/server';
import { verifyPersistenceCoverage } from './live-checks';

const base = loadConfig();
assert.equal(base.MODEL_MODE, 'live', 'Explicit live mode required.');
const root = path.resolve('data/performance-live', randomUUID());
const cfg = loadConfig({
  DATABASE_PATH: path.join(root, 'proofpack.sqlite'),
  ARTIFACT_DIR: path.join(root, 'artifacts'),
  ALLOWED_TARGET_ORIGINS: 'http://127.0.0.1:4400,http://127.0.0.1:4401',
});
const store = new Store(cfg);
const working = startLaunchDesk(4400, 'working', path.join(root, 'working.sqlite'));
const broken = startLaunchDesk(4401, 'broken', path.join(root, 'broken.sqlite'));
const results = [];
let failed = false;
try {
  for (const [port, expected] of [
    [4400, 'passed'],
    [4401, 'failed'],
  ] as const) {
    const run = store.create({ ...demoScenario, targetUrl: `http://127.0.0.1:${port}` });
    const claim = store.claim('efficiency-live');
    if (!claim) {
      failed = true;
      results.push({
        runId: run.id,
        expected,
        status: 'queued',
        verified: false,
        error:
          store.quotaWait()?.reason ??
          'No worker claim available. No inference request dispatched.',
        durationMs: 0,
        assertionsPassed: 0,
        assertionsTotal: 0,
        modelCalls: 0,
        rateLimitedAttempts: 0,
        reportedInputTokens: 0,
        reportedOutputTokens: 0,
      });
      continue;
    }
    const outcome = await executeClaim(store, claim);
    const detail = store.detail(run.id)!;
    let verified = false;
    try {
      assert.equal(outcome.status, expected);
      verifyPersistenceCoverage(detail);
      verified = true;
    } catch {
      failed = true;
    }
    const attempt = detail.attempts[0];
    const result = {
      runId: run.id,
      expected,
      status: outcome.status,
      verified,
      error: outcome.error,
      durationMs: attempt.finishedAt! - attempt.startedAt,
      assertionsPassed: detail.assertions.filter((a) => a.passed).length,
      assertionsTotal: detail.assertions.length,
      modelCalls: detail.modelCalls.length,
      rateLimitedAttempts: detail.modelCalls.filter((c) => c.error?.includes('HTTP 429')).length,
      reportedInputTokens: detail.modelCalls.reduce((n, c) => n + (c.inputTokens ?? 0), 0),
      reportedOutputTokens: detail.modelCalls.reduce((n, c) => n + (c.outputTokens ?? 0), 0),
    };
    results.push(result);
    console.log(result);
  }
} finally {
  await writeFile(
    'docs/scheduler-live-verification.json',
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        mode: 'live',
        provider: cfg.MODEL_PROVIDER,
        model: cfg.MODEL_ID,
        directory: root,
        note: 'Fresh real Chromium persistence runs using shared provider scheduling. A quota-blocked run and a deferred queued run do not establish complete persistence coverage. Not a controlled timing benchmark; provider limits and model decisions vary.',
        results,
      },
      null,
      2,
    ) + '\n',
  );
  await working.close();
  await broken.close();
  store.close();
}
if (failed) process.exitCode = 1;
