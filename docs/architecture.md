# System design and engineering notes

## Request to evidence

The dashboard submits `{targetUrl, brief, expected}` to a short Next.js POST handler. Zod validates it, the origin policy rejects unintended targets, and SQLite records a queued run. There is no browser work inside that handler.

A separate Node process claims one queued run in an immediate SQLite transaction. The transaction creates a numbered attempt, assigns a worker identity, sets a lease, and updates the run. Connections use WAL and a busy timeout. Claims are exclusive across connections. The worker keeps the lease alive during planning, browser execution, and artifact finalization.

Planning produces ordered goals and required assertions. The planner cannot produce executable code. The selected plan is persisted before browser execution, and each assertion ID is assigned to exactly one goal. The model's planner can still misunderstand the requested coverage; the report shows both the original request and the executable checks so coverage remains reviewable.

The worker creates a fresh Chromium context and unique account/project names. It captures bounded page text and accessible control metadata after navigation and between actions. Control IDs are valid only for that observation. The live decision adapter receives the current goal, its immutable assigned assertions, the current observation and executed actions with before/after URLs. Old control IDs are explicitly scoped to past observations. Input metadata reveals filled/required flags and form membership, never values. Passwords are absent; `{{password}}` is substituted inside the executor only, and can only be filled into a password field.

Every action is Zod validated and semantically checked before execution. The executor owns all browser functions. It can fill, click, select, navigate within allowed origins, evaluate immutable text/URL assertions, capture evidence, reset the browser context, or complete a goal after its required assertions. It never runs model-generated selectors or source code.

Progress guards reject consecutive identical actions when the bounded observation did not change, repeated fresh-context resets within one goal, and submission while required fields in that same form remain empty. A separate logout form is unaffected. A fresh context reopens the current allowed URL with no cookies/storage. These guards prevent observed loops without inventing target success or retrying ambiguous browser failures.

An action starts with a durable `running` event; its completion records a timestamp, action, locator, URL, outcome, assertion details, and evidence references. Screenshot and artifact metadata are persisted progressively. Browser console exceptions and failed requests become diagnostics, without automatically deciding feature failure.

The final status is checked against the durable ledger. SQLite finalization and report generation both reject a pass with incomplete or failed assertions. Narrative is deterministic; there is no second model whose prose could alter the status. HTML escapes target content, embeds screenshots as data URLs, and includes a restrictive content policy. Trace downloads are separate.

## Storage

| Table         | Purpose                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `runs`        | User request, target, model mode/configuration identity, current status, cancellation flag, attempt count |
| `attempts`    | Worker/lease, isolated attempt number, plan, timestamps, outcome and original error                       |
| `events`      | Durable execution timeline, diagnostics, action/locator/assertion/evidence details                        |
| `assertions`  | Unique check per attempt, expected/actual values, pass/fail and validated evidence IDs                    |
| `artifacts`   | Per-attempt screenshot/trace IDs and local paths                                                          |
| `model_calls` | Actual returned model/provider, latency, available token counts, validation result                        |

Database schema version 1 is initialized idempotently. There is no upgrade migration history yet; future schema changes need explicit migrations. Artifact files are separate from SQLite and served only by validated IDs with path containment checks. Files are not embedded into the database.

## Outcome state machine

`Queued → Planning → Running → Passed / Failed / Blocked / Interrupted / Cancelled`

- **Passed:** every required executable assertion succeeded.
- **Failed:** an assertion contradicted expected behavior (for example, expected project text absent after login).
- **Blocked:** execution could not establish the requested result, such as an unavailable target, ambiguous control, model schema exhaustion, execution limits, or invalid configuration.
- **Interrupted:** the lease expired or the worker received a shutdown signal before completion.
- **Cancelled:** user cancellation was requested and prevents further actions. Finalization also checks the cancellation flag.

Failed, blocked, and interrupted runs can be manually requeued within the attempt limit. A new attempt starts an entirely new browser, credentials and project name. Earlier evidence remains. A state-changing timeout stops the attempt because the original action's outcome may be unknown; the executor does not click again blindly.

