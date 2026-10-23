# Verification record

Verified on **23 October 2026 (Asia/Calcutta)**, Windows, Node.js **22.16.0**. All commands below were actually executed. Browser verification includes separately labeled **fixture** and **live Groq** runs, both using real Playwright Chromium.

The locked application dependencies include Next.js **16.4.2**, React **19.3.1**, Playwright **1.64.1**, better-sqlite3 **13.0.3**, Drizzle **0.45.4**, Zod **4.6.7**, and Tailwind **4.3.3**. Dependencies are pinned and the npm lockfile is committed.

## Commands and outcomes

| Command                                                                   | Actual outcome                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm.cmd install --no-audit --no-fund --cache .npm-cache --prefer-online` | Dependencies installed with approved network access. Initial restricted/cache-only installation could not reach uncached packages.                                                                              |
| `npx.cmd playwright install chromium`                                     | Chromium 156.0.8078.4 / Playwright build 1248, headless shell and supporting tools installed with approval.                                                                                                     |
| `npm.cmd run model:check`                                                 | Real OpenRouter catalog confirmed Gemma 3 27B capabilities; authenticated Groq catalog confirmed GPT-OSS 120B. This command checks catalogs only; live inference was checked separately.                        |
| `npm.cmd run format`                                                      | Source and documentation formatted successfully.                                                                                                                                                                |
| `npm.cmd run typecheck`                                                   | Passed with no TypeScript errors, including after the production build.                                                                                                                                         |
| `npm.cmd run lint`                                                        | Passed with no errors or warnings on the final source.                                                                                                                                                          |
| `npm.cmd test`                                                            | **18 tests passed**, zero failures.                                                                                                                                                                             |
| `npm.cmd run test:e2e`                                                    | **8 verification groups passed** with the expected run statuses below. Isolated servers used ports 4200–4204 and closed afterward.                                                                              |
| `npm.cmd run test:live` (with documented resume)                          | **7 live verification groups completed** against Groq 120B. Actual failures and resumed evidence are retained separately.                                                                                       |
| `npm.cmd run build`                                                       | Production build passed. All dashboard, run, report, configuration, mutation, and artifact routes compiled successfully.                                                                                        |
| `npm.cmd run start:all`                                                   | Production dashboard, separate worker and both LaunchDesk instances started on loopback successfully.                                                                                                           |
| `npm.cmd run test:dashboard`                                              | **8 fixture checks** and subsequently **9 live recovery checks** passed against the production build. The live broken run required an explicit fresh-attempt retry after throttling; original evidence remains. |
| `git diff --check`                                                        | No whitespace errors.                                                                                                                                                                                           |

## Fixture browser execution results

Machine-readable results, run IDs and exact timestamps: [verification-results.json](verification-results.json).

| Scenario                                                                 | Expected status      | Observed result                                                                                                                                                        |
| ------------------------------------------------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Working LaunchDesk, create project, logout, fresh browser context, login | Passed               | Passed; **4/4** assertions, including the same project visible after fresh login                                                                                       |
| Broken LaunchDesk, identical procedure                                   | Failed               | Failed; **3/4** assertions passed, final `persisted` assertion false with screenshots of the missing project                                                           |
| Unreachable allowlisted target                                           | Blocked              | Blocked; no success claim                                                                                                                                              |
| Unsupported/invalid model output                                         | Blocked              | Blocked after **3** invalid model attempts; no generated code executed                                                                                                 |
| Cancellation between model decision and browser execution                | Cancelled            | Cancelled; browser step count did not increase after the cancellation boundary                                                                                         |
| Expired worker lease followed by explicit retry                          | Interrupted → Passed | Original interrupted attempt retained; second attempt used new account/project suffix `a2` and passed                                                                  |
| Request, redirect, popup and WebSocket to disallowed sink                | Blocked execution    | Boundary check passed; **zero requests** reached the sink                                                                                                              |
| Report and trace export                                                  | Correct evidence     | HTML contained loadable embedded screenshots, Markdown matched the assertion ledger, both browser contexts produced trace artifacts, and session headers were redacted |

The deliberately failed persistence run is a **successful verification of failure detection**. A blocked run in the negative cases is also the expected behavior, not a failed test suite.

Unit tests cover unsupported actions/extra fields, invalid assertion assignment, origin rules, incomplete/failed ledger outcomes, exclusive claims across database connections, expired leases and bounded retry, evidence references, defensive report outcomes/escaping, request authority and cross-origin guards, trace secret/cookie sanitation, fixture refusal of custom requests, and the live adapter's structured request/usage protocol with a mocked response.

## Fixture production dashboard checks

[dashboard-verification.json](dashboard-verification.json) records the final real UI/API runs:

- Working run: `8ddd77b9-9d89-4627-bf64-0172ecbdc6f3`, Passed.
- Broken run: `f557e989-ba4c-4e6a-9a0c-10370d238b8b`, Failed at the persistence check.
- New-run form queued work that the separate worker executed.
- Evidence report, embedded HTML, Markdown, screenshot endpoints and ZIP trace downloads returned successfully.
- Cancellation produced Cancelled.
- The API rejected a metadata target with HTTP 400 and a foreign Origin with HTTP 403.
- Persisted history contained real working, broken and cancelled demonstrations.
- A **390px** mobile viewport had no horizontal page overflow.
- No browser page exceptions occurred during the dashboard workflow.

Screenshots were opened for visual inspection after capture: [desktop](screenshots/dashboard.png), [mobile](screenshots/mobile.png), [report](screenshots/evidence-report.png), [working assertion](screenshots/working-persistence.png), and [broken assertion](screenshots/broken-persistence.png). The desktop screenshot waits for actual configuration and persisted history rather than capturing the loading state.

## Live Groq verification

The user supplied a key in the ignored `.env`. The authenticated catalog and actual inference were verified with **`openai/gpt-oss-120b`**. [Live results](live-verification-results.json) record seven completed verification groups: working persistence **Passed 4/4**, broken persistence **Failed 3/4**, unreachable target **Blocked**, cancellation **Cancelled**, bounded invalid-output fault injection **Blocked**, untrusted-page/origin check **Passed with zero forbidden sink hits**, and report/trace/metadata redaction checks.

The broken result is expected failure detection. Fault injection intentionally replaces real provider responses and is explicitly labeled. One of its three attempts was HTTP 429; the other two reached response validation. Live records are not mixed with fixture results. See [live-verification.md](live-verification.md) for run IDs, preserved unsuccessful diagnostic attempts, actual rate limits and evidence reuse.

[Live dashboard results](live-dashboard-verification.json) record nine checks through the production UI and worker. Working run `6e3eba31-41b8-4b3a-9293-c0b9d151a80d` passed 4/4. Broken run `7f95e3c0-ef72-4eab-aa90-0bb2298cf1a7` was initially quota-blocked, then failed the final persistence assertion on explicit fresh attempt 2. The first attempt remains Blocked with its original error. Desktop, mobile, passing/failed report screenshots were visually inspected. Standalone live HTML exports also loaded all 10/12 embedded screenshots without the dashboard; see [export results](live-export-verification.json).

## Bottleneck follow-up

The subsequent [bottleneck review](bottlenecks.md) removed duplicate strict-schema prompt text, indexed lease/detail lookups and stopped terminal/overlapping report polls. The updated 18-test unit suite, eight fixture browser groups, type check, lint and production build passed. Real Chromium verified polling behavior using explicitly mocked HTTP responses. A fresh live working run passed 4/4 with the smaller prompt; the subsequent broken-app rerun was quota-blocked by a 442-second Retry-After, so no fresh broken-case result is claimed. Exact measurements and limitations are linked in the review.

## Issues encountered and resolved

- PowerShell's npm script shim was blocked. Used `npm.cmd`, without changing execution policy.
- Dependency downloads, Chromium installation, protected Git metadata writes and child-process tests/builds required the environment's approval flow. These were approved and completed.
- The verification CLI initially compiled as CommonJS and rejected top-level await. Declaring ESM fixed it.
- Chromium rejected a serialized observer callback containing a TypeScript-runner helper (`__name`). The observer was made self-contained and rerun successfully.
- An early origin test detected **one disallowed redirect request** escaping Playwright routing. A browser proxy was added; the final test proves zero sink hits.
- Connection pooling initially accumulated close listeners. Each socket is now tracked once; the final runs emitted no listener warning.
- Initial UI submissions were rejected because Next normalized the request URL to `localhost`. Comparing the browser Origin with the validated Host authority fixed valid loopback requests while keeping foreign-origin rejection.
- Finalization now checks the durable assertion ledger, closes in-flight step events on interruption, and prevents stale step completions from overwriting the interrupted outcome.
- Live model decisions misinterpreted old control IDs against new observations. Executed actions now carry before/after URLs and explicit historical scope. Input-state flags and form membership prevent empty submissions without exposing values.
- The planner initially imposed account goals on a heading-only request. Task-scoped guidance and zero-variable plans fixed the recorded heading case.
- Provider throttling required bounded Retry-After handling and visible wait events. The live verification harness now accounts for transport failures within the three-attempt budget and resumes saved successful evidence without selecting a cancelled run.

## Unverified or intentionally limited

- **Other model endpoints:** actual Groq 120B inference is verified on controlled targets. Actual OpenRouter and local inference remain unverified. Catalog/protocol checks alone do not establish inference. No fixture fallback occurs.
- **Crash recovery:** tested by deliberate lease expiry and replacement-worker execution; no OS-level hard-kill or power-loss test was performed.
- **HTTPS:** the proxy supports exact-origin HTTPS CONNECT tunnels; the recorded browser checks used local HTTP applications.
- **External applications:** the recorded end-to-end suite targets LaunchDesk and controlled boundary fixtures. CAPTCHA, MFA, popup/WebSocket workflows, uploads, visual assertions, and arbitrary user-defined variable types are unsupported.
- **Productivity:** no time-savings claims were invented. Use [manual-baseline.md](manual-baseline.md) to collect real measurements.

No public deployment, article publication, or challenge submission was performed.
