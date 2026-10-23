# Verification record

Verified on **23 October 2026 (Asia/Calcutta)**, Windows, Node.js **22.16.0**. All commands below were actually executed. Browser runs used **fixture mode** and real Playwright Chromium, not mocked browser actions.

The locked application dependencies include Next.js **16.4.2**, React **19.3.1**, Playwright **1.64.1**, better-sqlite3 **13.0.3**, Drizzle **0.45.4**, Zod **4.6.7**, and Tailwind **4.3.3**. Dependencies are pinned and the npm lockfile is committed.

## Commands and outcomes

| Command                                                                   | Actual outcome                                                                                                                                                 |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm.cmd install --no-audit --no-fund --cache .npm-cache --prefer-online` | Dependencies installed with approved network access. Initial restricted/cache-only installation could not reach uncached packages.                             |
| `npx.cmd playwright install chromium`                                     | Chromium 156.0.8078.4 / Playwright build 1248, headless shell and supporting tools installed with approval.                                                    |
| `npm.cmd run model:check`                                                 | Real OpenRouter catalog returned `google/gemma-3-27b-it`, context 131072, and `structured_outputs` / `response_format` support. No inference request was made. |
| `npm.cmd run format`                                                      | Source and documentation formatted successfully.                                                                                                               |
| `npm.cmd run typecheck`                                                   | Passed with no TypeScript errors, including after the production build.                                                                                        |
| `npm.cmd run lint`                                                        | Passed with no errors or warnings on the final source.                                                                                                         |
| `npm.cmd test`                                                            | **11 tests passed**, zero failures.                                                                                                                            |
| `npm.cmd run test:e2e`                                                    | **8 verification groups passed** with the expected run statuses below. Isolated servers used ports 4200–4204 and closed afterward.                             |
| `npm.cmd run build`                                                       | Production build passed. All dashboard, run, report, configuration, mutation, and artifact routes compiled successfully.                                       |
| `npm.cmd run start:all`                                                   | Production dashboard, separate worker and both LaunchDesk instances started on loopback successfully.                                                          |
| `npm.cmd run test:dashboard`                                              | **8 integrated checks passed against the production build**, including desktop/mobile screenshots, real worker jobs and exports.                               |
| `git diff --check`                                                        | No whitespace errors.                                                                                                                                          |

## Browser execution results

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

## Integrated production dashboard checks

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

## Issues encountered and resolved

- PowerShell's npm script shim was blocked. Used `npm.cmd`, without changing execution policy.
- Dependency downloads, Chromium installation, protected Git metadata writes and child-process tests/builds required the environment's approval flow. These were approved and completed.
- The verification CLI initially compiled as CommonJS and rejected top-level await. Declaring ESM fixed it.
- Chromium rejected a serialized observer callback containing a TypeScript-runner helper (`__name`). The observer was made self-contained and rerun successfully.
- An early origin test detected **one disallowed redirect request** escaping Playwright routing. A browser proxy was added; the final test proves zero sink hits.
- Connection pooling initially accumulated close listeners. Each socket is now tracked once; the final runs emitted no listener warning.
- Initial UI submissions were rejected because Next normalized the request URL to `localhost`. Comparing the browser Origin with the validated Host authority fixed valid loopback requests while keeping foreign-origin rejection.
- Finalization now checks the durable assertion ledger, closes in-flight step events on interruption, and prevents stale step completions from overwriting the interrupted outcome.

## Unverified or intentionally limited

- **Live inference:** no model API credentials or running local model endpoint were supplied. Actual successful/failing live-model browser runs remain unverified. Fixture mode never silently substitutes for live mode. The real catalog check verifies listing/capabilities only; mocked adapter tests verify request handling only.
- **Crash recovery:** tested by deliberate lease expiry and replacement-worker execution; no OS-level hard-kill or power-loss test was performed.
- **HTTPS:** the proxy supports exact-origin HTTPS CONNECT tunnels; the recorded browser checks used local HTTP applications.
- **External applications:** the recorded end-to-end suite targets LaunchDesk and controlled boundary fixtures. CAPTCHA, MFA, popup/WebSocket workflows, uploads, visual assertions, and arbitrary user-defined variable types are unsupported.
- **Productivity:** no time-savings claims were invented. Use [manual-baseline.md](manual-baseline.md) to collect real measurements.

No public deployment, article publication, or challenge submission was performed.
