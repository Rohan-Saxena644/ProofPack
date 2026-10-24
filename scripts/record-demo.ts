import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, type Frame, type Locator } from 'playwright';
import type { RunDetail } from '../src/core/contracts';
import { verifyPersistenceCoverage } from './live-checks';

// Recording tooling only. Product routes, outcomes and source are not modified.
const base = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:3000';
const output = path.resolve(process.env.DEMO_VIDEO_DIR ?? 'data/demo-video');
const encoder = path.resolve(process.env.DEMO_FFMPEG ?? 'data/video-tools/ffmpeg.exe');
const rehearsal = process.argv.includes('--rehearse');
const passId = '6e3eba31-41b8-4b3a-9293-c0b9d151a80d';
const failId = '7f95e3c0-ef72-4eab-aa90-0bb2298cf1a7';
type Scene = { id: string; title: string; caption: string; narration: string };
type Chapter = Scene & { start: number; end: number; speechSeconds: number };
const scenes = JSON.parse(await readFile('docs/video-scenes.json', 'utf8')) as Scene[];
await mkdir(path.join(output, 'raw'), { recursive: true });
await mkdir(path.join(output, 'frames'), { recursive: true });
async function json<T>(url: string): Promise<T> {
  const response = await fetch(base + url);
  assert.equal(response.status, 200, `Unavailable recording source: ${url}`);
  return response.json() as Promise<T>;
}
const [passing, failing] = await Promise.all([
  json<RunDetail>(`/api/runs/${passId}`),
  json<RunDetail>(`/api/runs/${failId}`),
]);
assert.equal(passing.run.status, 'passed');
assert.equal(failing.run.status, 'failed');
const passCheck = verifyPersistenceCoverage(passing);
const failCheck = verifyPersistenceCoverage(failing);
const before = await json<{ id: string }[]>('/api/runs');
assert.ok(
  !before.some(
    (r) => 'status' in r && ['queued', 'planning', 'running'].includes(String(r.status)),
  ),
  'Record only while the worker is idle.',
);
const speechSeconds = async (id: string) => {
  const wav = await readFile(path.join(output, `${id}.wav`));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  let byteRate = 0,
    bytes = 0;
  for (let at = 12; at + 8 <= wav.length;) {
    const size = wav.readUInt32LE(at + 4);
    const kind = wav.toString('ascii', at, at + 4);
    if (kind === 'fmt ') byteRate = wav.readUInt32LE(at + 16);
    if (kind === 'data') bytes = size;
    at += size + 8 + (size % 2);
  }
  assert.ok(byteRate > 0 && bytes > 0, 'Narration WAV must contain audio.');
  return bytes / byteRate;
};
for (const scene of scenes) await speechSeconds(scene.id);
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 1,
  recordVideo: { dir: path.join(output, 'raw'), size: { width: 1600, height: 900 } },
  acceptDownloads: true,
});
const page = await context.newPage();
const captureOrigin = performance.now();
const clock = () => (performance.now() - captureOrigin) / 1000;
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const writes: string[] = [];
page.on('request', (r) => {
  if (r.method() !== 'GET') writes.push(`${r.method()} ${r.url()}`);
});
const chapters: Chapter[] = [];
let frame: Frame;
async function app(url: string) {
  await page.locator('#product').evaluate((el, target) => {
    const iframe = el as HTMLIFrameElement;
    iframe.removeAttribute('srcdoc');
    iframe.src = target;
  }, base + url);
  await page.waitForTimeout(500);
  frame = page.frame({ name: 'product' })!;
  assert.ok(frame);
  await frame.waitForURL(base + url);
  await frame.locator('.brand').waitFor();
}
async function focus(locator: Locator, position: 'start' | 'center' = 'center') {
  await locator.evaluate((el, block) => el.scrollIntoView({ block, behavior: 'smooth' }), position);
  await page.waitForTimeout(800);
}
async function top() {
  await frame.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await page.waitForTimeout(650);
}
async function scene(id: string, action?: () => Promise<void>) {
  const item = scenes.find((s) => s.id === id)!;
  const start = clock();
  await page.evaluate(
    ({ title, caption, index, total }) => {
      document.querySelector('#title')!.textContent = title;
      document.querySelector('#caption')!.textContent = caption;
      document.querySelector('#count')!.textContent =
        `${String(index + 1).padStart(2, '0')} / ${total}`;
      (document.querySelector('#progress') as HTMLElement).style.width =
        `${((index + 1) / total) * 100}%`;
    },
    { ...item, index: scenes.indexOf(item), total: scenes.length },
  );
  const duration = await speechSeconds(id);
  console.log(`Recording ${id}`);
  if (action) await action();
  const hold = (rehearsal ? 0 : Math.max(7, duration + 1.5)) - (clock() - start);
  if (hold > 0) await page.waitForTimeout(hold * 1000);
  await page.screenshot({ path: path.join(output, 'frames', `${id}.png`) });
  chapters.push({ ...item, start, end: clock(), speechSeconds: duration });
}
try {
  await page.setContent(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ProofPack demo recording</title><style>*{box-sizing:border-box}body{margin:0;background:#10182a;color:#fff;font-family:'Segoe UI',Arial,sans-serif}.bar{height:38px;display:flex;justify-content:space-between;align-items:center;padding:0 28px;font-size:12px;letter-spacing:1.2px;color:#b9c6dd}.bar strong{color:white}iframe{display:block;border:0;width:1600px;height:728px;background:#f8f7f4}.caption{height:130px;padding:18px 34px;display:flex;justify-content:space-between;align-items:center;gap:30px}h2{font-size:15px;color:#9eb8ff;margin:0 0 9px;letter-spacing:1px}p{font-size:25px;margin:0;line-height:1.35;max-width:1370px}#count{color:#8393ad;font-size:15px;font-variant-numeric:tabular-nums;white-space:nowrap}.track{height:4px;background:#24304a}#progress{height:4px;background:#7e9dff;width:0;transition:width 500ms}</style></head><body><div class="bar"><strong>PROOFPACK · LOCAL SOFTWARE DEMO</strong><span>ACTUAL APP · PREVIOUSLY RECORDED GROQ RUNS · SYNTHETIC NARRATION</span></div><iframe id="product" name="product" title="Actual ProofPack application" src="${base}"></iframe><div class="caption"><div><h2 id="title">ProofPack</h2><p id="caption">Loading the local application…</p></div><div id="count"></div></div><div class="track"><div id="progress"></div></div></body></html>`,
  );
  frame = page.frame({ name: 'product' })!;
  await frame.locator('.model-name').getByText('openai/gpt-oss-120b', { exact: true }).waitFor();
  await scene('intro');
  await scene('brief', async () => {
    await frame.getByRole('button', { name: /Try the LaunchDesk scenario/ }).click();
    await focus(frame.locator('.new-run-panel'), 'start');
    assert.ok((await frame.locator('#brief').inputValue()).length > 12);
  });
  await scene('live', async () => {
    await focus(frame.locator('.model-panel'), 'start');
  });
  await scene('pass', async () => {
    await app(`/runs/${passId}`);
    await frame.getByRole('heading', { name: 'Assertion ledger', exact: true }).waitFor();
    await focus(frame.locator('.assertion-panel'));
  });
  await scene('timeline', async () => {
    await focus(frame.locator('.timeline-panel'), 'start');
  });
  await scene('pass-evidence', async () => {
    await frame.goto(base + '/api/artifacts/' + passCheck.evidenceIds[0]);
    await frame.locator('img').waitFor();
    assert.ok(
      await frame.locator('img').evaluate((el) => (el as HTMLImageElement).naturalWidth > 0),
    );
  });
  await scene('fail', async () => {
    await app(`/runs/${failId}`);
    await frame.getByRole('heading', { name: 'Assertion ledger', exact: true }).waitFor();
    await focus(frame.locator('.assertion-panel'));
  });
  await scene('fail-evidence', async () => {
    await frame.goto(base + '/api/artifacts/' + failCheck.evidenceIds[0]);
    await frame.locator('img').waitFor();
  });
  await scene('attempts', async () => {
    await app(`/runs/${failId}`);
    await frame.getByRole('button', { name: 'Attempt limit reached' }).waitFor();
    assert.ok(await frame.getByRole('button', { name: 'Attempt limit reached' }).isDisabled());
    await focus(frame.locator('.metadata-panel'), 'start');
  });
  await scene('export', async () => {
    await app(`/runs/${passId}/report`);
    await frame.getByRole('heading', { name: 'What was requested', exact: true }).waitFor();
    await top();
    const download = page.waitForEvent('download');
    await frame.getByRole('link', { name: 'Export HTML', exact: true }).click();
    await (await download).saveAs(path.join(output, 'proofpack-working-report.html'));
    const markdown = page.waitForEvent('download');
    await frame.getByRole('link', { name: 'Markdown', exact: true }).click();
    await (await markdown).saveAs(path.join(output, 'proofpack-working-report.md'));
    const trace = passing.artifacts.filter((a) => a.kind === 'trace').at(-1)!;
    const response = await page.request.get(base + '/api/artifacts/' + trace.id);
    assert.equal(response.status(), 200);
    const zip = await response.body();
    assert.equal(zip.toString('ascii', 0, 2), 'PK');
    await writeFile(path.join(output, 'proofpack-browser-trace.zip'), zip);
  });
  await scene('standalone', async () => {
    const html = await readFile(path.join(output, 'proofpack-working-report.html'), 'utf8');
    assert.ok(html.includes('data:image/png;base64,'));
    await page.locator('#product').evaluate((el, content) => {
      (el as HTMLIFrameElement).srcdoc = content;
    }, html);
    await page.waitForTimeout(700);
    frame = page.frame({ name: 'product' })!;
    await frame.getByRole('heading', { name: 'Assertion ledger', exact: true }).waitFor();
    await focus(frame.getByRole('heading', { name: 'Assertion ledger', exact: true }), 'start');
    const images = await frame
      .locator('img')
      .evaluateAll((imgs) =>
        imgs.map((img) => ({
          complete: (img as HTMLImageElement).complete,
          width: (img as HTMLImageElement).naturalWidth,
        })),
      );
    assert.ok(images.length > 0 && images.every((img) => img.complete && img.width > 0));
  });
  await scene('storage', async () => {
    await app('/storage');
    await frame.getByText('Retention is off.', { exact: false }).waitFor();
  });
  await scene('architecture', async () => {
    await app('/');
    await frame.locator('.model-name').getByText('openai/gpt-oss-120b', { exact: true }).waitFor();
    await top();
  });
  await scene('closing');
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, []);
  const after = await json<{ id: string }[]>('/api/runs');
  assert.deepEqual(
    after.map((r) => r.id),
    before.map((r) => r.id),
  );
  const video = page.video()!;
  const captureEnd = clock();
  await context.close();
  const raw = await video.path();
  await copyFile(raw, path.join(output, 'proofpack-demo-raw.webm'));
  await writeFile(
    path.join(output, 'chapters.json'),
    JSON.stringify({ captureEnd, chapters }, null, 2) + '\n',
  );
  if (rehearsal) {
    console.log('Rehearsal passed: actual UI, saved evidence, exports and captions verified.');
  } else {
    const start = chapters[0].start,
      end = chapters.at(-1)!.end;
    const inputs = ['-hide_banner', '-y', '-i', raw];
    const filters: string[] = [];
    chapters.forEach((chapter, i) => {
      inputs.push('-i', path.join(output, `${chapter.id}.wav`));
      filters.push(`[${i + 1}:a]adelay=${Math.round((chapter.start + 0.35) * 1000)}:all=1[a${i}]`);
    });
    filters.push(
      `${chapters.map((_, i) => `[a${i}]`).join('')}amix=inputs=${chapters.length}:normalize=0:duration=longest,apad=whole_dur=${end}[voice]`,
    );
    const mp4 = path.join(output, 'proofpack-demo.mp4');
    execFileSync(
      encoder,
      [
        ...inputs,
        '-filter_complex',
        filters.join(';'),
        '-map',
        '0:v',
        '-map',
        '[voice]',
        '-ss',
        String(start),
        '-t',
        String(end - start),
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-r',
        '25',
        '-c:a',
        'aac',
        '-b:a',
        '160k',
        '-movflags',
        '+faststart',
        mp4,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 4 * 1024 * 1024 },
    );
    await writeFile(
      'docs/video-verification.json',
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          source:
            'Actual production UI and saved Groq inference/browser evidence; no new run or inference submitted',
          passId,
          failId,
          passAssertions: '4/4',
          failAssertions: '3/4; final persistence assertion failed',
          narration: 'Offline synthetic speech: Microsoft David Desktop',
          presentation:
            'Captioned recording frame surrounding the unchanged product UI; exported HTML rendered independently from its downloaded contents',
          mp4,
          durationSeconds: end - start,
          width: 1600,
          height: 900,
          scenes: chapters.length,
          browserErrors: errors,
          mutations: writes,
          historyUnchanged: true,
          checks: [
            'Actual saved live coverage validated before recording',
            'Passing and failing screenshots loaded',
            'Retry limit disabled',
            'HTML and Markdown downloaded',
            'Trace ZIP downloaded',
            'All screenshots in standalone exported HTML loaded',
            'Retention remained disabled',
            'No new browser job, model request, retention mutation or fixture fallback',
          ],
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`Video complete: ${mp4}`);
  }
} finally {
  await browser.close();
}
