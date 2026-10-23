import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { loadConfig } from '../src/core/config';
import type { RunDetail, RunDelta } from '../src/core/contracts';
import { Store } from '../src/db/store';
import { startLaunchDesk } from '../src/launchdesk/server';

// Production UI + separate worker + real fixture browser actions. Retention
// ages are deliberately injected only in this isolated database.
const root = path.resolve('data/improvements-e2e', randomUUID()),
  base = 'http://127.0.0.1:3100';
const config = loadConfig({
  MODEL_MODE: 'fixture',
  DATABASE_PATH: path.join(root, 'proofpack.sqlite'),
  ARTIFACT_DIR: path.join(root, 'artifacts'),
  ARCHIVE_DIR: path.join(root, 'archives'),
  RETENTION_DAYS: 1,
  RETENTION_KEEP_RUNS: 1,
  ARCHIVE_RETENTION_DAYS: 1,
  ALLOWED_TARGET_ORIGINS: 'http://127.0.0.1:4500,http://127.0.0.1:4501',
  RUN_TIMEOUT_MS: 45000,
});
const store = new Store(config);
const working = startLaunchDesk(4500, 'working', path.join(root, 'working.sqlite')),
  broken = startLaunchDesk(4501, 'broken', path.join(root, 'broken.sqlite'));
