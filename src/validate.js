// Gate for AI-generated regex triggers: only patterns that pass here may reach routes.json.
import { Worker } from 'node:worker_threads';

const MAX_LEN = 300;
const BUDGET_MS = 200; // per input, measured inside the worker
const KILL_GRACE_MS = 300; // extra wait for a worker that stopped answering
const START_MS = 2000; // worker start-up allowance

// rep: * + {n,} {n,m} with m>n (inside a group this makes it risky). multi: also any fixed {n} with n>=2
// (a group repeated like that is risky when its body has a rep). ? never counts.
function readQuantifier(src, i) {
  const c = src[i];
  if (c === '*' || c === '+') return { len: 1, rep: true, multi: true };
  if (c === '?') return { len: 1, rep: false, multi: false };
  if (c !== '{') return null;
  const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i, i + 24));
  if (!m) return null; // a literal "{" without the u flag
  const rep = m[2] !== undefined && (m[3] === '' || +m[3] > Math.max(+m[1], 1));
  return { len: m[0].length, rep, multi: rep || +(m[3] || m[1]) > 1 };
}

const wild = (t) => t === null || t === '.';
const cls = (t) => t[0] === '[' || t[0] === '(' || /^\\[wWdDsS]$/.test(t);
// shortcut: branches overlap if they start with the same atom or are both classes; the timing test is the backstop.
function overlapping(firsts) {
  for (let a = 0; a < firsts.length; a++) {
    for (let b = a + 1; b < firsts.length; b++) {
      const x = firsts[a], y = firsts[b];
      if (wild(x) || wild(y) || x.toLowerCase() === y.toLowerCase() || (cls(x) && cls(y))) return true;
    }
  }
  return false;
}

// Static scan: a repeated group whose body has a repeating quantifier, or an alternation with overlapping branches.
export function hasNestedQuantifier(src) {
  const stack = [{ q: false, firsts: [null] }];
  const top = () => stack[stack.length - 1];
  let i = 0;
  const atom = (tok) => {
    const f = top().firsts;
    if (f[f.length - 1] === null) f[f.length - 1] = tok;
  };
  const quant = () => {
    const q = readQuantifier(src, i);
    if (!q) return null;
    i += q.len;
    if (src[i] === '?') i++; // lazy suffix
    return q;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' || c === '[') {
      let end = i + 2;
      if (c === '[') {
        end = i + 1;
        while (end < src.length && src[end] !== ']') end += src[end] === '\\' ? 2 : 1;
        end++;
      }
      atom(src.slice(i, end));
      i = end;
      if (quant()?.rep) top().q = true;
    } else if (c === '(') {
      i++;
      if (src[i] === '?') {
        const m = /^\?(:|=|!|<=|<!|<[^>]*>)/.exec(src.slice(i, i + 64));
        i += m ? m[0].length : 1;
      }
      stack.push({ q: false, firsts: [null] });
    } else if (c === ')') {
      i++;
      if (stack.length === 1) continue;
      const g = stack.pop();
      const q = quant();
      if (q?.multi && (g.q || overlapping(g.firsts))) return true;
      top().q ||= g.q || q?.rep === true;
      atom('(');
    } else if (c === '|') {
      top().firsts.push(null);
      i++;
    } else if (c === '^' || c === '$') {
      i++;
    } else {
      atom(c);
      i++;
      if (quant()?.rep) top().q = true;
    }
  }
  return false;
}

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
