# Quota, evidence storage and run updates

The four improvements requested after the bottleneck review are implemented. They keep model demand coordinated, provide reviewed evidence retention, reduce repeated run-detail transfers and explain retry eligibility. Existing assertion outcomes remain authoritative.

## Shared provider scheduling

Live requests reserve a SQLite lease before inference. Workers sharing the same database coordinate by provider, normalized endpoint, model and `MODEL_QUOTA_GROUP`. The scope contains no credential. One inference request uses that scope at a time; independent models/groups have separate budgets.

The gate estimates input plus maximum output tokens, updates its budget from returned token allowance headers and shares HTTP 429 cooldowns. It uses remaining-request reset information when the remaining count reaches zero; it does not mistake a daily request allowance for requests per minute. Estimates and provider headers cannot guarantee that the provider will accept a request.

| Setting                   | Default   | Effect                                                                           |
| ------------------------- | --------- | -------------------------------------------------------------------------------- |
| `MODEL_QUOTA_GROUP`       | `default` | Shared budget identity within a provider/endpoint/model scope                    |
| `MODEL_MIN_INTERVAL_MS`   | `0`       | Optional minimum interval between request starts; the Groq example suggests 2000 |
| `MODEL_MAX_QUOTA_WAIT_MS` | `60000`   | Maximum shared-quota acquisition wait; the overall run deadline still applies    |

Waits are cancellable and appear in the timeline. A known provider cooldown leaves new work **Queued**, with zero attempts until eligible. A request already in progress can still receive a new 429 and become **Blocked**. Preflight refusal makes no inference HTTP request and consumes no schema-repair retries.

Coordination requires the same local SQLite database. It does not see usage by other applications, databases or machines and does not combine different models' organization-wide limits. Configure one consistent scope for workers sharing an allowance. No key rotation, fallback provider or paid upgrade is enabled.

The [fresh live scheduler record](scheduler-live-verification.json) contains an actual Groq 429 with a 126-second Retry-After. The current run became Blocked; the following run stayed Queued with **zero model calls and no attempt**. Complete post-change live working/broken coverage was **not established** in this pair. Earlier successful real inference is preserved separately in [live-verification.md](live-verification.md) and [performance-live-verification.json](performance-live-verification.json).

## Reviewed archival and expiry

Retention is **off by default**, including in the main workspace used during this change. To choose a policy, edit server configuration and restart both the dashboard and worker:

```dotenv
RETENTION_DAYS=30
RETENTION_KEEP_RUNS=20
ARCHIVE_DIR=./data/archives
ARCHIVE_RETENTION_DAYS=0
```

`RETENTION_DAYS=0` disables retention. An enabled policy considers terminal runs older than that many days since their last update and protects the newest `RETENTION_KEEP_RUNS` runs. Active runs are excluded. Archive expiry is independently off at `ARCHIVE_RETENTION_DAYS=0`; a positive value measures age from archive creation and requires retention to be enabled. Working and archive directories must be separate and cannot contain each other.

Open **Evidence storage** in the sidebar. Review candidates, sizes and any missing files, then apply the preview. The API validates the preview token and queues a persisted maintenance job; the separate worker copies and verifies files. Reloading the page resumes job status. Each job handles at most 20 runs and 20 archives. Refresh and apply another reviewed batch if needed. There is no unattended periodic deletion timer.

For each run, archival acquires a maintenance lock, copies exact evidence files into a private staging directory, checks SHA-256 and sizes, saves a run snapshot and manifest, atomically renames the archive, then commits the mapping. Only after verification does it remove the exact working files. Reports, screenshot endpoints and trace downloads resolve archived evidence transparently. The database keeps attempts, events and assertions.

Archival relocates evidence; it does not compress files or reduce total disk usage when both directories are on the same volume. Put `ARCHIVE_DIR` on a suitable separate local volume to move the working footprint, or choose explicit archive expiry to reclaim total space. Back up SQLite and both evidence directories together.

If expiry is configured, the UI lists the selected archives and requires the review checkbox. Expiry verifies the manifest, snapshot, evidence checksums and file inventory before removing the managed archive. Unexpected files or symlinks stop it. Expired downloads return **HTTP 410**; reports explain unavailable evidence while preserving historical assertion outcomes. The CLI supports the same reviewed policy:

```sh
npm run retention
# Inspect that preview, then use its exact token:
npm run retention -- --apply --token=<reviewed-token>
```

Missing or changed evidence produces an error. A filesystem failure after the archive mapping commits can leave duplicate working files; the verified archive remains authoritative and the job reports a partial result. An interrupted maintenance job is recorded rather than silently resumed as a success. Refresh its preview before reapplying. Expiry persists a `purging` state so a partially removed archive can be finished on a later reviewed application. A hard power-loss recovery test was not performed.

## Incremental run updates

`GET /api/runs/:id` supplies a consistent snapshot and cursor. Active pages then call `GET /api/runs/:id/changes?after=<cursor>`. SQLite triggers journal run, attempt, event, assertion, artifact and model-call inserts/updates. Heartbeat-only lease updates do not create feed traffic.

Pages contain at most 200 journal entries and return entity upserts, a cursor and `hasMore`. They include completion changes to an existing running event. Unchanged responses omit historical entity arrays; current run/retry/quota headers remain small. The client merges by ID and drains all pages before stopping at a terminal status. Obsolete requests are aborted; polling is serial, stops at terminal status and revalidates on focus or explicit mutation.

Journal compaction retains recent changes after finalization/maintenance, without deleting the evidence ledger. A cursor below the compaction floor receives `reset: true` with a fresh snapshot. Invalid cursors return HTTP 400. This is incremental polling, not SSE or a distributed event broker.

## Retry availability

One store policy controls the UI, API and transactional retry. Only Failed, Blocked and Interrupted runs with remaining attempts and no active evidence maintenance lock can retry. The page disables exhausted retries and shows the reason. The API rechecks the policy and returns HTTP 409 with the same explanation if eligibility changes between display and click. Retrying creates fresh browser state and retains earlier evidence.

## Final test and recording

```sh
npm test
npm run typecheck
npm run lint
npm run test:e2e
npm run build
npm run test:improvements
```

The 28 automated tests include mocked provider HTTP checks across separate SQLite connections. The eight browser groups exercise actual Chromium against fixture decisions. The seven additional production UI groups use real Chromium, a separate worker and isolated fixture services/database on ports 3100, 4500 and 4501. They check incremental transfers, working and failed assertions, retry exhaustion, background archival, downloads/HTML after archival, reviewed expiry/410, mobile layout and request guards. Only the isolated test database is aged to make retention candidates. [Results](improvements-verification.json) and [initial test-harness failure](improvements-initial-verification.json) are preserved.

For a final manual test, open http://127.0.0.1:3000, verify the mode/model panel, run the working and broken scenarios, inspect all four assertion results, export HTML and download a trace. Confirm earlier evidence remains after retry and that the attempt limit is explained. Open Evidence storage to inspect the default disabled policy; enable retention only after choosing a policy you want applied to your own history.

For recording, use completed real live reports if provider quota is unavailable. Label fixture decisions explicitly when using the deterministic demo. Never show the credential file. See [the walkthrough](demo-script.md) for a concise recording sequence. No video, post or public deployment is created by these checks.
