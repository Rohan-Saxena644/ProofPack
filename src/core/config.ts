import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const integer = (fallback: number, min = 1) => z.coerce.number().int().min(min).default(fallback);
const envSchema = z.object({
  MODEL_MODE: z.enum(['fixture', 'live']).default('fixture'),
  MODEL_PROVIDER: z.enum(['openrouter', 'groq', 'local']).default('openrouter'),
  MODEL_BASE_URL: z.url().default('https://openrouter.ai/api/v1'),
  MODEL_ID: z.string().default('google/gemma-3-27b-it'),
  MODEL_API_KEY: z.string().default(''),
  MODEL_FORMAT: z.enum(['auto', 'json_schema', 'json_object', 'none']).default('auto'),
  MODEL_TIMEOUT_MS: integer(30000),
  MAX_MODEL_CALLS: integer(80),
  MAX_ACTIONS: integer(65),
  RUN_TIMEOUT_MS: integer(180000),
  ACTION_TIMEOUT_MS: integer(6000),
  LEASE_MS: integer(15000, 300),
  MAX_ATTEMPTS: integer(2),
  ALLOWED_TARGET_ORIGINS: z.string().default('http://127.0.0.1:4100,http://127.0.0.1:4101'),
  DATABASE_PATH: z.string().default('./data/proofpack.sqlite'),
  ARTIFACT_DIR: z.string().default('./artifacts'),
});
export function loadConfig(overrides: Partial<z.input<typeof envSchema>> = {}) {
  const source = { ...process.env, ...overrides };
  const providerDefaults =
    source.MODEL_PROVIDER === 'groq'
      ? { MODEL_BASE_URL: 'https://api.groq.com/openai/v1', MODEL_ID: 'openai/gpt-oss-120b' }
      : {};
  const e = envSchema.parse({ ...providerDefaults, ...source });
  return {
    ...e,
    databasePath: path.resolve(e.DATABASE_PATH),
    artifactDir: path.resolve(e.ARTIFACT_DIR),
    origins: e.ALLOWED_TARGET_ORIGINS.split(',').map((s) => new URL(s.trim()).origin),
  };
}
export type Config = ReturnType<typeof loadConfig>;
export function publicConfig(c: Config) {
  return {
    mode: c.MODEL_MODE,
    provider: c.MODEL_MODE === 'fixture' ? 'fixture' : c.MODEL_PROVIDER,
    model: c.MODEL_MODE === 'fixture' ? 'launchdesk-fixture-v1' : c.MODEL_ID,
    ready: c.MODEL_MODE === 'fixture' || c.MODEL_PROVIDER === 'local' || Boolean(c.MODEL_API_KEY),
    origins: c.origins,
    limits: { actions: c.MAX_ACTIONS, modelCalls: c.MAX_MODEL_CALLS, timeoutMs: c.RUN_TIMEOUT_MS },
  };
}
