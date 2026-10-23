import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import type { RunDetail, Status } from '../src/core/contracts';

const base = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:3000';
const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const browser = await chromium.launch();
const page = await browser.newPage();
let requests = 0,
  active = 0,
  maxConcurrent = 0,
  retry = false,
  progress = 0;
const detail = (status: Status): RunDetail => ({
  run: {
    id,
    targetUrl: 'http://127.0.0.1:4100',
    brief: 'Mocked polling behavior check',
    expected: 'No browser feature claim',
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    mode: 'fixture',
    model: 'mocked-polling',
    provider: 'fixture',
    cancelRequested: false,
    attemptCount: 1,
  },
  attempts: [
    {
      id: 'attempt',
      runId: id,
      number: 1,
      status,
      worker: 'mocked',
      leaseUntil: 0,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      error: 'Mocked response for polling verification',
      plan: null,
    },
  ],
  events: [],
  assertions: [],
  artifacts: [],
  modelCalls: [],
});
try {
  await page.route(`**/api/runs/${id}`, async (route) => {
    requests++;
    active++;
    maxConcurrent = Math.max(maxConcurrent, active);
    // Deliberately slower than the old interval to detect overlapping polls.
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const status = retry
      ? (['queued', 'running', 'cancelled'] as const)[Math.min(progress++, 2)]
      : 'blocked';
    await route.fulfill({ json: detail(status) });
    active--;
  });
  await page.route(`**/api/runs/${id}/retry`, async (route) => {
    retry = true;
    await route.fulfill({ json: { id } });
  });
  await page.goto(`${base}/runs/${id}`);
  await page.getByText('Run blocked.', { exact: true }).waitFor();
  const stopped = requests;
  await page.waitForTimeout(3500);
  assert.equal(requests, stopped, 'Terminal run kept polling');
  const focusResponse = page.waitForResponse((res) => res.url().endsWith(`/api/runs/${id}`));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await focusResponse;
  await page.waitForTimeout(100);
  assert.equal(requests, stopped + 1, 'Focus did not revalidate once');
  await page.getByRole('button', { name: 'Retry in fresh attempt' }).click();
  await page.getByText('Run cancelled.', { exact: true }).waitFor({ timeout: 30000 });
  const finished = requests;
  await page.waitForTimeout(3500);
  assert.equal(requests, finished, 'Retried terminal run kept polling');
  assert.equal(maxConcurrent, 1, 'Slow polls overlapped');
  const result = {
    verifiedAt: new Date().toISOString(),
    note: 'Real Chromium and production UI, explicitly mocked HTTP run responses. No job/model outcome claim.',
    terminalPollingStops: true,
    focusRevalidates: true,
    retryResumesPolling: true,
    maximumConcurrentRequests: maxConcurrent,
    requests,
  };
  await writeFile('docs/polling-verification.json', JSON.stringify(result, null, 2) + '\n');
  console.log(result);
} finally {
  await browser.close();
}
