/**
 * Serializes work per host and keeps a polite gap between consecutive requests to the same one.
 *
 * Needed because the pool is very unevenly distributed: sknews.kz alone holds 49 of the ~169
 * links, and bluescreen.kz another 20. With a plain N-way worker pool, `CURATED_CONCURRENCY=4`
 * would mean four simultaneous requests to sknews.kz for most of the run — which reads as a
 * small scrape attack from the site's side and is exactly how a run earns itself a 403 wall
 * halfway through.
 *
 * So: unlimited parallelism ACROSS hosts (bounded separately by the caller's concurrency limit),
 * strictly one request at a time WITHIN a host, with `delayMs` between the end of one and the
 * start of the next.
 *
 * Plain promise chaining rather than a queue data structure — `run()` appends to the host's
 * current tail promise, which is all "one at a time, in call order" requires.
 */
export class HostQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly delayMs: number,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  /**
   * Runs `task` once every task previously queued for `host` has finished, after the polite
   * delay. A rejected task does not poison the host's queue — the chain continues with the next
   * task (the rejection still propagates to that task's own caller).
   */
  run<T>(host: string, task: () => Promise<T>): Promise<T> {
    // Captured BEFORE the tail is replaced below: by the time the .then() callback runs, this
    // host is always present in the map, so the check has to happen here.
    const isFirstForHost = !this.tails.has(host);
    const previous = this.tails.get(host) ?? Promise.resolve();

    const result = previous
      .catch(() => undefined)
      .then(async () => {
        // No delay before the very first request to a host — the gap only matters between
        // consecutive ones.
        if (!isFirstForHost && this.delayMs > 0) {
          await this.sleep(this.delayMs);
        }
        return task();
      });

    this.tails.set(
      host,
      result.catch(() => undefined),
    );
    return result;
  }

  /** How many distinct hosts have been seen — a counter for run summaries, not control flow. */
  get hostCount(): number {
    return this.tails.size;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `items` through `worker` with at most `limit` in flight at once. Kept here beside
 * HostQueue because the two are always used together: this bounds total parallelism, HostQueue
 * bounds per-host parallelism underneath it.
 *
 * A rejected worker never stops the pass — one bad link must not abort the other 168. Every
 * result comes back in input order as a settled outcome for the caller to tally.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<{ status: 'fulfilled'; value: R } | { status: 'rejected'; reason: unknown }>> {
  const results = new Array<{ status: 'fulfilled'; value: R } | { status: 'rejected'; reason: unknown }>(items.length);
  const effectiveLimit = Math.max(1, Math.min(limit, items.length || 1));
  let cursor = 0;

  const runner = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) {
        return;
      }
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: effectiveLimit }, runner));
  return results;
}
