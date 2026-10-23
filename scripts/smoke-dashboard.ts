import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import type { RunDetail } from '../src/core/contracts';
import { demoScenario } from '../src/core/demo';
import { verifyPersistenceCoverage } from './live-checks';

const base = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:3000';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const configResponse = await page.request.get(`${base}/api/config`);
if (!configResponse.ok()) {
  await browser.close();
  throw new Error('Dashboard configuration is unavailable. Start the dashboard and worker.');
}
const config = (await configResponse.json()) as {
  mode: 'fixture' | 'live';
  provider: string;
  model: string;
  limits: { timeoutMs: number };
};
const liveMode = config.mode === 'live';
const shotPrefix = liveMode ? 'live-' : '';
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const checks: string[] = [];
const resumePass = process.argv.find((arg) => arg.startsWith('--resume-pass='))?.split('=')[1];
const retryRun = process.argv.find((arg) => arg.startsWith('--retry-run='))?.split('=')[1];
for (const id of [resumePass, retryRun])
  if (id && !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid saved run identifier.');
async function waitForRun(id: string) {
  const deadline = Date.now() + config.limits.timeoutMs + 30000;
  while (Date.now() < deadline) {
    const response = await page.request.get(`${base}/api/runs/${id}`);
    assert.ok(response.ok());
    const detail = (await response.json()) as RunDetail;
    if (!['queued', 'planning', 'running'].includes(detail.run.status)) return detail;
    await page.waitForTimeout(500);
  }
  throw new Error(
    'Dashboard job did not finish within its configured timeout. Check the separate worker.',
  );
}
try {
  await mkdir('docs/screenshots', { recursive: true });
  await page.goto(base);
  if (resumePass) await page.goto(`${base}/runs/${resumePass}`);
  else {
    await page.getByRole('button', { name: /Try the LaunchDesk scenario/ }).click();
    assert.equal(await page.locator('#target').inputValue(), 'http://127.0.0.1:4100');
    await page.getByRole('button', { name: /Start demonstration/ }).click();
    await page.waitForURL(/\/runs\/[a-f0-9-]+$/);
  }
  const passId = page.url().split('/').at(-1)!;
  const pass = await waitForRun(passId);
  assert.equal(pass.run.status, 'passed');
  assert.equal(pass.run.mode, config.mode);
  assert.equal(pass.run.provider, config.provider);
  assert.equal(pass.run.model, config.model);
  if (liveMode) verifyPersistenceCoverage(pass);
  else assert.equal(pass.assertions.length, 4);
  checks.push(
    resumePass
      ? 'Saved passing run revalidated, including live persistence coverage'
      : 'New-run form → persisted queue → separate worker → passing run details',
  );
  await page.getByRole('link', { name: 'Evidence report', exact: true }).click();
  await page.waitForURL(/\/report$/);
  await page.getByRole('heading', { name: 'What was requested' }).waitFor();
  await page.screenshot({
    path: `docs/screenshots/${shotPrefix}evidence-report.png`,
    fullPage: true,
  });
  const html = await page.request.get(`${base}/api/runs/${passId}/report?format=html`);
  assert.ok(html.ok());
  assert.ok((await html.text()).includes('data:image/png;base64,'));
  const md = await page.request.get(`${base}/api/runs/${passId}/report?format=md`);
  assert.match(await md.text(), /Outcome: PASSED/);
  const trace = pass.artifacts.find((a) => a.kind === 'trace')!;
  const zip = await page.request.get(`${base}/api/artifacts/${trace.id}`);
  assert.ok(zip.ok());
  assert.equal(zip.headers()['content-type'], 'application/zip');
  checks.push('Report screen, masked evidence endpoints, HTML/Markdown exports and trace download');
  await page.goto(base);
  if (retryRun) {
    await page.goto(`${base}/runs/${retryRun}`);
    const response = page.waitForResponse(
      (res) =>
        res.url().endsWith(`/api/runs/${retryRun}/retry`) && res.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Retry in fresh attempt' }).click();
    assert.ok((await response).ok());
  } else {
    await page.getByRole('button', { name: /Load broken scenario/ }).click();
    await page.getByRole('button', { name: /Start demonstration/ }).click();
    await page.waitForURL(/\/runs\/[a-f0-9-]+$/);
  }
  const failId = page.url().split('/').at(-1)!,
    fail = await waitForRun(failId);
  assert.equal(fail.run.status, 'failed');
  if (liveMode) verifyPersistenceCoverage(fail);
  else assert.equal(fail.assertions.find((a) => a.specId === 'persisted')?.passed, false);
  if (retryRun) {
    assert.ok(fail.attempts.length >= 2);
    assert.equal(fail.attempts[0].status, 'blocked');
    checks.push(
      'Explicit UI retry preserves the original blocked attempt and uses fresh test data',
    );
  }
  checks.push('Broken demo → failed assertion and actual failure evidence');
  const cancelResponse = await page.request.post(`${base}/api/runs`, {
    data: {
      targetUrl: 'http://127.0.0.1:4100',
      ...demoScenario,
    },
  });
  const cancelId = (await cancelResponse.json()).id;
  const cancel = await page.request.post(`${base}/api/runs/${cancelId}/cancel`, { data: {} });
  assert.ok(cancel.ok());
  assert.equal((await waitForRun(cancelId)).run.status, 'cancelled');
  checks.push('HTTP cancellation reaches the worker / queued state');
  const denied = await page.request.post(`${base}/api/runs`, {
    data: {
      targetUrl: 'http://169.254.169.254',
      brief: 'Register and create a project then log in',
      expected: 'Project persists after login',
    },
  });
  assert.equal(denied.status(), 400);
  const crossOrigin = await page.request.post(`${base}/api/runs`, {
    headers: { origin: 'https://evil.test' },
    data: {},
  });
  assert.equal(crossOrigin.status(), 403);
  checks.push('API rejects forbidden targets and cross-origin writes');
  await page.goto(base);
  await page.getByRole('heading', { name: /Recent runs/ }).waitFor();
  await page.locator('.runs-table tbody tr').first().waitFor();
  await page
    .getByRole('heading', {
      name: liveMode
        ? config.provider === 'groq'
          ? 'Groq model'
          : config.provider === 'local'
            ? 'Local model'
            : 'OpenRouter model'
        : 'Fixture mode',
      exact: true,
    })
    .waitFor();
  await page.screenshot({ path: `docs/screenshots/${shotPrefix}dashboard.png`, fullPage: true });
  assert.ok((await page.locator('.runs-table tbody tr').count()) >= 3);
  checks.push('History shows persisted working, broken and cancelled runs');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `docs/screenshots/${shotPrefix}mobile.png`, fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  checks.push('390px mobile layout has no horizontal page overflow');
  assert.deepEqual(errors, []);
  checks.push('No browser page errors during dashboard workflow');
  await writeFile(
    `docs/${shotPrefix}dashboard-verification.json`,
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        mode: config.mode,
        provider: config.provider,
        model: config.model,
        base,
        passId,
        failId,
        reusedPassId: resumePass ?? null,
        retriedRunId: retryRun ?? null,
        checks,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ passId, failId, checks }, null, 2));
} finally {
  await browser.close();
}
