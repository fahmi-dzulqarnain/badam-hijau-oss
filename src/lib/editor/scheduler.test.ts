import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSaveScheduler } from "@/lib/editor/scheduler";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A save whose resolution the test controls, so "in flight" is a state a test can sit in. */
function deferredSave() {
  const calls: Array<() => void> = [];
  let count = 0;
  const save = () => {
    count += 1;
    return new Promise<void>((resolve) => calls.push(resolve));
  };
  return {
    save,
    get count() {
      return count;
    },
    resolveLast() {
      calls.pop()?.();
      // Let the scheduler's `finally` run before the test looks at anything.
      return vi.advanceTimersByTimeAsync(0);
    },
  };
}

test("nothing is saved before the delay elapses", async () => {
  const save = vi.fn(async () => {});
  const scheduler = createSaveScheduler({ delayMs: 2000, save });

  scheduler.edited();
  await vi.advanceTimersByTimeAsync(1999);
  expect(save).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  expect(save).toHaveBeenCalledTimes(1);
});

test("a burst of edits inside one window is one save, not one per keystroke", async () => {
  const save = vi.fn(async () => {});
  const scheduler = createSaveScheduler({ delayMs: 2000, save });

  for (let i = 0; i < 40; i += 1) {
    scheduler.edited();
    await vi.advanceTimersByTimeAsync(25);
  }
  await vi.advanceTimersByTimeAsync(2000);
  expect(save).toHaveBeenCalledTimes(1);
});

test("continuous typing still saves every delay — the clock is not re-armed by each keystroke", async () => {
  // The mutation this kills: turning `arm` into a clear-and-restart, i.e. a textbook
  // debounce. Someone typing steadily for two minutes would then never save once, and
  // nothing on screen would say so until they closed the tab.
  const save = vi.fn(async () => {});
  const scheduler = createSaveScheduler({ delayMs: 2000, save });

  for (let i = 0; i < 300; i += 1) {
    scheduler.edited();
    await vi.advanceTimersByTimeAsync(40); // 12 seconds of steady typing
  }
  expect(save.mock.calls.length).toBeGreaterThanOrEqual(5);
});

test("an idle editor is never saved", async () => {
  const save = vi.fn(async () => {});
  createSaveScheduler({ delayMs: 2000, save });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(save).not.toHaveBeenCalled();
});

test("flush saves immediately, and cancels the pending timer rather than saving twice", async () => {
  const save = vi.fn(async () => {});
  const scheduler = createSaveScheduler({ delayMs: 2000, save });

  scheduler.edited();
  scheduler.flush();
  await vi.advanceTimersByTimeAsync(0);
  expect(save).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(5000);
  expect(save).toHaveBeenCalledTimes(1);
});

test("flush on a clean document saves nothing", async () => {
  const save = vi.fn(async () => {});
  const scheduler = createSaveScheduler({ delayMs: 2000, save });

  scheduler.flush();
  await vi.advanceTimersByTimeAsync(5000);
  expect(save).not.toHaveBeenCalled();
});

test("two saves are never in flight at once", async () => {
  // Overlapping PUTs race on `seen`: the second carries a timestamp the first is about to
  // invalidate, so the editor 409s against its own work and names the user as their own
  // conflicting editor.
  const deferred = deferredSave();
  const scheduler = createSaveScheduler({ delayMs: 2000, save: deferred.save });

  scheduler.edited();
  await vi.advanceTimersByTimeAsync(2000);
  expect(deferred.count).toBe(1);

  scheduler.edited();
  await vi.advanceTimersByTimeAsync(10_000);
  scheduler.flush();
  await vi.advanceTimersByTimeAsync(0);
  expect(deferred.count).toBe(1);
});

test("an edit made during a save is saved once that save finishes", async () => {
  const deferred = deferredSave();
  const scheduler = createSaveScheduler({ delayMs: 2000, save: deferred.save });

  scheduler.edited();
  await vi.advanceTimersByTimeAsync(2000);
  expect(deferred.count).toBe(1);

  scheduler.edited();
  expect(scheduler.isDirty()).toBe(true);

  await deferred.resolveLast();
  expect(deferred.count).toBe(1); // re-armed, not fired instantly
  await vi.advanceTimersByTimeAsync(2000);
  expect(deferred.count).toBe(2);
});

test("a flush during a save runs the moment that save finishes", async () => {
  const deferred = deferredSave();
  const scheduler = createSaveScheduler({ delayMs: 2000, save: deferred.save });

  scheduler.edited();
  await vi.advanceTimersByTimeAsync(2000);
  scheduler.edited();
  scheduler.flush();
  expect(deferred.count).toBe(1);

  await deferred.resolveLast();
  expect(deferred.count).toBe(2);
});

test("isDirty reports edits made during a save, and nothing once it is quiet", async () => {
  // This is what tells the caller whether "Saved 14:22" is true when its own save resolves.
  const deferred = deferredSave();
  const scheduler = createSaveScheduler({ delayMs: 2000, save: deferred.save });

  expect(scheduler.isDirty()).toBe(false);
  scheduler.edited();
  expect(scheduler.isDirty()).toBe(true);

  await vi.advanceTimersByTimeAsync(2000);
  expect(scheduler.isDirty()).toBe(false); // cleared as the save started

  scheduler.edited();
  expect(scheduler.isDirty()).toBe(true);
  await deferred.resolveLast();
  expect(scheduler.isDirty()).toBe(true);
});

test("a rejected save does not wedge the scheduler", async () => {
  // Without the catch, `inFlight` stays true forever and the editor stops autosaving for the
  // rest of the session — silently, which is the whole failure this feature exists to avoid.
  let attempts = 0;
  const save = vi.fn(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("network down");
  });
  const scheduler = createSaveScheduler({ delayMs: 2000, save });

  scheduler.edited();
  await vi.advanceTimersByTimeAsync(2000);
  expect(save).toHaveBeenCalledTimes(1);

  scheduler.edited();
  await vi.advanceTimersByTimeAsync(2000);
  expect(save).toHaveBeenCalledTimes(2);
});

test("stop cancels the pending save and refuses every later one", async () => {
  const save = vi.fn(async () => {});
  const scheduler = createSaveScheduler({ delayMs: 2000, save });

  scheduler.edited();
  scheduler.stop();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(save).not.toHaveBeenCalled();

  scheduler.edited();
  scheduler.flush();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(save).not.toHaveBeenCalled();
});

test("stop during a save does not let the queued edit fire afterwards", async () => {
  // React 19 in strict mode mounts, unmounts and remounts; a scheduler that kept writing
  // after teardown would have the old page's text saved by the new page's editor.
  const deferred = deferredSave();
  const scheduler = createSaveScheduler({ delayMs: 2000, save: deferred.save });

  scheduler.edited();
  await vi.advanceTimersByTimeAsync(2000);
  scheduler.edited();
  scheduler.stop();

  await deferred.resolveLast();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(deferred.count).toBe(1);
});
