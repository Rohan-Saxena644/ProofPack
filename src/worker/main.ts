import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../core/config';
import { Store } from '../db/store';
import { executeClaim } from '../execution/runner';
const config = loadConfig(),
  store = new Store(config),
  workerId = `${hostname()}-${randomUUID().slice(0, 8)}`;
const shutdown = new AbortController();
process.on('SIGINT', () => shutdown.abort());
process.on('SIGTERM', () => shutdown.abort());
console.log(`ProofPack worker ${workerId} · ${config.MODEL_MODE} mode · waiting for jobs`);
async function main() {
  while (!shutdown.signal.aborted) {
    const claim = store.claim(workerId);
    if (claim) {
      console.log(`Executing ${claim.run.id}, attempt ${claim.attempt.number}`);
      const result = await executeClaim(store, claim, undefined, shutdown.signal);
      console.log(`Run ${claim.run.id}: ${result.status}`);
    } else await new Promise((resolve) => setTimeout(resolve, 500));
  }
  store.close();
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'Worker stopped');
  store.close();
  process.exitCode = 1;
});
