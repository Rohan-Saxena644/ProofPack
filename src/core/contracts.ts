import { z } from 'zod';

export const runInputSchema = z.strictObject({
  targetUrl: z.url().max(2000), brief: z.string().trim().min(12).max(4000),
  expected: z.string().trim().min(8).max(4000),
});
export type RunInput = z.infer<typeof runInputSchema>;
export const assertionSpecSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_-]{1,60}$/), description: z.string().min(1).max(300),
  kind: z.enum(['text_visible', 'url_is']), expected: z.string().min(1).max(500),
});
export const planSchema = z.strictObject({
  name: z.string().min(1).max(150),
  variables: z.array(z.enum(['email', 'password', 'project'])).min(1).max(3),
  goals: z.array(z.strictObject({ instruction: z.string().min(1).max(600), assertions: z.array(z.string()).max(10) })).min(1).max(15),
  successCriteria: z.array(z.string().min(1).max(400)).min(1).max(12),
  assertions: z.array(assertionSpecSchema).min(1).max(12),
}).superRefine((p, ctx) => {
  const ids = p.assertions.map(a => a.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Duplicate assertion IDs' });
  const assignments = p.goals.flatMap(g => g.assertions);
  if (assignments.some(a => !ids.includes(a)) || ids.some(id => assignments.filter(a => a === id).length !== 1))
    ctx.addIssue({ code: 'custom', message: 'Each required assertion must belong to exactly one goal' });
});
export type Plan = z.infer<typeof planSchema>;
const description = z.string().min(1).max(300);
export const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('fill'), controlId: z.string().max(20), value: z.string().max(500), description }),
  z.strictObject({ type: z.literal('click'), controlId: z.string().max(20), description }),
  z.strictObject({ type: z.literal('select'), controlId: z.string().max(20), value: z.string().max(500), description }),
  z.strictObject({ type: z.literal('navigate'), url: z.string().max(2000), description }),
  z.strictObject({ type: z.literal('assert'), assertionId: z.string().max(60), description }),
  z.strictObject({ type: z.literal('capture'), description }),
  z.strictObject({ type: z.literal('fresh_context'), description }),
  z.strictObject({ type: z.literal('complete_goal'), description }),
]);
export type Action = z.infer<typeof actionSchema>;
export type Status = 'queued' | 'planning' | 'running' | 'passed' | 'failed' | 'blocked' | 'interrupted' | 'cancelled';
export const terminal = ['passed', 'failed', 'blocked', 'interrupted', 'cancelled'] as const;
export interface Control { id: string; role: string; name: string; tag: string; inputType: string; testId: string | null; secret: boolean; options: string[] }
export interface Observation { url: string; text: string; controls: Control[] }
export interface RunRecord { id: string; targetUrl: string; brief: string; expected: string; status: Status; createdAt: number; updatedAt: number; mode: 'fixture' | 'live'; model: string; provider: string; cancelRequested: boolean; attemptCount: number }
export interface AttemptRecord { id: string; runId: string; number: number; status: Status; worker: string; leaseUntil: number; startedAt: number; finishedAt: number | null; error: string | null; plan: Plan | null }
export interface EventRecord { id: string; attemptId: string; type: string; description: string; startedAt: number; finishedAt: number | null; outcome: string; data: Record<string, unknown> }
export interface AssertionRecord { id: string; attemptId: string; specId: string; description: string; kind: string; expected: string; actual: string; passed: boolean; evidenceIds: string[]; createdAt: number }
export interface ArtifactRecord { id: string; attemptId: string; kind: 'screenshot' | 'trace'; filename: string; label: string; createdAt: number }
export interface ModelCall { id: string; attemptId: string; stage: string; provider: string; model: string; latencyMs: number; inputTokens: number | null; outputTokens: number | null; valid: boolean; error: string | null }
export interface RunDetail { run: RunRecord; attempts: AttemptRecord[]; events: EventRecord[]; assertions: AssertionRecord[]; artifacts: ArtifactRecord[]; modelCalls: ModelCall[] }
