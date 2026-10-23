# Bottleneck review and improvements

Reviewed on 23 October 2026 against the code and recorded live runs. The initial measurements are preserved below. All four follow-up recommendations are now implemented and verified; see [the operations guide](operations.md).

## Confirmed and fixed

**Repeated schema tokens.** Strict requests carried the entire schema in both `response_format` and the system message on every model decision. The strict prompt now uses a compact action/plan guide while the provider still receives the full schema and Zod still validates every response. JSON-object/plain modes retain their full schema instructions.

Two real Groq GPT-OSS 120B decisions on the identical synthetic observation used **1,449 → 1,101 input tokens**, a **24.0% reduction**. Both selected the expected `complete_goal` action. This is a controlled token comparison, not a full-browser reliability or timing benchmark. [Provider-reported results](prompt-efficiency-verification.json).

**History scans on every worker poll.** Idle claims previously read and decoded every attempt, including completed plans, to find expired leases. Expiry is now filtered in SQL with a status/lease index. Artifact and model-call lookups also have attempt indexes. The additive indexes initialize idempotently for existing databases; no historical evidence is removed.

An isolated synthetic history with **5,000 runs and 100,000 model-call rows**, measured over nine warm samples on the same machine, produced:

| Operation                               | Before median | After median |
| --------------------------------------- | ------------- | ------------ |
| Idle job claim, including lease reaping | 29.956 ms     | 0.386 ms     |
| One run-detail read                     | 17.551 ms     | 0.399 ms     |

[Benchmark record](performance-verification.json). These timings are not a production concurrency guarantee. Normal small histories were not the primary cause of the recorded multi-minute runs.

**Endless and overlapping report polls.** A finished report previously fetched its full detail every 1.5 seconds indefinitely. Slow responses could overlap because the interval did not wait for completion. Polling now schedules the next fetch after the current fetch completes, stops on terminal states, aborts obsolete requests, and revalidates on focus or an explicit mutation. Retrying a stopped run resumes polling.

A real Chromium test against the production UI used explicitly mocked HTTP responses delayed by 1.8 seconds. It verified terminal polling stops, focus revalidation, retry resumption, and **one maximum concurrent request**. [Polling results](polling-verification.json). Those mocked responses are not presented as real browser-job outcomes.

## Post-change verification and remaining external limit

At the initial performance milestone, **18 unit tests, eight fixture browser verification groups, TypeScript, lint and the production build passed.** The production UI polling test above passed too. The subsequent four-feature milestone passes **28 tests** and **seven additional production UI verification groups**; see [the verification record](verification.md).

A fresh live Groq working-app scenario using the smaller prompt passed **4/4 assertions** in **148.7 seconds**, recording 34 model attempts, including 14 HTTP 429s. It exercised actual registration, creation, logout, fresh browser context, login and persistence. This timing is observational: model choices and quota conditions vary, so it is not an isolated speedup measurement.

The subsequent broken-app rerun was **Blocked** before its assertions when Groq returned HTTP 429 with **Retry-After 442 seconds**. The adapter correctly stopped because that exceeded the 60-second bounded-wait policy. No feature pass/failure was inferred. [Fresh live results](performance-live-verification.json) retain both outcomes. The earlier successful detection of broken persistence remains documented in [live-verification.md](live-verification.md); it is not presented as a fresh post-change result.

This establishes that provider quota is still the principal observed external bottleneck. The software changes reduce avoidable token/local work, but cannot grant additional model capacity. No key rotation, provider fallback, account upgrade, or paid service was enabled.

## Four follow-up improvements completed

1. **Shared provider quota.** Transactional leases serialize inference per provider/endpoint/model/group across workers sharing SQLite. Returned token/request headers and 429 cooldowns guide reservations. Known cooldowns leave later runs Queued without consuming an attempt. Waits remain cancellable and bounded by configured limits. This coordinates local demand; it cannot raise provider capacity or track usage outside this database.
2. **Configurable archival and retention.** The Evidence storage page previews candidates and queues reviewed background maintenance. Checksummed copies and manifests commit before exact working files are removed. Downloads and reports resolve archives; optional, separately configured expiry returns HTTP 410 while keeping the ledger. Defaults remain off and the main workspace's existing artifacts were not removed. Archival alone moves, rather than compresses, the evidence footprint.
3. **Incremental run events.** A bounded cursor feed sends changed entities, including completion updates to existing events. The client merges by ID and falls back to a snapshot after journal compaction. Serial polling still stops at terminal states. The production UI test observed 18 delta responses across the workflow, with no repeated event/model history in unchanged responses.
4. **Visible retry eligibility.** One policy powers disabled controls, explanations, API rejection and the transactional retry. Attempt exhaustion and maintenance locks are covered by tests; earlier attempts remain visible.

The [new real Groq scheduler run](scheduler-live-verification.json) reached a **126-second HTTP 429 cooldown** after eight valid model responses. That run became Blocked; the next stayed Queued with **zero model calls and no attempt**. This verifies cooldown sharing/deferred claiming, but does not establish complete post-change working/broken persistence results. Historical live passing and failure-detection evidence above remains separate. Provider capacity is still the observed external limit. Large HTML exports and broader browser workflows remain deliberate limits; no new speedup or scalability benchmark is claimed for these four features.

## Reproduce the measurements

The `before` records were captured before the code changes and are retained alongside the `after` results. Running both labels now measures current code twice; reproducing the historical baseline requires the prior revision.

```powershell
npx.cmd tsx scripts/benchmark-store.ts before
npx.cmd tsx scripts/benchmark-store.ts after
# Explicit live mode/key required; these two diagnostic calls consume quota:
npx.cmd tsx scripts/measure-model-prompt.ts before
npx.cmd tsx scripts/measure-model-prompt.ts after
# Against a built/running production dashboard, without model requests:
npx.cmd tsx scripts/verify-polling.ts
# Isolated production UI, incremental feed, retry limits, archival and expiry:
npm.cmd run build
npm.cmd run test:improvements
# Fresh real live working/broken browser scenarios on isolated ports 4400/4401:
# Writes scheduler-live-verification.json; consumes real quota and can be blocked.
npx.cmd tsx scripts/verify-efficiency-live.ts
```

The benchmark databases and live artifacts remain under ignored `data/` directories. The synthetic benchmark never inserts rows into the application's production history. No credentials or raw provider response bodies are included in the measurement records.
