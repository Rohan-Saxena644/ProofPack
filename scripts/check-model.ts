import { loadConfig } from '../src/core/config';
import { discoverModel } from '../src/ai/provider';
const c = loadConfig();
if (c.MODEL_PROVIDER !== 'local') {
  const model = await discoverModel(c, AbortSignal.timeout(c.MODEL_TIMEOUT_MS));
  console.log(
    JSON.stringify(
      {
        id: model.id,
        provider: model.provider,
        outputFormat: model.format,
        supportedParameters: model.supportedParameters,
        contextLength: model.contextLength,
        note: 'Catalog check only. A live run is required to verify inference and model-serving access.',
      },
      null,
      2,
    ),
  );
} else {
  const response = await fetch(`${c.MODEL_BASE_URL.replace(/\/$/, '')}/models`, {
    headers: c.MODEL_API_KEY ? { Authorization: `Bearer ${c.MODEL_API_KEY}` } : {},
    signal: AbortSignal.timeout(c.MODEL_TIMEOUT_MS),
  });
  console.log(
    `Local model discovery HTTP ${response.status}. Configure MODEL_FORMAT for your server. Inference is verified by executing a live run.`,
  );
  if (!response.ok) process.exitCode = 1;
}
