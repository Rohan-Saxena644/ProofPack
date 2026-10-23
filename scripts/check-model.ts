import { loadConfig } from '../src/core/config';
const c = loadConfig();
if (c.MODEL_PROVIDER === 'openrouter') {
  const response = await fetch(`${c.MODEL_BASE_URL.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(c.MODEL_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Catalog returned HTTP ${response.status}`);
  const catalog = await response.json(), model = catalog.data?.find((m: { id: string }) => m.id === c.MODEL_ID);
  if (!model) throw new Error('MODEL_ID is unavailable in the configured catalog.');
  console.log(JSON.stringify({ id: model.id, supportedParameters: model.supported_parameters, contextLength: model.context_length, note: 'Catalog check only. This does not verify inference or account access.' }, null, 2));
} else {
  const response = await fetch(`${c.MODEL_BASE_URL.replace(/\/$/, '')}/models`, { headers: c.MODEL_API_KEY ? { Authorization: `Bearer ${c.MODEL_API_KEY}` } : {}, signal: AbortSignal.timeout(c.MODEL_TIMEOUT_MS) });
  console.log(`Local model discovery HTTP ${response.status}. Configure MODEL_FORMAT for your server. Inference is verified by executing a live run.`);
  if (!response.ok) process.exitCode = 1;
}
