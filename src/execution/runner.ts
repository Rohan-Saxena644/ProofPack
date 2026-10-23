import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import type { Store } from '../db/store';
import { ModelSession, type Adapter } from '../ai/model';
import type { Action, Observation, Status } from '../core/contracts';
import { allowedUrl, requireAllowed, safeUrl } from './boundaries';
import { observe, resolveControl } from './observe';
import { boundaryProxy } from './proxy';

export class AssertionFailure extends Error {}
export function assertionOutcome(requiredIds: string[], results: { specId: string; passed: boolean }[]): 'passed' | 'failed' | 'blocked' {
  if (results.some(a => !a.passed)) return 'failed';
  return requiredIds.length > 0 && requiredIds.every(id => results.some(a => a.specId === id && a.passed)) ? 'passed' : 'blocked';
}
export async function executeClaim(store: Store, claim: NonNullable<ReturnType<Store['claim']>>, adapter?: Adapter, externalSignal?: AbortSignal) {
  const { run, attempt } = claim, cfg = store.config;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(cfg.RUN_TIMEOUT_MS), ...(externalSignal ? [externalSignal] : [])]);
  const suffix = `${run.id.slice(0, 8)}-a${attempt.number}`;
  const values = { email: `proof-${suffix}@example.test`, password: randomBytes(24).toString('base64url'), project: `Moonbase-${suffix}` };
  const redact = (s: string) => s.replaceAll(values.password, '[REDACTED]').replaceAll(cfg.MODEL_API_KEY || '\u0000', '[REDACTED]');
  const expand = (s: string) => s.replace(/\{\{(email|password|project)\}\}/g, (_, key: keyof typeof values) => values[key]);
  const clean = (data: Record<string, unknown>) => JSON.parse(redact(JSON.stringify(data))) as Record<string, unknown>;
  const event = (type: string, description: string, data: Record<string, unknown> = {}) => store.event(attempt.id, type, redact(description), clean(data));
  let browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined, contextNumber = 0;
  let proxy: Awaited<ReturnType<typeof boundaryProxy>> | undefined;
  let lostLease = false, actionCount = 0, status: Status = 'blocked', error: string | null = null;
  const check = () => {
    if (store.get(run.id)?.cancelRequested) controller.abort(new Error('Run cancelled by user.'));
    if (lostLease || !store.active(attempt.id)) controller.abort(new Error('Worker lost its lease.'));
    signal.throwIfAborted();
  };
  const heartbeat = setInterval(() => {
    try { if (!store.heartbeat(attempt.id)) lostLease = true; check(); }
    catch { controller.abort(new Error('Worker could not renew its lease or the run was stopped.')); }
  }, Math.max(100, Math.floor(cfg.LEASE_MS / 3)));
  const abortBrowser = () => { void browser?.close().catch(() => {}); };
  signal.addEventListener('abort', abortBrowser);
  const artifactRoot = path.join(cfg.artifactDir, run.id, attempt.id);
  const screenshot = async (label: string) => {
    if (!page || page.isClosed()) return null;
    const filename = `${randomUUID()}.png`, absolute = path.join(artifactRoot, filename);
    await page.screenshot({ path: absolute, fullPage: true, timeout: cfg.ACTION_TIMEOUT_MS, mask: [page.locator('input[type="password"]')], animations: 'disabled' });
    return store.artifact(attempt.id, 'screenshot', path.relative(cfg.artifactDir, absolute), redact(label));
  };
  const finalizeContext = async () => {
    if (!context) return;
    const current = context; context = undefined;
    const traceFile = path.join(artifactRoot, `trace-${contextNumber}.zip`);
    try {
      await current.tracing.stop({ path: traceFile });
      // Trace JSON can contain fill arguments, POST bodies and cookies. Remove synthetic
      // password/API key and session headers before the trace becomes downloadable.
      const zip = unzipSync(await readFile(traceFile));
      for (const [name, bytes] of Object.entries(zip)) {
        if (name.endsWith('.trace') || name.endsWith('.network') || name.endsWith('.stacks')) {
          zip[name] = strToU8(redact(strFromU8(bytes)).replace(/("(?:cookie|set-cookie|authorization|ld_session)"\s*,\s*"value"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"'));
        }
      }
      await writeFile(traceFile, zipSync(zip));
      store.artifact(attempt.id, 'trace', path.relative(cfg.artifactDir, traceFile), `Browser context ${contextNumber} trace`);
    } catch { await rm(traceFile, { force: true }).catch(() => {}); event('warning', 'Trace could not be finalized for this browser context.'); }
    await current.close().catch(() => {});
  };
  const newContext = async () => {
    check(); contextNumber++;
    context = await browser!.newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1365, height: 900 } });
    context.setDefaultTimeout(cfg.ACTION_TIMEOUT_MS); context.setDefaultNavigationTimeout(cfg.ACTION_TIMEOUT_MS);
    await context.route('**/*', route => allowedUrl(route.request().url(), cfg.origins) ? route.continue() : (event('boundary', 'Blocked a request outside the allowed application origins.', { url: safeUrl(route.request().url()) }), route.abort('blockedbyclient')));
    await context.routeWebSocket(/.*/, socket => { event('boundary', 'WebSocket connections are unsupported and blocked.'); socket.close(); });
    await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
    page = await context.newPage();
    context.on('page', popup => { if (popup !== page) { event('boundary', 'Popup was blocked.'); void popup.close(); } });
    page.on('dialog', dialog => { void dialog.dismiss(); });
    page.on('console', msg => { if (msg.type() === 'error') event('console_error', 'Browser console error', { message: redact(msg.text()).slice(0, 1200) }); });
    page.on('pageerror', e => event('page_error', 'Unhandled page error', { message: redact(e.message).slice(0, 1200) }));
    page.on('requestfailed', req => event('request_failed', 'Browser request failed', { url: safeUrl(req.url()), message: req.failure()?.errorText }));
    return page;
  };
  try {
    requireAllowed(run.targetUrl, cfg.origins); await mkdir(artifactRoot, { recursive: true });
    if (run.mode !== cfg.MODEL_MODE || run.model !== (cfg.MODEL_MODE === 'fixture' ? 'launchdesk-fixture-v1' : cfg.MODEL_ID) || run.provider !== (cfg.MODEL_MODE === 'fixture' ? 'fixture' : cfg.MODEL_PROVIDER)) throw new Error('Worker model configuration differs from the queued run. Restart both processes with the same configuration.');
    const model = new ModelSession(cfg, store, attempt.id, signal, adapter);
    event('planning', `Planning with ${run.mode} model mode`);
    const plan = await model.plan({ targetUrl: run.targetUrl, brief: run.brief, expected: run.expected }); check();
    if (plan.assertions.some(a => a.expected.includes('{{password}}'))) throw new Error('Assertions cannot include secrets.');
    store.setPlan(attempt.id, plan); event('plan', plan.name, { goals: plan.goals, successCriteria: plan.successCriteria });
    proxy = await boundaryProxy(cfg.origins, url => event('boundary', 'Origin proxy blocked a destination.', { url }));
    browser = await chromium.launch({ headless: true, proxy: { server: proxy.url }, args: ['--proxy-bypass-list=<-loopback>', '--disable-background-networking', '--disable-quic', '--disable-features=MediaRouter', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
    check(); await newContext();
    const initialResponse = await page!.goto(run.targetUrl, { waitUntil: 'domcontentloaded' });
    if (!initialResponse || initialResponse.status() >= 500) throw new Error('Target application is unavailable.');
    requireAllowed(page!.url(), cfg.origins);
    await screenshot('Target application opened');
    const completedAssertions: string[] = [];
    for (let goalIndex = 0; goalIndex < plan.goals.length; goalIndex++) {
      const goal = plan.goals[goalIndex], history: Action[] = [];
      event('goal', goal.instruction);
      for (;;) {
        check();
        if (actionCount >= cfg.MAX_ACTIONS) throw new Error('Total action limit reached.');
        requireAllowed(page!.url(), cfg.origins);
        const observation: Observation = await observe(page!, redact);
        const action = await model.decision({ goalIndex, goal, observation, history, completedAssertions, plan }, a => {
          if ('controlId' in a && !observation.controls.some(c => c.id === a.controlId)) throw new Error('Choose a controlId from the current observation.');
          if (a.type === 'assert' && (!goal.assertions.includes(a.assertionId) || completedAssertions.includes(a.assertionId))) throw new Error('Choose an unexecuted assertion assigned to this goal.');
          if (a.type === 'complete_goal' && goal.assertions.some(id => !completedAssertions.includes(id))) throw new Error('Execute every required goal assertion before completing the goal.');
          if (a.type === 'navigate') requireAllowed(new URL(a.url, run.targetUrl).href, cfg.origins);
          if (a.type === 'fill') {
            const c = observation.controls.find(c => c.id === a.controlId)!;
            if (c.secret && a.value !== '{{password}}') throw new Error('Secret fields must use {{password}}.');
            if (!c.secret && a.value.includes('{{password}}')) throw new Error('Password may only be filled into a password field.');
          }
        });
        check(); actionCount++;
        const safeAction = action.type === 'fill' ? { ...action, value: action.value === '{{password}}' ? '[REDACTED]' : redact(expand(action.value)) } : action;
        const stepData: Record<string, unknown> = { action: safeAction, url: safeUrl(page!.url()), goalIndex, evidenceIds: [] };
        const stepId = store.event(attempt.id, 'step', redact(action.description), clean(stepData), 'running');
        try {
          if (action.type === 'complete_goal') { store.endEvent(stepId, 'passed', clean(stepData)); break; }
          if (action.type === 'navigate') await page!.goto(new URL(action.url, run.targetUrl).href, { waitUntil: 'domcontentloaded' });
          if (action.type === 'fresh_context') { await finalizeContext(); await newContext(); await page!.goto(new URL('/login', run.targetUrl).href, { waitUntil: 'domcontentloaded' }); event('context', 'Started a fresh context with no cookies or storage.'); }
          if ('controlId' in action) {
            const control = observation.controls.find(c => c.id === action.controlId)!;
            let resolved = resolveControl(page!, control);
            if (await resolved.locator.count() !== 1 && control.testId) resolved = { locator: page!.getByTestId(control.testId), description: `testId=${control.testId}` };
            if (await resolved.locator.count() !== 1) throw new Error('Observed control is unresolved or ambiguous. No state-changing retry was attempted.');
            stepData.locator = resolved.description;
            if (action.type === 'fill') await resolved.locator.fill(expand(action.value));
            if (action.type === 'select') await resolved.locator.selectOption(expand(action.value));
            if (action.type === 'click') {
              await resolved.locator.click();
              await page!.waitForLoadState('domcontentloaded');
            }
          }
          if (action.type === 'assert') {
            const spec = plan.assertions.find(a => a.id === action.assertionId)!;
            const expected = expand(spec.expected); let passed = false, actual = '';
            if (spec.kind === 'text_visible') {
              try { await page!.getByText(expected, { exact: true }).first().waitFor({ state: 'visible', timeout: cfg.ACTION_TIMEOUT_MS }); passed = true; actual = `Visible text: ${expected}`; }
              catch { check(); if (page!.isClosed()) throw new Error('Page closed before assertion could be established.'); actual = `Expected text was not visible at ${safeUrl(page!.url())}`; }
            } else {
              const expectedUrl = new URL(expected, run.targetUrl).href; requireAllowed(expectedUrl, cfg.origins);
              try { await page!.waitForURL(u => u.href === expectedUrl, { timeout: cfg.ACTION_TIMEOUT_MS }); passed = true; } catch { check(); }
              actual = safeUrl(page!.url());
            }
            const evidence = await screenshot(spec.description); const evidenceIds = evidence ? [evidence.id] : [];
            store.assertion({ attemptId: attempt.id, specId: spec.id, description: redact(spec.description), kind: spec.kind, expected: redact(expected), actual: redact(actual), passed, evidenceIds });
            completedAssertions.push(spec.id); Object.assign(stepData, { assertion: { id: spec.id, expected: redact(expected), actual: redact(actual), passed }, evidenceIds });
            if (!passed) throw new AssertionFailure(`Assertion contradicted: ${spec.description}. ${actual}`);
          } else if (['click', 'capture', 'fresh_context'].includes(action.type)) {
            const a = await screenshot(action.description); stepData.evidenceIds = a ? [a.id] : [];
          }
          stepData.url = safeUrl(page!.url()); store.endEvent(stepId, 'passed', clean(stepData)); history.push(action);
        } catch (e) {
          const evidence = await screenshot('Failure evidence').catch(() => null);
          store.endEvent(stepId, e instanceof AssertionFailure ? 'failed' : 'blocked', clean({ ...stepData, error: e instanceof Error ? e.message : 'Action failed', evidenceIds: [...(stepData.evidenceIds as string[]), ...(evidence ? [evidence.id] : [])] })); throw e;
        }
      }
    }
    check(); const ledger = store.detail(run.id)!.assertions.filter(a => a.attemptId === attempt.id);
    status = assertionOutcome(plan.assertions.map(a => a.id), ledger);
    if (status !== 'passed') error = 'Execution did not establish all required assertions.';
  } catch (e) {
    error = redact(e instanceof Error ? e.message : 'Execution stopped');
    status = store.get(run.id)?.cancelRequested ? 'cancelled' : lostLease || externalSignal?.aborted ? 'interrupted' : e instanceof AssertionFailure ? 'failed' : 'blocked';
    event('outcome', error, { status }); await screenshot('Run stopped').catch(() => null);
  } finally {
    await finalizeContext(); await browser?.close().catch(() => {});
    await proxy?.close();
    signal.removeEventListener('abort', abortBrowser);
    store.finish(attempt.id, status, error);
    clearInterval(heartbeat);
  }
  return { status, error, attemptId: attempt.id };
}
