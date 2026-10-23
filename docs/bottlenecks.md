# Bottleneck review and improvements

Reviewed on 23 October 2026 against the code and recorded live runs. Changes target measured or directly observable waste; the recommendations below are not implemented features.

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

**18 unit tests, eight fixture browser verification groups, TypeScript, lint and the production build passed.** The production UI polling test above passed too.

A fresh live Groq working-app scenario using the smaller prompt passed **4/4 assertions** in **148.7 seconds**, recording 34 model attempts, including 14 HTTP 429s. It exercised actual registration, creation, logout, fresh browser context, login and persistence. This timing is observational: model choices and quota conditions vary, so it is not an isolated speedup measurement.

The subsequent broken-app rerun was **Blocked** before its assertions when Groq returned HTTP 429 with **Retry-After 442 seconds**. The adapter correctly stopped because that exceeded the 60-second bounded-wait policy. No feature pass/failure was inferred. [Fresh live results](performance-live-verification.json) retain both outcomes. The earlier successful detection of broken persistence remains documented in [live-verification.md](live-verification.md); it is not presented as a fresh post-change result.

This establishes that provider quota is still the principal observed external bottleneck. The software changes reduce avoidable token/local work, but cannot grant additional model capacity. No key rotation, provider fallback, account upgrade, or paid service was enabled.

## Remaining improvements, in priority order

1. **Coordinate provider quota before increasing concurrency.** Earlier real persistence runs recorded 20–21 HTTP 429s each. Smaller prompts reduce demand, but cannot raise the provider's allowance. Add scheduling based on remaining/reset headers, shared across workers, before adding more workers. For sustained usage, inspect the account's actual allowance and consider an appropriate higher quota or a measured local endpoint. Groq applies limits at organization level; extra keys in the same organization do not create independent allowances. [Groq rate-limit documentation](https://console.groq.com/docs/rate-limits).
2. **Add configurable artifact archival/retention.** Screenshots, traces and history currently accumulate. Choose retention rules and provide a preview/archive path before deleting evidence. No existing artifacts were deleted in this review.
3. **Fetch incremental events for larger active histories.** Active pages still request complete run details. A cursor/event endpoint or SSE would reduce repeated transfer when many long runs and viewers are active. Current action/call/attempt limits bound one run; the terminal-polling fix removes the unbounded idle requests first.
4. **Make retry availability visible.** The API enforces `MAX_ATTEMPTS`, but the UI still offers a retry button after that limit and then displays the API rejection. Disabling it with an explanation would improve clarity; it is a UI improvement rather than the measured execution bottleneck.

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
# Fresh real live working/broken browser scenarios on isolated ports 4400/4401:
npx.cmd tsx scripts/verify-efficiency-live.ts
```

The benchmark databases and live artifacts remain under ignored `data/` directories. The synthetic benchmark never inserts rows into the application's production history. No credentials or raw provider response bodies are included in the measurement records.
