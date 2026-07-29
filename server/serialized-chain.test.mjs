import { describe, it, expect } from 'vitest';

// The exact serialization pattern used by tikwmSerializedRequest in server.js:
// the stored tail must never be a rejected promise, otherwise one failure
// poisons every later request until the process restarts (the bug we shipped).
function makeSerializer() {
  let chain = Promise.resolve();
  return function run(task) {
    const p = chain.then(task);
    chain = p.catch(() => {});
    return p;
  };
}

describe('serialized request chain (anti-poisoning pattern)', () => {
  it('recovers after a failure — the next call still runs', async () => {
    const run = makeSerializer();
    await expect(run(async () => { throw new Error('ENOTFOUND'); })).rejects.toThrow('ENOTFOUND');
    // with the OLD pattern this would reject with the SAME stale error
    await expect(run(async () => 'ok')).resolves.toBe('ok');
  });

  it('still serializes: tasks run one at a time, in order', async () => {
    const run = makeSerializer();
    const order = [];
    const t1 = run(async () => { await new Promise((r) => setTimeout(r, 30)); order.push(1); });
    const t2 = run(async () => { order.push(2); });
    await Promise.all([t1, t2]);
    expect(order).toEqual([1, 2]);
  });

  it('propagates each task result to its own caller', async () => {
    const run = makeSerializer();
    const [a, b] = await Promise.all([run(async () => 'a'), run(async () => 'b')]);
    expect(a).toBe('a');
    expect(b).toBe('b');
  });

  it('a failure mid-sequence does not skip or fail the following tasks', async () => {
    const run = makeSerializer();
    const results = await Promise.allSettled([
      run(async () => 'first'),
      run(async () => { throw new Error('boom'); }),
      run(async () => 'third'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(results[2].value).toBe('third');
  });
});
