import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "../../src/lib/concurrency";

describe("mapWithConcurrency", () => {
  it("processes all items and returns results in input order", async () => {
    const items = [10, 20, 30, 40, 50];
    const results = await mapWithConcurrency(items, 2, async (x) => x * 2);
    expect(results).toHaveLength(5);
    expect(results.map(r => r.ok && r.value)).toEqual([20, 40, 60, 80, 100]);
  });

  it("captures per-item errors without killing the batch", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrency(items, 3, async (x) => {
      if (x === 3) throw new Error("boom");
      return x;
    });
    expect(results[0]).toEqual({ ok: true, value: 1 });
    expect(results[2].ok).toBe(false);
    expect((results[2] as { ok: false; error: Error }).error.message).toBe("boom");
    expect(results[4]).toEqual({ ok: true, value: 5 });
  });

  it("respects concurrency limit", async () => {
    let maxConcurrent = 0;
    let current = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async () => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise(r => setTimeout(r, 10));
      current--;
      return 1;
    });
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it("calls onBatchSettled after each batch", async () => {
    const batches: Array<[number, number]> = [];
    const items = [1, 2, 3, 4, 5];
    await mapWithConcurrency(items, 2, async (x) => x, {
      onBatchSettled: (start, end) => { batches.push([start, end]); },
    });
    // Items: [1,2] batch 0-1, [3,4] batch 2-3, [5] batch 4-4
    expect(batches).toEqual([[0, 1], [2, 3], [4, 4]]);
  });

  it("stops on abort signal", async () => {
    const ac = new AbortController();
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    let processed = 0;
    // Abort after the first batch
    const results = await mapWithConcurrency(items, 2, async (x) => {
      processed++;
      if (processed === 2) ac.abort();
      return x;
    }, { signal: ac.signal });
    // First batch (2 items) ran, rest should be errors
    const okCount = results.filter(r => r.ok).length;
    expect(okCount).toBeLessThanOrEqual(4); // at most first 2 batches
    const abortErrors = results.filter(r => !r.ok && r.error.message === "aborted");
    expect(abortErrors.length).toBeGreaterThan(0);
  });
});
