import { readFileSync } from 'node:fs';
import { evidencePath } from '../storage/paths';
import type { RunDetail } from '../core/contracts';
import { assertionOutcome } from '../core/outcomes';
export const escapeHtml = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const md = (v: unknown) =>
  escapeHtml(v)
    .replace(/[\\`*_{}\[\]()#+!|]/g, '\\$&')
    .replace(/\r?\n/g, ' ');
export function reportData(detail: RunDetail) {
  const attempt = detail.attempts.at(-1);
  const assertions = detail.assertions.filter((a) => a.attemptId === attempt?.id);
  const artifactIds = new Map(detail.artifacts.map((a) => [a.id, a.attemptId]));
  for (const a of detail.assertions)
    if (a.evidenceIds.some((id) => artifactIds.get(id) !== a.attemptId))
      throw new Error('Report contains an invalid evidence reference.');
  for (const e of detail.events) {
    const ids = e.data.evidenceIds;
    if (
      Array.isArray(ids) &&
      ids.some((id) => typeof id !== 'string' || artifactIds.get(id) !== e.attemptId)
    )
      throw new Error('Report contains an invalid step evidence reference.');
  }
  const ledgerOutcome = assertionOutcome(
    attempt?.plan?.assertions.map((a) => a.id) ?? [],
    assertions,
  );
  const outcome = detail.run.status === 'passed' ? ledgerOutcome : detail.run.status;
  return {
    attempt,
    assertions,
    outcome,
    required: attempt?.plan?.assertions ?? [],
    limitations: [
      ...(detail.run.mode === 'fixture'
        ? [
            'FIXTURE MODE: deterministic LaunchDesk planning and decisions; no live AI inference was used.',
          ]
        : [
            'Live mode selected. Model-call records show validated responses; no fixture fallback was used. The assertion ledger determines the outcome.',
          ]),
      ...detail.events.filter((e) => e.type === 'verification_fault').map((e) => e.description),
      ...(detail.artifacts.some((a) => a.storage === 'expired')
        ? [
            'Some evidence files expired under the configured retention policy. Assertion results and the event history are retained; unavailable screenshots are not recreated.',
          ]
        : []),
      'This report covers the actions and explicit checks shown here. It does not establish other product behavior.',
      'Observed failures do not establish an underlying code-level root cause.',
      'Trace snapshots and trace screenshots are disabled to reduce secret exposure. Separate masked screenshots are retained.',
      ...(attempt?.error ? [attempt.error] : []),
    ],
  };
}
export function markdownReport(detail: RunDetail) {
  const r = reportData(detail);
  return `# ProofPack · ${md(r.attempt?.plan?.name ?? 'Evidence report')}

**Outcome: ${r.outcome.toUpperCase()}** · **${detail.run.mode.toUpperCase()} MODE**

Run: ${detail.run.id}  
Target: ${md(detail.run.targetUrl)}  
Created: ${new Date(detail.run.createdAt).toISOString()}

## Request

${md(detail.run.brief)}

Expected outcomes: ${md(detail.run.expected)}

## Assertion ledger

| Check | Expected | Observed | Result | Evidence IDs |
| --- | --- | --- | --- | --- |
${r.required
  .map((spec) => {
    const a = r.assertions.find((a) => a.specId === spec.id);
    return `| ${md(spec.description)} | ${md(a?.expected ?? spec.expected)} | ${md(a?.actual ?? 'Not exercised')} | ${a ? (a.passed ? 'PASS' : 'FAIL') : 'UNVERIFIED'} | ${a?.evidenceIds.join(', ') ?? '—'} |`;
  })
  .join('\n')}

## Walkthrough

${detail.events
  .filter((e) => e.type === 'step')
  .map(
    (e, i) =>
      `${i + 1}. [Attempt ${detail.attempts.find((a) => a.id === e.attemptId)?.number}] ${md(e.description)} — ${md(e.outcome)}${e.data.error ? `: ${md(e.data.error)}` : ''}${Array.isArray(e.data.evidenceIds) && e.data.evidenceIds.length ? ` (evidence: ${e.data.evidenceIds.join(', ')})` : ''}`,
  )
  .join('\n')}

## Evidence

${detail.artifacts.map((a) => `- ${a.id}: ${md(a.label)} (${a.kind}, attempt ${detail.attempts.find((at) => at.id === a.attemptId)?.number})`).join('\n')}

Markdown references durable evidence IDs. Download the HTML export for embedded screenshots and download traces separately from the dashboard.

## Attempts

${detail.attempts.map((a) => `- Attempt ${a.number}: ${a.status}; ${a.finishedAt ? `${((a.finishedAt - a.startedAt) / 1000).toFixed(1)} seconds` : 'unfinished'}${a.error ? `; ${md(a.error)}` : ''}`).join('\n')}

## Model metadata

${detail.modelCalls.map((c) => `- ${c.stage}: ${md(c.provider)} / ${md(c.model)}; ${c.latencyMs}ms; ${c.valid ? 'validated' : 'invalid'}; tokens in/out: ${c.inputTokens ?? 'unavailable'}/${c.outputTokens ?? 'unavailable'}`).join('\n') || 'No model calls recorded.'}

No cost estimate is invented when pricing or usage is unavailable.

## Limitations and unverified claims

${r.limitations.map((l) => `- ${md(l)}`).join('\n')}
`;
}
export function htmlReport(detail: RunDetail, artifactDir: string, archiveDir?: string) {
  const r = reportData(detail),
    esc = escapeHtml;
  const screenshot = (id: string) => {
    const artifact = detail.artifacts.find((a) => a.id === id && a.kind === 'screenshot');
    if (!artifact) throw new Error('Unknown screenshot evidence ID');
    try {
      const file = evidencePath(artifact, artifactDir, archiveDir);
      return `<figure id="${esc(id)}"><img alt="${esc(artifact.label)}" src="data:image/png;base64,${readFileSync(file).toString('base64')}"><figcaption>${esc(artifact.label)} · Evidence ${id}</figcaption></figure>`;
    } catch {
      return `<p>Evidence ${id} is recorded but ${artifact.storage === 'expired' ? 'expired under the configured retention policy' : 'the screenshot file is unavailable'}.</p>`;
    }
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>ProofPack evidence · ${esc(r.outcome)}</title><style>body{max-width:1000px;margin:50px auto;padding:0 24px;background:#faf9f6;color:#253049;font:15px/1.7 system-ui}h1{font-size:36px;letter-spacing:-1px}h2{margin-top:40px}table{width:100%;border-collapse:collapse;background:#fff}td,th{padding:14px;text-align:left;border-bottom:1px solid #ddd}img{width:100%;border:1px solid #ddd;border-radius:8px}figure{margin:28px 0}figcaption{color:#667085;font-size:12px}.badge{padding:8px 16px;background:#e9edf8;border-radius:30px}.failed{color:#b42318}.passed{color:#16815b}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;padding:20px;border-radius:12px}a{color:#315ecc}</style></head><body><p>◈ PROOFPACK / EVIDENCE REPORT</p><h1>${esc(r.attempt?.plan?.name ?? 'Execution report')}</h1><span class="badge ${r.outcome}">${esc(r.outcome.toUpperCase())}</span> <span class="badge">${detail.run.mode.toUpperCase()} MODE</span><p>Target: ${esc(detail.run.targetUrl)}<br>Run ${detail.run.id} · ${new Date(detail.run.createdAt).toISOString()}</p><h2>What was requested</h2><p>${esc(detail.run.brief)}</p><p><strong>Expected:</strong> ${esc(detail.run.expected)}</p><h2>Assertion ledger</h2><table><thead><tr><th>Check</th><th>Expected / observed</th><th>Result</th></tr></thead><tbody>${r.required
    .map((spec) => {
      const a = r.assertions.find((a) => a.specId === spec.id);
      return `<tr><td>${esc(spec.description)}</td><td>${esc(a?.expected ?? spec.expected)}<br>${esc(a?.actual ?? 'Not exercised')}<br>${a?.evidenceIds.map((id) => `<a href="#${id}">Screenshot ${id.slice(0, 8)}</a>`).join(' · ') ?? ''}</td><td class="${a?.passed ? 'passed' : 'failed'}">${a ? (a.passed ? 'PASS' : 'FAIL') : 'UNVERIFIED'}</td></tr>`;
    })
    .join('')}</tbody></table><h2>Walkthrough and failure evidence</h2><ol>${detail.events
    .filter((e) => e.type === 'step')
    .map(
      (e) =>
        `<li>${esc(e.description)} — ${esc(e.outcome)}${e.data.error ? `<br>${esc(e.data.error)}` : ''}</li>`,
    )
    .join('')}</ol>${detail.artifacts
    .filter((a) => a.kind === 'screenshot')
    .map((a) => screenshot(a.id))
    .join(
      '',
    )}<h2>Execution details, attempts, model metadata, and limitations</h2><pre>${esc(markdownReport(detail))}</pre></body></html>`;
}
