// Gate for AI-generated regex triggers: only patterns that pass here may reach routes.json.
import { Worker } from 'node:worker_threads';
import { hasNestedQuantifier } from '../hook/route.js';

export { hasNestedQuantifier };

const MAX_LEN = 300;
const BUDGET_MS = 200; // per input, measured inside the worker
const KILL_GRACE_MS = 300; // extra wait for a worker that stopped answering
const START_MS = 2000; // worker start-up allowance

// One worker, patterns tested one at a time. A worker that goes silent is terminated and replaced.
function makeTester() {
  let w = null;
  let nextId = 0;
  const test = (pattern) =>
    new Promise((resolve) => {
      const cur = (w ??= new Worker(new URL('./validate-worker.js', import.meta.url)));
      const id = nextId++;
      let timer;
      const done = (error, kill) => {
        clearTimeout(timer);
        cur.off('message', onMessage);
        cur.off('error', onError);
        if (kill) {
          cur.terminate();
          if (w === cur) w = null;
        }
        resolve(error);
      };
      const arm = (ms) => {
        clearTimeout(timer);
        timer = setTimeout(() => done('too slow', true), ms);
      };
      const onMessage = (m) => {
        if (m.id !== id) return;
        if (m.begin) arm(BUDGET_MS + KILL_GRACE_MS);
        else done(m.ok ? null : m.error);
      };
      const onError = () => done('could not be tested', true);
      cur.on('message', onMessage);
      cur.on('error', onError);
      arm(START_MS);
      cur.postMessage({ id, pattern, budget: BUDGET_MS });
    });
  return { test, close: () => w?.terminate() };
}

async function check(src, tester) {
  if (typeof src !== 'string') return 'not a string';
  if (src === '') return 'empty';
  if (src.length > MAX_LEN) return 'too long';
  if (hasNestedQuantifier(src)) return 'nested quantifier';
  return tester.test(src);
}

export async function validatePattern(src) {
  const tester = makeTester();
  try {
    const error = await check(src, tester);
    return error ? { ok: false, error } : { ok: true };
  } finally {
    await tester.close();
  }
}

export async function validateRules(rules) {
  const tester = makeTester();
  const seen = new Map(); // pattern -> error | null, so a repeated pattern is tested once
  const kept = [];
  const rejected = [];
  try {
    for (const rule of rules) {
      let bad = null;
      for (const pattern of rule) {
        if (!seen.has(pattern)) seen.set(pattern, await check(pattern, tester));
        const error = seen.get(pattern);
        if (error) {
          bad = { pattern, error };
          break;
        }
      }
      if (bad) rejected.push(bad);
      else kept.push(rule);
    }
  } finally {
    await tester.close();
  }
  return { rules: kept, rejected };
}
