import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/core/config';
import { actionSchema } from '../src/core/contracts';
import { fixturePlan, type DecisionInput } from '../src/ai/fixture';
import { LiveAdapter } from '../src/ai/model';

const label = process.argv[2];
if (!['before', 'after'].includes(label)) throw new Error('Specify before or after.');
const config = loadConfig();
assert.equal(
  config.MODEL_MODE,
  'live',
  'This diagnostic requires explicitly configured live mode.',
);
const payload: DecisionInput = {
  goalIndex: 0,
  goal: {
    instruction:
      'Register a new account using {{email}} and {{password}}. Registration has already been submitted successfully.',
    assertions: [],
  },
  observation: {
    url: 'http://127.0.0.1:4100/projects',
    text: 'Your projects. No projects yet.',
    controls: [
      {
        id: 'c1',
        role: 'button',
        name: 'Log out',
        tag: 'button',
        inputType: 'submit',
        testId: null,
        secret: false,
        filled: false,
        required: false,
        formId: 'logout',
        options: [],
      },
    ],
  },
  history: [],
  executedSteps: [
    {
      action: { type: 'click', controlId: 'old-submit', description: 'Submit registration' },
      urlBefore: 'http://127.0.0.1:4100/register',
      urlAfter: 'http://127.0.0.1:4100/projects',
    },
  ],
  completedAssertions: [],
  plan: fixturePlan,
};
const reply = await new LiveAdapter(config).request(
  'decision',
  payload,
  actionSchema,
  null,
  AbortSignal.timeout(config.MODEL_TIMEOUT_MS),
);
const action = actionSchema.parse(reply.value);
assert.equal(action.type, 'complete_goal');
const result = {
  measuredAt: new Date().toISOString(),
  label,
  provider: reply.provider,
  model: reply.model,
  payloadSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  inputTokens: reply.inputTokens ?? null,
  outputTokens: reply.outputTokens ?? null,
  action: action.type,
};
await mkdir('data/performance', { recursive: true });
if (label === 'before')
  await writeFile('data/performance/model-prompt-baseline.json', JSON.stringify(result, null, 2));
else {
  const before = JSON.parse(await readFile('data/performance/model-prompt-baseline.json', 'utf8'));
  assert.equal(before.payloadSha256, result.payloadSha256);
  assert.equal(before.model, result.model);
  assert.equal(before.provider, result.provider);
  await writeFile(
    'docs/prompt-efficiency-verification.json',
    JSON.stringify(
      {
        note: 'Two actual provider decisions on the identical synthetic observation, not browser execution or a reliability benchmark. Usage is provider-reported; no cost inferred.',
        before,
        after: result,
      },
      null,
      2,
    ) + '\n',
  );
}
console.log(JSON.stringify(result, null, 2));
