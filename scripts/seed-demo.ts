import { loadConfig } from '../src/core/config';
import { Store } from '../src/db/store';
import { executeClaim } from '../src/execution/runner';
const cfg = loadConfig();
if (cfg.MODEL_MODE !== 'fixture') throw new Error('Demo seeding requires explicit MODEL_MODE=fixture. Use the dashboard for live runs.');
const store = new Store(cfg);
try {
  for (const port of [4100, 4101]) {
    const run = store.create({ targetUrl: `http://127.0.0.1:${port}`, brief: 'Register a new account, create a project named Moonbase, log out, use a fresh browser session, log in, and verify the project persists.', expected: 'The project appears after creation and is still visible after a fresh login.' });
    const claim = store.claim('demo-seeder');
    if (!claim || claim.run.id !== run.id) throw new Error('Other jobs are queued. Stop the worker and seed an idle queue.');
    const result = await executeClaim(store, claim);
    console.log(`Executed ${port}: ${result.status} · http://127.0.0.1:3000/runs/${run.id}`);
    if (result.status !== (port === 4100 ? 'passed' : 'failed')) throw new Error(result.error ?? 'Unexpected demo outcome. Are LaunchDesk instances running?');
  }
} finally { store.close(); }
