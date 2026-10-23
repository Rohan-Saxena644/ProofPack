import type { RunDelta, RunDetail } from './contracts';

export function mergeRunDelta(current: RunDetail, update: RunDelta): RunDetail {
  if (update.reset) return update.detail;
  if (current.cursor !== undefined && update.cursor < current.cursor) return current;
  const merge = <T extends { id: string }>(old: T[], next: T[]) => {
    const rows = new Map(old.map((row) => [row.id, row]));
    for (const row of next) rows.set(row.id, row);
    return [...rows.values()];
  };
  return {
    ...update.detail,
    cursor: update.cursor,
    attempts: merge(current.attempts, update.detail.attempts).sort((a, b) => a.number - b.number),
    events: merge(current.events, update.detail.events),
    assertions: merge(current.assertions, update.detail.assertions),
    artifacts: merge(current.artifacts, update.detail.artifacts),
    modelCalls: merge(current.modelCalls, update.detail.modelCalls),
  };
}
