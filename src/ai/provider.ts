import { z } from 'zod';
import type { Config } from '../core/config';

// Documented strict-output models, checked 2026-10-23. Discovery still checks
// account availability. Unknown Groq models use explicit JSON object mode in auto.
const groqStrictModels = new Set([
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
  'meta-models/muse-spark-open',
]);
export const groqFormat = (model: string) =>
  groqStrictModels.has(model) ? 'json_schema' : 'json_object';
export function groqSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(groqSchema);
  if (!schema || typeof schema !== 'object') return schema;
  // Groq documents enums/anyOf, while Zod emits const/oneOf for our action
  // union. Action branches have distinct type literals, so anyOf is equivalent.
  // Length/pattern constraints remain enforced by application-level Zod checks.
  return Object.fromEntries(
    Object.entries(schema).flatMap(([key, value]) => {
      if (
        ['$schema', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format'].includes(
          key,
        )
      )
        return [];
      if (key === 'const') return [['enum', [value]]];
      return [[key === 'oneOf' ? 'anyOf' : key, groqSchema(value)]];
    }),
  );
}
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs = 0,
  ) {
    super(
      status === 429
        ? `Model provider rate limited the request (HTTP 429). Retry delay: ${Math.ceil(retryAfterMs / 1000)}s.`
        : `Model provider returned HTTP ${status}. Response body omitted to protect credentials.`,
    );
  }
}
export async function discoverModel(c: Config, signal: AbortSignal) {
  if (c.MODEL_PROVIDER === 'groq' && !c.MODEL_API_KEY)
    throw new Error(
      `Live ${c.MODEL_PROVIDER} mode requires MODEL_API_KEY. No fixture fallback was used.`,
    );
  const response = await fetch(`${c.MODEL_BASE_URL.replace(/\/$/, '')}/models`, {
    signal,
    headers: c.MODEL_API_KEY ? { Authorization: `Bearer ${c.MODEL_API_KEY}` } : {},
  });
  if (!response.ok)
    throw new ProviderError(
      response.status,
      response.status === 429 ? retryDelay(response.headers.get('retry-after')) : 0,
    );
  const catalog = z
    .object({
      data: z.array(
        z.object({
          id: z.string(),
          active: z.boolean().optional(),
          context_window: z.number().optional(),
          context_length: z.number().optional(),
          supported_parameters: z.array(z.string()).optional(),
        }),
      ),
    })
    .parse(await response.json());
  const model = catalog.data.find((m) => m.id === c.MODEL_ID && m.active !== false);
  if (!model)
    throw new Error('Configured model is not active in the provider catalog for this account.');
  const format =
    c.MODEL_PROVIDER === 'groq'
      ? groqFormat(model.id)
      : c.MODEL_PROVIDER === 'openrouter'
        ? model.supported_parameters?.includes('structured_outputs')
          ? 'json_schema'
          : model.supported_parameters?.includes('response_format')
            ? 'json_object'
            : 'none'
        : c.MODEL_FORMAT === 'auto'
          ? 'none'
          : c.MODEL_FORMAT;
  return {
    id: model.id,
    provider: c.MODEL_PROVIDER,
    format,
    contextLength: model.context_window ?? model.context_length ?? null,
    supportedParameters: model.supported_parameters ?? null,
  };
}
export function retryDelay(header: string | null) {
  if (!header) return 1000;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Math.max(0, Number.isFinite(ms) ? ms : 1000);
}
