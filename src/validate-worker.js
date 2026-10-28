// Runs untrusted patterns off the main thread. The main thread terminates this
// worker if a pattern never returns; a pattern that returns late is reported here.
import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

const INPUTS = [
  'a'.repeat(100000) + '!',
  'a '.repeat(50000) + '!',
  'draft '.repeat(16000) + '!',
];

parentPort.on('message', ({ id, pattern, budget }) => {
  let re;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    return parentPort.postMessage({ id, error: 'does not compile' });
  }
  for (const input of INPUTS) {
    parentPort.postMessage({ id, begin: true }); // lets the main thread time this run
    const t = performance.now();
    re.test(input);
    if (performance.now() - t > budget) return parentPort.postMessage({ id, error: 'too slow' });
  }
  parentPort.postMessage({ id, ok: true });
});
