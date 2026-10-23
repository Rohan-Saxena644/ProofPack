# Groq setup and live verification

Groq provider support was added after the initial fixture-only milestone. Official documentation checked on 2026-10-23 lists `openai/gpt-oss-20b` and `openai/gpt-oss-120b` as production open-weight models with strict JSON-schema output support. The verified example uses **120B** after early 20B runs exposed planning and action-history problems. Account access is established by an authenticated catalog check, then actual inference; documentation alone does not verify a key.

1. Open the ignored local `.env` file and add the Groq key to `MODEL_API_KEY`. The file has been prepared locally with the same nonsecret settings as [.env.groq.example](../.env.groq.example). Do not paste the key into chat or pass it in shell arguments.
2. Keep `MODEL_MODE=live`, `MODEL_PROVIDER=groq`, `MODEL_BASE_URL=https://api.groq.com/openai/v1`, `MODEL_ID=openai/gpt-oss-120b`, and `MODEL_FORMAT=auto`.
3. Run `npm run model:check` to check authentication and current account model availability.
4. Run `npm run test:live` for isolated live execution. It creates its own LaunchDesk instances and database. No background worker competes for those jobs.
5. Restart the dashboard and worker with the new `.env`; use `npm run build` and `npm run start:all` for production, or `npm run dev:all` for development.
6. Run `npm run test:dashboard` against those services for actual live UI, queue/worker, export, download, desktop and mobile checks. Live screenshots and summaries are separate from fixture evidence.

The live persistence checks require actual ledger evidence of project creation, logout, a fresh context, login, and the final project-presence assertion. A model cannot satisfy the verification just by asserting a landing-page heading or URL. Required persistence coverage is checked in the verification tool without hardcoding a fixture plan into the browser executor.

Negative live checks include a controlled cancellation boundary and intentional corruption of actual model responses. These are explicitly identified as fault injection. They do not claim the provider naturally emitted invalid structured JSON. Rate-limit and auth handling are also covered by deterministic protocol tests, avoiding unnecessary requests with invalid keys.

The adapter handles Groq's documented `anyOf`/enum schema subset, while retaining all application Zod bounds and semantic checks. GPT-OSS 120B uses medium reasoning effort, with `max_completion_tokens` of 4096 for plans and 1024 for decisions. The 20B adapter uses medium effort for plans and low for decisions. Provider usage includes the tokens Groq actually returns. No missing usage or cost is invented. API keys are never part of model prompts, page observations, exported reports or committed files.

Hosted inference sends the brief, expected outcomes and bounded page observations to Groq. Screenshots and traces stay local. The key remains local server configuration and is used only in authenticated API headers.

After the user supplied the key locally, **actual live Groq inference was verified**: working persistence passed 4/4 assertions, broken persistence failed the final assertion, and the isolated live negative/boundary/export checks completed. Read [live-verification.md](live-verification.md) and [the recorded results](live-verification-results.json) for run IDs, earlier failures, bounded rate-limit handling and reused evidence.

Regression checks include **16 unit tests**, **8 fixture browser verification groups**, TypeScript, lint and a production build. Unit-test Groq HTTP responses remain mocked with a synthetic key; the separate live suite makes actual authenticated model requests. A catalog-only check never claims inference success.

References: [Groq models](https://console.groq.com/docs/models), [structured outputs](https://console.groq.com/docs/structured-outputs), [OpenAI compatibility](https://console.groq.com/docs/openai), [rate limits](https://console.groq.com/docs/rate-limits).