const env = {
  ...process.env,
  MODEL_MODE: 'fixture',
  MODEL_PROVIDER: 'local',
  MODEL_API_KEY: '',
  DATABASE_PATH: config.databasePath,
  ARTIFACT_DIR: config.artifactDir,
  ARCHIVE_DIR: config.archiveDir,
  RETENTION_DAYS: '1',
  RETENTION_KEEP_RUNS: '1',
  ARCHIVE_RETENTION_DAYS: '1',
  ALLOWED_TARGET_ORIGINS: config.ALLOWED_TARGET_ORIGINS,
  RUN_TIMEOUT_MS: '45000',
};
let logs = '';
const children: ChildProcess[] = [];
function child(args: string[]) {
  const processChild = spawn(process.execPath, args, {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(processChild);
  for (const stream of [processChild.stdout, processChild.stderr])
    stream?.on('data', (chunk) => {
      logs = (logs + chunk.toString()).slice(-12000);
    });
  return processChild;
}
child([
  path.resolve('node_modules/next/dist/bin/next'),
  'start',
  '--hostname',
  '127.0.0.1',
  '--port',
  '3100',
]);
child([path.resolve('node_modules/tsx/dist/cli.mjs'), 'src/worker/main.ts']);
const browser = await chromium.launch(),
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const checks: string[] = [],
  errors: string[] = [],
  deltas: RunDelta[] = [];
let fullReads = 0,
  failure: unknown;
page.on('pageerror', (e) => errors.push(e.message));
page.on('response', async (response) => {
  const url = new URL(response.url());
  if (/\/api\/runs\/[a-f0-9-]+$/.test(url.pathname)) fullReads++;
  if (url.pathname.endsWith('/changes') && response.ok())
    try {
      deltas.push(await response.json());
    } catch {}
});
async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let value: T;
  while (Date.now() < deadline) {
    value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Verification timed out.');
}
async function runDetail(id: string) {
  const response = await page.request.get(`${base}/api/runs/${id}`);
  assert.ok(response.ok());
  return (await response.json()) as RunDetail;
}
async function done(id: string) {
  return waitFor(
    () => runDetail(id),
    (d) => !['queued', 'planning', 'running'].includes(d.run.status),
  );
}
async function maintenance(buttonName: string) {
  const response = page.waitForResponse(
    (res) => res.url() === `${base}/api/retention` && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: buttonName, exact: true }).click();
  const posted = await response;
  assert.equal(posted.status(), 202);
  const { id } = await posted.json();
  const job = await waitFor(
    async () => await (await page.request.get(`${base}/api/retention?job=${id}`)).json(),
    (value) => !['queued', 'running'].includes(value.status),
  );
  assert.equal(job.status, 'completed', JSON.stringify(job));
  return job;
}
try {
  await waitFor(
    async () => {
      try {
        return (await page.request.get(`${base}/api/config`)).ok();
      } catch {
        return false;
      }
    },
    Boolean,
    30000,
  );
  await mkdir('docs/screenshots', { recursive: true });
  await page.goto(base);
  await page.getByRole('button', { name: /Try the LaunchDesk scenario/ }).click();
  await page.locator('#target').fill('http://127.0.0.1:4500');
  await page.getByRole('button', { name: /Start demonstration/ }).click();
  await page.waitForURL(/\/runs\/[a-f0-9-]+$/);
  const passId = page.url().split('/').at(-1)!,
    pass = await done(passId);
  assert.equal(pass.run.status, 'passed');
  assert.equal(pass.assertions.filter((a) => a.passed).length, 4);
  await page.locator('.assertion-panel tbody .status-passed').nth(3).waitFor();
  await page.locator('.detail-heading .status-passed').waitFor();
  await page.waitForTimeout(100);
  assert.ok(deltas.length > 0, 'UI did not use incremental responses');
  assert.equal(await page.locator('.timeline-step.running').count(), 0);
  assert.ok(fullReads <= 2, `Unexpected full snapshot requests: ${fullReads}`);
  const stoppedReads = fullReads + deltas.length;
  await page.waitForTimeout(3500);
  assert.equal(fullReads + deltas.length, stoppedReads);
  checks.push(
    'Production run UI uses snapshot + incremental updates, renders all four passing checks, and stops polling at completion',
  );
  const invalid = await page.request.get(`${base}/api/runs/${passId}/changes?after=-1`);
  assert.equal(invalid.status(), 400);
  const empty = (await (
    await page.request.get(`${base}/api/runs/${passId}/changes?after=${pass.cursor}`)
  ).json()) as RunDelta;
  assert.equal(empty.detail.events.length, 0);
  assert.equal(empty.detail.modelCalls.length, 0);
  checks.push(
    'Cursor validation rejects invalid input; unchanged feed returns no repeated event/model history',
  );
  await page.goto(base);
  await page.getByRole('button', { name: /Load broken scenario/ }).click();
  await page.locator('#target').fill('http://127.0.0.1:4501');
  await page.getByRole('button', { name: /Start demonstration/ }).click();
  await page.waitForURL(/\/runs\/[a-f0-9-]+$/);
  const failId = page.url().split('/').at(-1)!;
  assert.equal((await done(failId)).run.status, 'failed');
  await page.getByRole('button', { name: 'Retry in fresh attempt', exact: true }).click();
  await waitFor(
    () => runDetail(failId),
    (d) => d.attempts.length === 2 && !['queued', 'planning', 'running'].includes(d.run.status),
  );
  const failed = await runDetail(failId);
  assert.equal(failed.run.status, 'failed');
  assert.equal(failed.retry?.remaining, 0);
  assert.equal(failed.attempts.length, 2);
  const exhausted = page.getByRole('button', { name: 'Attempt limit reached', exact: true });
  await exhausted.waitFor();
  assert.equal(await exhausted.isDisabled(), true);
  const denied = await page.request.post(`${base}/api/runs/${failId}/retry`, { data: {} });
  assert.equal(denied.status(), 409);
  assert.match((await denied.json()).error, /limit reached/);
  await page.screenshot({ path: 'docs/screenshots/retry-limit.png', fullPage: true });
  checks.push(
    'Actual broken demo retries in a fresh attempt; UI disables exhausted retries and API returns the matching policy',
  );
  store.sqlite
    .prepare('UPDATE runs SET createdAt=?,updatedAt=? WHERE id=?')
    .run(Date.now() - 3 * 86400000, Date.now() - 3 * 86400000, passId);
  await page.goto(`${base}/storage`);
  await page.getByRole('heading', { name: 'Ready to archive' }).waitFor();
  const job = await maintenance('Archive eligible evidence');
  assert.equal(job.result.archived.length, 1);
  assert.equal(job.result.archived[0].runId, passId);
  await page.getByText('1 runs archived · 0 archives expired', { exact: true }).waitFor();
  const archived = await runDetail(passId);
  assert.ok(archived.artifacts.every((a) => a.storage === 'archived'));
  for (const artifact of pass.artifacts)
    await assert.rejects(access(path.join(config.artifactDir, artifact.filename)));
  for (const artifact of archived.artifacts) {
    const response = await page.request.get(`${base}/api/artifacts/${artifact.id}`);
    assert.equal(response.status(), 200);
  }
  const html = await (
    await page.request.get(`${base}/api/runs/${passId}/report?format=html`)
  ).text();
  assert.ok(html.includes('data:image/png;base64,'));
  await page.screenshot({ path: 'docs/screenshots/evidence-storage.png', fullPage: true });
  await page.reload();
  await page.getByText('1 runs archived · 0 archives expired', { exact: true }).waitFor();
  checks.push(
    'Reviewed storage preview queues background archival; actual screenshots/traces remain downloadable and embedded in HTML; maintenance status survives reload',
  );
  store.sqlite
    .prepare('UPDATE evidence_archives SET createdAt=? WHERE runId=?')
    .run(Date.now() - 2 * 86400000, passId);
  await page.getByRole('button', { name: 'Refresh preview', exact: true }).click();
  await page.getByRole('heading', { name: 'Archives ready to expire' }).waitFor();
  const expire = page.getByRole('button', {
    name: 'Archive and expire reviewed evidence',
    exact: true,
  });
  assert.equal(await expire.isDisabled(), true);
  await page
    .getByRole('checkbox', { name: 'I reviewed the archives selected for expiry.' })
    .check();
  const purged = await maintenance('Archive and expire reviewed evidence');
  assert.equal(purged.result.purged.length, 1);
  const expired = await runDetail(passId);
  assert.equal(expired.run.status, 'passed');
  assert.equal(expired.assertions.filter((a) => a.passed).length, 4);
  assert.ok(expired.artifacts.every((a) => a.storage === 'expired'));
  const gone = await page.request.get(`${base}/api/artifacts/${expired.artifacts[0].id}`);
  assert.equal(gone.status(), 410);
  const expiredReport = await (
    await page.request.get(`${base}/api/runs/${passId}/report?format=html`)
  ).text();
  assert.ok(expiredReport.includes('expired under the configured retention policy'));
  assert.ok(expiredReport.includes('PASSED'));
  assert.ok(
    (await runDetail(failId)).artifacts.every((a) => a.storage === 'active'),
    'Recent run evidence was removed',
  );
  checks.push(
    'Expiry requires explicit policy + review, returns HTTP 410 for expired files, preserves historical assertions, and protects the recent broken run',
  );
  const foreign = await page.request.post(`${base}/api/retention`, {
    headers: { origin: 'https://evil.test' },
    data: { token: '0'.repeat(64) },
  });
  assert.equal(foreign.status(), 403);
  const stale = await page.request.post(`${base}/api/retention`, {
    data: { token: '0'.repeat(64) },
  });
  assert.equal(stale.status(), 409);
  checks.push('Retention mutations reject foreign origins and stale preview tokens');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/storage`);
  await page.getByRole('heading', { name: 'Your retention policy' }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'docs/screenshots/evidence-storage-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  checks.push('Storage screen fits 390px and all workflows have zero page exceptions');
} catch (e) {
  failure = e;
  console.error(e instanceof Error ? e.stack : 'Verification error');
} finally {
  await writeFile(
    'docs/improvements-verification.json',
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        mode: 'fixture',
        directory: root,
        note: 'Real production UI, separate worker and real Chromium demo jobs. Only timestamps were intentionally aged to exercise retention in this isolated database.',
        checks,
        passed: !failure,
        deltaResponses: deltas.length,
        fullSnapshotResponses: fullReads,
        error: failure instanceof Error ? failure.message : null,
      },
      null,
      2,
    ) + '\n',
  );
  await browser.close();
  for (const processChild of children) processChild.kill();
  await working.close();
  await broken.close();
  store.close();
}
if (failure) {
  console.error(logs);
  process.exitCode = 1;
} else console.log(JSON.stringify({ checks, deltaResponses: deltas.length }, null, 2));
