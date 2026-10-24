# ProofPack, briefly

ProofPack is open-source, local-first software that helps developers demonstrate a feature and collect evidence of its behavior. Give it an allowlisted application URL, a feature brief and expected outcomes. In live mode, an AI model creates a structured plan and selects bounded actions from what the browser observes.

A separate Playwright worker operates real Chromium, executes explicit assertions, and saves screenshots, traces and a timeline. SQLite keeps the request, attempts, model metadata and assertion ledger. The Next.js dashboard shows progress and exports Markdown or self-contained HTML with embedded screenshots.

The model chooses actions; executable assertions determine the result. A contradicted check is **Failed**. An unavailable target, model problem or exhausted execution budget is **Blocked**. Retrying keeps earlier evidence and starts fresh browser state. Optional reviewed archival and expiry control evidence storage.

The bundled LaunchDesk examples demonstrate the difference: one preserves a project after logout and fresh login; the deliberately broken version loses it. Real Groq runs recorded four passing checks for the working case and three of four for the broken case.

It is useful for feature walkthroughs, observable regression checks and evidence attached to a review. Reports cover the checks actually exercised. They do not establish complete test coverage or a code-level root cause.

The dashboard, worker and evidence run locally. Hosted live inference still sends the brief and bounded page observations to the configured provider. Fixture mode uses deterministic decisions with a real browser and is labeled explicitly.
