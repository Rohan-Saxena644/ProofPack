import { createHash } from 'node:crypto';
import type { Config } from './config';

export function quotaScope(c: Config) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        c.MODEL_PROVIDER,
        c.MODEL_BASE_URL.replace(/\/$/, ''),
        c.MODEL_ID,
        c.MODEL_QUOTA_GROUP,
      ]),
    )
    .digest('hex');
}
export function durationMs(value: string | null): number | null {
  if (!value) return null;
  let total = 0,
    consumed = '';
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) {
    consumed += match[0];
    total += Number(match[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]]!;
  }
  return consumed === value && Number.isFinite(total) ? total : null;
}
