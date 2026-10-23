import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Store } from '../db/store';
import { quotaScope, durationMs } from '../core/quota';
import { retryDelay } from './provider';

interface Budget {
  scope: string;
  owner: string | null;
  leaseUntil: number;
  nextAt: number;
  cooldownUntil: number;
  tokenLimit: number | null;
  tokens: number | null;
  updatedAt: number;
  requests: number | null;
  requestsResetAt: number | null;
}
export class QuotaUnavailable extends Error {}
export class QuotaGate {
  readonly scope: string;
  constructor(
    readonly store: Store,
    readonly attemptId?: string,
  ) {
    this.scope = quotaScope(store.config);
  }
  reserve(tokens: number, owner: string, now = Date.now()) {
    return this.store.sqlite
      .transaction(() => {
        this.store.sqlite
          .prepare('INSERT OR IGNORE INTO provider_budgets(scope,updatedAt) VALUES (?,?)')
          .run(this.scope, now);
        const row = this.store.sqlite
          .prepare('SELECT * FROM provider_budgets WHERE scope=?')
          .get(this.scope) as Budget;
        if (row.owner && row.leaseUntil > now)
          return {
            waitMs: Math.min(250, row.leaseUntil - now),
            reason: 'Another worker is using this provider quota.',
          };
        let readyAt = Math.max(row.nextAt, row.cooldownUntil);
        if (row.requests === 0 && row.requestsResetAt && row.requestsResetAt > now)
          readyAt = Math.max(readyAt, row.requestsResetAt);
        let available = row.tokens;
        if (row.tokenLimit && available !== null) {
          if (tokens > row.tokenLimit)
            throw new QuotaUnavailable(
              'Estimated model request exceeds the provider token-per-minute allowance. Reduce the observation or use a larger allowance. No inference request dispatched.',
            );
          available = Math.min(
            row.tokenLimit,
            available + (Math.max(0, now - row.updatedAt) * row.tokenLimit) / 60000,
          );
          if (available < tokens)
            readyAt = Math.max(
              readyAt,
              now + Math.ceil(((tokens - available) * 60000) / row.tokenLimit) + 250,
            );
        }
        if (readyAt > now)
          return {
            waitMs: readyAt - now,
            reason: 'Waiting for the shared provider allowance to recover.',
          };
        this.store.sqlite
          .prepare(
            'UPDATE provider_budgets SET owner=?,leaseUntil=?,nextAt=?,tokens=?,updatedAt=? WHERE scope=?',
          )
          .run(
            owner,
            now + this.store.config.MODEL_TIMEOUT_MS + 5000,
            now + this.store.config.MODEL_MIN_INTERVAL_MS,
            available === null ? null : Math.max(0, available - tokens),
            now,
            this.scope,
          );
        return { waitMs: 0, reason: '' };
      })
      .immediate();
  }
  async acquire(tokens: number, signal: AbortSignal) {
    const owner = randomUUID(),
      started = Date.now();
    let lastNotice = 0;
    for (;;) {
      signal.throwIfAborted();
      const result = this.reserve(tokens, owner);
      if (!result.waitMs) return owner;
      const remaining = this.store.config.MODEL_MAX_QUOTA_WAIT_MS - (Date.now() - started);
      if (result.waitMs > remaining)
        throw new QuotaUnavailable(
          `Shared provider quota requires a longer wait than this run permits. No inference request dispatched. Retry after the provider cooldown.`,
        );
      if (this.attemptId && Date.now() - lastNotice > 1000) {
        this.store.event(this.attemptId, 'model_wait', result.reason, {
          retryAt: Date.now() + result.waitMs,
          waitMs: result.waitMs,
          sharedQuota: true,
        });
        lastNotice = Date.now();
      }
      await delay(result.waitMs, undefined, { signal });
    }
  }
  release(owner: string, headers?: Headers, status?: number, now = Date.now()) {
    const number = (name: string) => {
      const raw = headers?.get(name);
      if (raw === null || raw === undefined || raw.trim() === '') return null;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const limit = number('x-ratelimit-limit-tokens'),
      tokens = number('x-ratelimit-remaining-tokens');
    const requests = number('x-ratelimit-remaining-requests');
    const reset = durationMs(headers?.get('x-ratelimit-reset-requests') ?? null);
    // Retry-After is authoritative, including long cooldowns. Other workers must
    // see it even when the current attempt cannot wait that long.
    const cooldown =
      status === 429 ? now + retryDelay(headers?.get('retry-after') ?? null) + 1000 : 0;
    this.store.sqlite
      .prepare(
        `UPDATE provider_budgets SET owner=NULL,leaseUntil=0,cooldownUntil=MAX(cooldownUntil,?),tokenLimit=COALESCE(?,tokenLimit),tokens=COALESCE(?,tokens),requests=COALESCE(?,requests),requestsResetAt=COALESCE(?,requestsResetAt),updatedAt=? WHERE scope=? AND owner=?`,
      )
      .run(
        cooldown,
        limit && limit > 0 ? limit : null,
        tokens,
        requests,
        reset === null ? null : now + reset,
        now,
        this.scope,
        owner,
      );
  }
}
