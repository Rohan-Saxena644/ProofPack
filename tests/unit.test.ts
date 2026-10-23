import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/core/config';
import { actionSchema, planSchema, type Observation, type Action } from '../src/core/contracts';
import { fixturePlan } from '../src/ai/fixture';
import { Store } from '../src/db/store';
import { allowedUrl } from '../src/execution/boundaries';
import { assertionOutcome } from '../src/execution/runner';
import { markdownReport, htmlReport, reportData } from '../src/reports/report';
import { localRequest } from '../src/server/service';
import { LiveAdapter, FixtureAdapter, ModelSession } from '../src/ai/model';
import { discoverModel, groqFormat, ProviderError, retryDelay } from '../src/ai/provider';
import { redactTraceArchive } from '../src/execution/trace';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { validateProgress } from '../src/execution/guards';

const origins = ['http://127.0.0.1:4100'];
const decisionInput = {
  goalIndex: 0,
  goal: fixturePlan.goals[0],
  observation: { url: origins[0], text: '', controls: [] },
  history: [],
  executedSteps: [
    {
      action: {
        type: 'click' as const,
        controlId: 'old-submit',
        description: 'Submit registration',
      },
      urlBefore: `${origins[0]}/register`,
      urlAfter: `${origins[0]}/projects`,
      locator: 'role=button, name=Create account',
    },
  ],
  completedAssertions: [],
  plan: fixturePlan,
};
test('fixture planning rejects custom requests instead of ignoring user intent', async () => {
  await assert.rejects(
    new FixtureAdapter().request('plan', {
      targetUrl: origins[0],
      brief: 'Create a project then delete it and log in',
      expected: 'Project must be deleted',
    }),
    /exact built-in/,
  );
});
const input = {
  targetUrl: origins[0],
  brief: 'Create a project and log out then log in',
  expected: 'The project should persist',
};
function store() {
  mkdirSync('data', { recursive: true });
  const dir = mkdtempSync(path.resolve('data/unit-'));
  return new Store(
    loadConfig({
      DATABASE_PATH: path.join(dir, 'test.sqlite'),
      ARTIFACT_DIR: path.join(dir, 'artifacts'),
      MODEL_MODE: 'fixture',
    }),
  );
}
test('action vocabulary rejects code, unknown fields and unsupported actions', () => {
  assert.equal(actionSchema.safeParse({ type: 'evaluate', code: 'process.exit()' }).success, false);
  assert.equal(
    actionSchema.safeParse({
      type: 'click',
      controlId: 'c1',
      description: 'Click',
      javascript: 'bad',
    }).success,
    false,
  );
  assert.equal(
    actionSchema.safeParse({ type: 'click', controlId: 'c1', description: 'Click' }).success,
    true,
  );
});
test('empty form submits are rejected without blocking logout in another form', () => {
  const observation: Observation = {
    url: origins[0],
    text: 'Your projects',
    controls: [
      {
        id: 'project',
        role: 'textbox',
        name: 'Project name',
        tag: 'input',
        inputType: 'text',
        testId: null,
        secret: false,
        filled: false,
        required: true,
        formId: 'project-form',
        options: [],
      },
      {
        id: 'create',
        role: 'button',
        name: 'Create project',
        tag: 'button',
        inputType: 'submit',
        testId: null,
        secret: false,
        filled: false,
        required: false,
        formId: 'project-form',
        options: [],
      },
      {
        id: 'logout',
        role: 'button',
        name: 'Log out',
        tag: 'button',
        inputType: 'submit',
        testId: null,
        secret: false,
        filled: false,
        required: false,
        formId: 'logout-form',
        options: [],
      },
    ],
  };
  assert.throws(
    () =>
      validateProgress(
        { type: 'click', controlId: 'create', description: 'Submit' },
        observation,
        [],
        '',
      ),
    /Required fields/,
  );
  assert.doesNotThrow(() =>
    validateProgress(
      { type: 'click', controlId: 'logout', description: 'Log out' },
      observation,
      [],
      '',
    ),
  );
});
test('unchanged repeated actions and repeated context resets are bounded', () => {
  const observation: Observation = { url: origins[0], text: 'Same page', controls: [] };
  const navigation: Action = { type: 'navigate', url: origins[0], description: 'Open page' };
  assert.throws(
    () =>
      validateProgress(
        { ...navigation, description: 'Try again' },
        observation,
        [navigation],
        JSON.stringify(observation),
      ),
    /did not change/,
  );
  assert.doesNotThrow(() =>
    validateProgress(navigation, observation, [navigation], 'different previous page'),
  );
  assert.throws(
    () =>
      validateProgress(
        { type: 'fresh_context', description: 'Reset again' },
        observation,
        [{ type: 'fresh_context', description: 'Reset' }],
        '',
      ),
    /already started/,
  );
});
test('plans require explicit nonduplicated assertions assigned once', () => {
  assert.equal(planSchema.safeParse(fixturePlan).success, true);
  assert.equal(
    planSchema.safeParse({
      name: 'Heading check',
      variables: [],
      goals: [{ instruction: 'Check the requested heading', assertions: ['heading'] }],
      successCriteria: ['Boundary check is visible'],
      assertions: [
        {
          id: 'heading',
          description: 'Requested heading',
          kind: 'text_visible',
          expected: 'Boundary check',
        },
      ],
    }).success,
    true,
  );
  assert.equal(planSchema.safeParse({ ...fixturePlan, assertions: [] }).success, false);
  const plan = structuredClone(fixturePlan);
  plan.goals[0].assertions.push('persisted');
  assert.equal(planSchema.safeParse(plan).success, false);
});
test('origin checks reject credentials, schemes, metadata and unintended ports', () => {
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hi',
    'http://127.0.0.1:4101',
    'http://127.0.0.1:4100.evil.test',
    'http://user:secret@127.0.0.1:4100',
    'http://169.254.169.254/latest/meta-data',
  ])
    assert.equal(allowedUrl(url, origins), false, url);
  assert.equal(allowedUrl('http://127.0.0.1:4100/projects', origins), true);
  assert.equal(allowedUrl('http://169.254.169.254', ['http://169.254.169.254']), false);
});
test('ledger cannot pass with missing or contradicted checks', () => {
  assert.equal(assertionOutcome(['a'], []), 'blocked');
  assert.equal(assertionOutcome([], []), 'blocked');
  assert.equal(assertionOutcome(['a'], [{ specId: 'a', passed: false }]), 'failed');
  assert.equal(assertionOutcome(['a'], [{ specId: 'a', passed: true }]), 'passed');
});
test('transactional claims are exclusive across connections; expired attempts remain interrupted', () => {
  const a = store(),
    b = new Store(a.config);
  try {
    const run = a.create(input),
      first = a.claim('worker-a')!;
    assert.equal(b.claim('worker-b'), null);
    const openStep = a.event(first.attempt.id, 'step', 'In-flight browser action', {}, 'running');
    b.reap(first.attempt.leaseUntil + 1);
    assert.equal(a.get(run.id)?.status, 'interrupted');
    a.endEvent(openStep, 'passed', {});
    assert.equal(a.detail(run.id)!.events.find((e) => e.id === openStep)?.outcome, 'interrupted');
    assert.equal(a.heartbeat(first.attempt.id), false);
    assert.equal(a.retry(run.id), true);
    const second = b.claim('worker-b')!;
    assert.equal(second.attempt.number, 2);
    assert.notEqual(first.attempt.id, second.attempt.id);
    b.finish(second.attempt.id, 'blocked', 'Unavailable');
    assert.equal(a.retry(run.id), false);
    assert.equal(a.detail(run.id)?.attempts[0].status, 'interrupted');
  } finally {
    a.close();
    b.close();
  }
});
test('lease reaping isolates expired active work from fresh and completed attempts', () => {
  const s = store();
  try {
    const claims = Array.from({ length: 4 }, () => {
      s.create(input);
      return s.claim('lease-test')!;
    });
    const now = Date.now();
    s.setPlan(claims[1].attempt.id, fixturePlan);
    s.cancel(claims[2].run.id);
    s.finish(claims[3].attempt.id, 'blocked', 'Original failure');
    for (const index of [0, 2])
      s.sqlite
        .prepare('UPDATE attempts SET leaseUntil=? WHERE id=?')
        .run(now - 1, claims[index].attempt.id);
    s.reap(now);
    assert.deepEqual(
      claims.map((c) => s.get(c.run.id)?.status),
      ['interrupted', 'running', 'cancelled', 'blocked'],
    );
    assert.equal(s.detail(claims[3].run.id)!.attempts[0].error, 'Original failure');
  } finally {
    s.close();
  }
});
test('evidence references must belong to the current attempt', () => {
  const s = store();
  try {
    s.create(input);
    const c = s.claim('test')!;
    assert.throws(
      () =>
        s.assertion({
          attemptId: c.attempt.id,
          specId: 'created',
          description: 'Check',
          kind: 'text_visible',
          expected: 'Project',
          actual: 'Missing',
          passed: false,
          evidenceIds: ['nonexistent'],
        }),
      /Invalid evidence/,
    );
    const a = s.artifact(c.attempt.id, 'screenshot', 'missing.png', 'Check');
    s.assertion({
      attemptId: c.attempt.id,
      specId: 'created',
      description: 'Check',
      kind: 'text_visible',
      expected: 'Project',
      actual: 'Missing',
      passed: false,
      evidenceIds: [a.id],
    });
    assert.equal(s.detail(c.run.id)!.assertions[0].passed, false);
  } finally {
    s.close();
  }
});
test('reports derive passed status from immutable checks and escape hostile target text', () => {
  const s = store();
  try {
    const run = s.create({ ...input, brief: '<script>alert(1)</script> project and login' });
    const c = s.claim('test')!;
    s.setPlan(c.attempt.id, fixturePlan);
    s.finish(c.attempt.id, 'passed');
    const d = s.detail(run.id)!;
    assert.equal(d.run.status, 'blocked');
    d.run.status = 'passed'; // Defense in depth against a corrupt/imported status.
    assert.equal(reportData(d).outcome, 'blocked');
    assert.match(markdownReport(d), /Outcome: BLOCKED/);
    assert.match(markdownReport(d), /FIXTURE MODE/);
    assert.ok(!htmlReport(d, s.config.artifactDir).includes('<script>'));
    d.run.status = 'failed';
    assert.equal(reportData(d).outcome, 'failed');
    d.assertions.push({
      id: 'fake',
      attemptId: c.attempt.id,
      specId: 'created',
      description: 'x',
      kind: 'text_visible',
      expected: 'x',
      actual: 'x',
      passed: true,
      evidenceIds: ['forged'],
      createdAt: 0,
    });
    assert.throws(() => reportData(d), /invalid evidence/);
  } finally {
    s.close();
  }
});
test('dashboard rejects cross-origin writes and nonlocal hosts', () => {
  assert.equal(
    localRequest(
      new Request('http://localhost:3000/api/runs', {
        headers: {
          host: '127.0.0.1:3000',
          origin: 'http://127.0.0.1:3000',
          'Content-Type': 'application/json',
        },
      }),
      true,
    ),
    true,
  );
  assert.equal(
    localRequest(
      new Request('http://127.0.0.1:3000/api/runs', {
        method: 'POST',
        headers: { origin: 'https://evil.test', 'Content-Type': 'application/json' },
      }),
      true,
    ),
    false,
  );
  assert.equal(localRequest(new Request('http://evil.test/api/runs')), false);
  assert.equal(
    localRequest(
      new Request('http://127.0.0.1:3000/api/runs', {
        headers: { 'Content-Type': 'application/json', origin: 'http://127.0.0.1:3000' },
      }),
      true,
    ),
    true,
  );
});
test('trace sanitation removes secrets, session cookies and auth headers before download', () => {
  const archive = zipSync({
    'trace.network': strToU8(
      JSON.stringify({
        request: {
          headers: [{ name: 'Cookie', value: 'ld_session=abc' }],
          cookies: [{ name: 'ld_session', value: 'abc' }],
          postData: { text: 'password=synthetic-secret' },
        },
        response: { headers: [{ name: 'Set-Cookie', value: 'ld_session=abc' }] },
      }),
    ),
    'resources/body': strToU8('synthetic-secret api-secret'),
  });
  const cleaned = unzipSync(redactTraceArchive(archive, ['synthetic-secret', 'api-secret']));
  const text = Object.values(cleaned)
    .map((v) => strFromU8(v))
    .join('');
  assert.ok(!text.includes('synthetic-secret'));
  assert.ok(!text.includes('api-secret'));
  assert.ok(!text.includes('ld_session=abc'));
  assert.deepEqual(JSON.parse(strFromU8(cleaned['trace.network'])).request.cookies, []);
});
test('live adapter sends schema, records actual provider metadata, and unwraps decisions', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.response_format.type, 'json_schema');
      assert.equal(body.messages[0].role, 'system');
      assert.ok(!body.messages[0].content.includes('JSON Schema:'));
      assert.ok(body.messages[0].content.includes('assert(assertionId)'));
      return Response.json({
        model: 'test-actual-model',
        provider: 'actual-provider',
        usage: { prompt_tokens: 20, completion_tokens: 12 },
        choices: [
          {
            message: {
              content: JSON.stringify({
                action: { type: 'capture', description: 'Collect evidence' },
              }),
            },
          },
        ],
      });
    };
    const adapter = new LiveAdapter(
      loadConfig({
        MODEL_MODE: 'live',
        MODEL_PROVIDER: 'local',
        MODEL_FORMAT: 'json_schema',
        MODEL_BASE_URL: 'http://127.0.0.1:9999/v1',
      }),
    );
    const reply = await adapter.request(
      'decision',
      decisionInput,
      actionSchema,
      null,
      new AbortController().signal,
    );
    assert.equal(reply.provider, 'actual-provider');
    assert.equal(reply.model, 'test-actual-model');
    assert.equal(reply.inputTokens, 20);
    assert.equal(actionSchema.parse(reply.value).type, 'capture');
  } finally {
    globalThis.fetch = original;
  }
});
test('Groq discovers account models and sends strict output with reasoning token budget', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-key');
      if (String(url).endsWith('/models'))
        return Response.json({
          data: [{ id: 'openai/gpt-oss-20b', active: true, context_window: 131072 }],
        });
      const body = JSON.parse(String(init?.body));
      assert.equal(body.response_format.json_schema.strict, true);
      assert.ok(body.response_format.json_schema.schema.properties.action.anyOf);
      assert.ok(!JSON.stringify(body.response_format.json_schema.schema).includes('"oneOf"'));
      assert.equal(body.max_completion_tokens, 1024);
      assert.equal(body.reasoning_effort, 'low');
      assert.equal(body.provider, undefined);
      assert.equal(body.max_tokens, undefined);
      const grounded = JSON.parse(body.messages[1].content).payload;
      assert.equal(grounded.executedActions[0].urlAfter, `${origins[0]}/projects`);
      assert.equal(grounded.executedActions[0].action.controlId, 'old-submit');
      assert.equal(grounded.plan, undefined);
      assert.ok(!JSON.stringify(body).includes('synthetic-key'));
      return Response.json({
        model: 'openai/gpt-oss-20b',
        usage: { prompt_tokens: 25, completion_tokens: 10 },
        choices: [
          { message: { content: '{"action":{"type":"capture","description":"Capture"}}' } },
        ],
      });
    };
    const cfg = loadConfig({
      MODEL_MODE: 'live',
      MODEL_PROVIDER: 'groq',
      MODEL_BASE_URL: 'https://api.groq.com/openai/v1',
      MODEL_ID: 'openai/gpt-oss-20b',
      MODEL_FORMAT: 'auto',
      MODEL_API_KEY: 'synthetic-key',
    });
    const reply = await new LiveAdapter(cfg).request(
      'decision',
      decisionInput,
      actionSchema,
      null,
      new AbortController().signal,
    );
    assert.equal(calls, 2);
    assert.equal(reply.provider, 'groq');
    assert.equal(reply.inputTokens, 25);
    assert.equal(groqFormat('other-active-model'), 'json_object');
  } finally {
    globalThis.fetch = original;
  }
});
test('non-strict output modes retain the full schema instructions', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.ok(body.messages[0].content.includes('JSON Schema:'));
      assert.ok(body.messages[0].content.includes('"oneOf"'));
      return Response.json({
        choices: [
          { message: { content: '{"action":{"type":"capture","description":"Capture"}}' } },
        ],
      });
    };
    for (const format of ['json_object', 'none'] as const) {
      const reply = await new LiveAdapter(
        loadConfig({ MODEL_MODE: 'live', MODEL_PROVIDER: 'local', MODEL_FORMAT: format }),
      ).request('decision', decisionInput, actionSchema, null, new AbortController().signal);
      assert.equal(actionSchema.parse(reply.value).type, 'capture');
    }
  } finally {
    globalThis.fetch = original;
  }
});
test('Groq rejects absent/inactive catalog models and missing credentials', async () => {
  const original = globalThis.fetch;
  const cfg = loadConfig({
    MODEL_PROVIDER: 'groq',
    MODEL_ID: 'openai/gpt-oss-20b',
    MODEL_API_KEY: 'synthetic-key',
  });
  try {
    globalThis.fetch = async () =>
      Response.json({ data: [{ id: 'openai/gpt-oss-20b', active: false }] });
    await assert.rejects(discoverModel(cfg, new AbortController().signal), /not active/);
    await assert.rejects(
      discoverModel({ ...cfg, MODEL_API_KEY: '' }, new AbortController().signal),
      /requires MODEL_API_KEY/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test('rate limits retry within the model-call budget; auth errors stop after one request', async () => {
  const s = store();
  try {
    s.create(input);
    const claim = s.claim('model-negative-tests')!;
    let calls = 0;
    const session = new ModelSession(s.config, s, claim.attempt.id, new AbortController().signal, {
      async request() {
        calls++;
        if (calls === 1) throw new ProviderError(429, 1);
        return { value: fixturePlan, model: 'synthetic-model', provider: 'groq' };
      },
    });
    await session.plan(input);
    assert.equal(calls, 2);
    const denied = new ModelSession(s.config, s, claim.attempt.id, new AbortController().signal, {
      async request() {
        throw new ProviderError(401);
      },
    });
    await assert.rejects(denied.plan(input), /HTTP 401/);
    assert.equal(denied.calls, 1);
    const tooLong = new ModelSession(s.config, s, claim.attempt.id, new AbortController().signal, {
      async request() {
        throw new ProviderError(429, 61000);
      },
    });
    await assert.rejects(tooLong.plan(input), /HTTP 429/);
    assert.equal(tooLong.calls, 1);
    assert.equal(retryDelay('2'), 2000);
    assert.equal(s.detail(claim.run.id)!.modelCalls.length, 4);
  } finally {
    s.close();
  }
});
