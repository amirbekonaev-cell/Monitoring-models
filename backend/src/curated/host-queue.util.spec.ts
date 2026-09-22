import { HostQueue, runWithConcurrency } from './host-queue.util';

/** Records what the queue would have slept for without actually waiting. */
function recordingSleep(log: number[]): (ms: number) => Promise<void> {
  return (ms: number) => {
    log.push(ms);
    return Promise.resolve();
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('HostQueue', () => {
  it('runs two tasks for the same host strictly one at a time', async () => {
    const queue = new HostQueue(0);
    const first = deferred<string>();
    const order: string[] = [];

    const a = queue.run('example.com', async () => {
      order.push('a:start');
      const value = await first.promise;
      order.push('a:end');
      return value;
    });
    const b = queue.run('example.com', async () => {
      order.push('b:start');
      return 'b';
    });

    // Flush the microtask queue (the queue chains through .catch().then(), so a single
    // Promise.resolve() tick is not enough for the first task to reach its body), then assert
    // that b has still not started while a is in flight.
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['a:start']);

    first.resolve('a');
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('runs tasks for different hosts in parallel', async () => {
    const queue = new HostQueue(0);
    const blocker = deferred<string>();
    const order: string[] = [];

    const slow = queue.run('slow.example', async () => {
      order.push('slow:start');
      return blocker.promise;
    });
    const fast = queue.run('fast.example', async () => {
      order.push('fast:start');
      return 'fast';
    });

    expect(await fast).toBe('fast');
    expect(order).toEqual(['slow:start', 'fast:start']);

    blocker.resolve('slow');
    await slow;
  });

  it('waits the configured delay between consecutive requests to one host, but not before the first', async () => {
    const sleeps: number[] = [];
    const queue = new HostQueue(300, recordingSleep(sleeps));

    await queue.run('example.com', async () => 1);
    expect(sleeps).toEqual([]);

    await queue.run('example.com', async () => 2);
    await queue.run('example.com', async () => 3);
    expect(sleeps).toEqual([300, 300]);
  });

  it('does not sleep between different hosts', async () => {
    const sleeps: number[] = [];
    const queue = new HostQueue(300, recordingSleep(sleeps));

    await queue.run('a.example', async () => 1);
    await queue.run('b.example', async () => 2);

    expect(sleeps).toEqual([]);
  });

  it('keeps serving a host after one of its tasks rejects', async () => {
    const queue = new HostQueue(0);

    await expect(queue.run('example.com', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(queue.run('example.com', async () => 'ok')).resolves.toBe('ok');
  });

  it('counts distinct hosts', async () => {
    const queue = new HostQueue(0);
    await queue.run('a.example', async () => 1);
    await queue.run('b.example', async () => 2);
    await queue.run('a.example', async () => 3);
    expect(queue.hostCount).toBe(2);
  });
});

describe('runWithConcurrency', () => {
  it('never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;

    await runWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    });

    expect(peak).toBeLessThanOrEqual(4);
  });

  it('processes every item and returns results in input order', async () => {
    const results = await runWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([10, 20, 30, 40]);
  });

  it('one rejected item does not stop the others — the whole batch still runs', async () => {
    const seen: number[] = [];

    const results = await runWithConcurrency([1, 2, 3], 2, async (n) => {
      seen.push(n);
      if (n === 2) {
        throw new Error('только эта упала');
      }
      return n;
    });

    expect(seen.sort()).toEqual([1, 2, 3]);
    expect(results[1].status).toBe('rejected');
    expect(results[0].status).toBe('fulfilled');
    expect(results[2].status).toBe('fulfilled');
  });

  it('handles an empty list', async () => {
    await expect(runWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
  });
});
