import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Store } from '../src/db/store';
import { loadConfig } from '../src/core/config';
import { fixturePlan } from '../src/ai/fixture';

const label = process.argv[2];
if (!['before', 'after'].includes(label)) throw new Error('Specify before or after.');
const directory = path.resolve('data/performance', randomUUID());
const store = new Store(
  loadConfig({ MODEL_MODE: 'fixture', DATABASE_PATH: path.join(directory, 'benchmark.sqlite') }),
);
const runCount = 5000,
  callsPerRun = 20;
try {
  const run = store.sqlite.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const attempt = store.sqlite.prepare('INSERT INTO attempts VALUES (?,?,?,?,?,?,?,?,?,?)');
  const call = store.sqlite.prepare('INSERT INTO model_calls VALUES (?,?,?,?,?,?,?,?,?,?)');
  store.sqlite.transaction(() => {
    for (let i = 0; i < runCount; i++) {
      run.run(
        `run-${i}`,
        'http://127.0.0.1:4100',
        'Synthetic benchmark only',
        'No feature claim',
        'passed',
        i,
        i,
        'fixture',
        'synthetic',
        'fixture',
        0,
        1,
      );
      attempt.run(
        `attempt-${i}`,
        `run-${i}`,
        1,
        'passed',
        'synthetic',
        0,
        i,
        i + 1,
        null,
        JSON.stringify(fixturePlan),
      );
      for (let j = 0; j < callsPerRun; j++)
        call.run(
          `call-${i}-${j}`,
          `attempt-${i}`,
          'decision',
          'fixture',
          'synthetic',
          0,
          null,
          null,
          1,
          null,
        );
    }
  })();
  const measure = (fn: () => unknown) => {
    fn();
    const samples = Array.from({ length: 9 }, () => {
      const start = performance.now();
      fn();
      return performance.now() - start;
    }).sort((a, b) => a - b);
    return { medianMs: Number(samples[4].toFixed(3)), maxMs: Number(samples.at(-1)!.toFixed(3)) };
  };
  const result = {
    measuredAt: new Date().toISOString(),
    label,
    synthetic: true,
    runCount,
    modelCallRows: runCount * callsPerRun,
    samplesPerOperation: 9,
    idleClaim: measure(() => store.claim('benchmark')),
    runDetail: measure(() => store.detail('run-2500')),
    directory,
  };
  await mkdir('data/performance', { recursive: true });
  if (label === 'before')
    await writeFile('data/performance/baseline.json', JSON.stringify(result, null, 2));
  else {
    const before = JSON.parse(await readFile('data/performance/baseline.json', 'utf8'));
    await writeFile(
      'docs/performance-verification.json',
      JSON.stringify(
        {
          note: 'Synthetic isolated history benchmark; nine warm samples per operation, same machine. Not a production load or concurrency guarantee.',
          before,
          after: result,
        },
        null,
        2,
      ) + '\n',
    );
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  store.close();
}
