import { loadConfig } from '../src/core/config';
import { Store } from '../src/db/store';
import { applyRetention, previewRetention } from '../src/storage/retention';
const store = new Store(loadConfig());
try {
  const preview = await previewRetention(store);
  if (process.argv.includes('--apply')) {
    const token = process.argv.find((arg) => arg.startsWith('--token='))?.slice(8);
    if (!token) throw new Error('Preview first, then pass --apply --token=<preview token>.');
    console.log(JSON.stringify(await applyRetention(store, token), null, 2));
  } else console.log(JSON.stringify(preview, null, 2));
} finally {
  store.close();
}
