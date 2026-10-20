/**
 * Scheduling adapter over toad-scheduler.
 *
 * The library owns interval/timer mechanics (fire cadence, overlap
 * suppression); this adapter adds the contract runDaemon relies on:
 * - `onError(task, error)` for every failed tick, sync throw or rejection —
 *   a failing tick never stops the schedule (the core error-isolation rule);
 * - `stop()` halts future triggers AND awaits in-flight ticks (toad's stop()
 *   does not drain);
 * - `runOnce()` runs every task once, sequentially, collecting per-task
 *   errors — powers `daemon --once`.
 *
 * Overlap semantics: jobs run with `preventOverrun` — a tick due while the
 * previous one is still executing is dropped (not queued); sampling just
 * waits for the next interval. `runImmediately` gives data right after boot.
 */
import { AsyncTask, SimpleIntervalJob, ToadScheduler, type SimpleIntervalJob as Job } from 'toad-scheduler';

export interface ScheduledTask {
  name: string;
  everyMs: number;
  run: () => void | Promise<void>;
}

export type TaskErrorHandler = (task: ScheduledTask, error: unknown) => void;

export interface SchedulerHandle {
  /** Register and start every task (immediate first tick, then cadence). */
  start(): void;
  /** Stop future triggers, then await whatever is still running. */
  stop(): Promise<void>;
  /** Run every task once, sequentially. name → error, or null on success. */
  runOnce(): Promise<Record<string, unknown>>;
}

export function createScheduler(
  tasks: readonly ScheduledTask[],
  onError: TaskErrorHandler
): SchedulerHandle {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!Number.isFinite(task.everyMs) || task.everyMs <= 0) {
      throw new Error(`ScheduledTask ${task.name}: everyMs must be > 0 (got ${task.everyMs})`);
    }
    if (seen.has(task.name)) {
      throw new Error(`ScheduledTask names must be unique (duplicate: ${task.name})`);
    }
    seen.add(task.name);
  }

  const scheduler = new ToadScheduler();
  const inFlight = new Set<Promise<void>>();

  const jobs: Job[] = tasks.map((task) => {
    // Wrap so sync throws become rejections (toad's AsyncTask then routes
    // them to the error callback) and every tick is tracked for drain-on-stop.
    const handler = (): Promise<void> => {
      const tick = Promise.resolve().then(() => task.run());
      const settled = tick.then(
        () => undefined,
        () => undefined
      );
      const tracked = settled.then(() => {
        inFlight.delete(tracked);
      });
      inFlight.add(tracked);
      return tick;
    };
    const asyncTask = new AsyncTask(
      task.name,
      handler,
      (error: Error) => onError(task, error)
    );
    return new SimpleIntervalJob(
      { milliseconds: task.everyMs, runImmediately: true },
      asyncTask,
      { id: task.name, preventOverrun: true }
    );
  });

  let added = false;
  return {
    start(): void {
      if (!added) {
        for (const job of jobs) scheduler.addSimpleIntervalJob(job);
        added = true;
      } else {
        for (const job of jobs) job.start();
      }
    },
    async stop(): Promise<void> {
      scheduler.stop();
      await Promise.allSettled([...inFlight]);
    },
    async runOnce(): Promise<Record<string, unknown>> {
      const results: Record<string, unknown> = {};
      for (const task of tasks) {
        try {
          await task.run();
          results[task.name] = null;
        } catch (error) {
          results[task.name] = error;
        }
      }
      return results;
    },
  };
}
