import { loadConfig } from '../core/config';
import { Store } from '../db/store';
const globalStore = globalThis as unknown as { proofpackStore?: Store };
export function getStore() { return globalStore.proofpackStore ??= new Store(loadConfig()); }
export function localRequest(request: Request, mutation = false) {
  const url = new URL(request.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return false;
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return false;
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  if (mutation && !request.headers.get('content-type')?.includes('application/json')) return false;
  return true;
}
export const forbidden = () => Response.json({ error: 'Only same-origin requests to the local dashboard are accepted.' }, { status: 403 });