## Boundaries

The initial implementation's browser integration test demonstrated that Playwright routing alone allowed a redirect to bypass its route check. A browser-level origin proxy was added. It forwards only exact allowed HTTP origins and HTTPS CONNECT tunnels, never follows redirects itself, and overrides Chromium's implicit loopback proxy bypass. Every redirect becomes another checked proxy request. Request routing, explicit navigation validation, disabled service workers, blocked popups/WebSockets, and the proxy form complementary layers.

The proxy test uses a disallowed local sink, verifies zero hits, and tests redirected navigation as well as image/fetch/popup/WebSocket attempts. This is an execution boundary for controlled application testing, not OS sandboxing of adversarial browser exploits.

Synthetic credentials are generated per attempt. Screenshots mask password inputs. Trace screenshots and snapshots are disabled; finalized ZIP entries are scanned for generated secrets, cookie/auth fields are redacted, and cookie arrays are removed. Failed trace sanitation removes that trace rather than serving it unsanitized. No inference API response body is echoed on HTTP errors.

## Problems solved during implementation

1. **Windows tooling restrictions.** PowerShell blocked the npm script shim, the filesystem sandbox blocked protected Git metadata, and browser/TypeScript/build tools needed child processes. `npm.cmd` avoided a policy change; authorized dependency/browser downloads, testing, and Git writes used the provided approval flow.
2. **ESM versus CommonJS.** The TypeScript verification CLI used top-level await. Declaring the package as ESM made the CLI, LaunchDesk entry-point detection, and worker imports consistent.
3. **Serialized browser closures.** The TypeScript runner injected a `__name` helper into a named nested function passed to `page.evaluate`, which does not exist inside Chromium. Keeping the browser observer's callback self-contained removed the dependency. A real browser run caught it; type checking alone could not.
4. **Redirect enforcement.** A disallowed sink received a redirect request despite request routing. The origin proxy closed that gap; the same regression test now proves zero network hits.
5. **Request authority normalization.** Next.js normalized the internal request URL to `localhost` while the browser used `127.0.0.1`. The local API guard now validates the actual Host authority and compares Origin to it, without trusting forwarded headers or accepting nonlocal hosts.
6. **Pooled socket listener growth.** HTTP connection reuse added repeated close listeners. Tracking each socket once removed the warning without relaxing listener limits.
7. **Honest report finalization.** A claimed success with an incomplete ledger is downgraded at both persistence and export boundaries. Missing evidence IDs are rejected, and original attempt failures stay visible after retries.
8. **Live action provenance.** Real model runs misread old control IDs against new observations and repeated registration. Before/after URL history, input-state flags and bounded progress guards resolved the recorded loops. The planner also scopes account guidance to requested tasks, allowing a simple heading-only plan with zero input variables.
9. **Provider limits and verification accounting.** HTTP 429 waits honor Retry-After within call/time budgets and emit visible wait events. Transport failures count toward the three-attempt response budget. The fault-injection harness now distinguishes actual corrupted responses from rate-limited requests. HTTP authentication/configuration errors stop promptly, with response bodies omitted.

## Deliberate choices and bottlenecks

Groq GPT-OSS 120B completed actual live working/broken persistence and negative/boundary checks; see [the live verification record](live-verification.md). Early 20B/120B diagnostic failures and cancellations are preserved. Actual provider throttling affected elapsed time. This is a limited verification, not a reliability benchmark. OpenRouter and local inference remain unverified beyond protocol tests/catalog checks. The adapter remains replaceable, with capability negotiation for hosted providers and explicit format configuration for local servers.

Deterministic reports satisfy the evidence requirement without adding an unverified narrative generation stage. A later narrative model should cite validated evidence IDs and must never change ledger outcomes. SQLite is sufficient for a local solo-developer MVP; it is not a distributed queue. Large exports, artifact cleanup, broader browser workflows and richer input variables are follow-up work, not implied capabilities.
