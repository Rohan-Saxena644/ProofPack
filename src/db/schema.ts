import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import type { Status, Plan } from '../core/contracts';
export const runs = sqliteTable('runs', {
  id: text().primaryKey(),
  targetUrl: text().notNull(),
  brief: text().notNull(),
  expected: text().notNull(),
  status: text().$type<Status>().notNull(),
  createdAt: integer().notNull(),
  updatedAt: integer().notNull(),
  mode: text().$type<'fixture' | 'live'>().notNull(),
  model: text().notNull(),
  provider: text().notNull(),
  cancelRequested: integer({ mode: 'boolean' }).notNull().default(false),
  attemptCount: integer().notNull().default(0),
});
export const attempts = sqliteTable('attempts', {
  id: text().primaryKey(),
  runId: text()
    .notNull()
    .references(() => runs.id),
  number: integer().notNull(),
  status: text().$type<Status>().notNull(),
  worker: text().notNull(),
  leaseUntil: integer().notNull(),
  startedAt: integer().notNull(),
  finishedAt: integer(),
  error: text(),
  plan: text({ mode: 'json' }).$type<Plan>(),
});
