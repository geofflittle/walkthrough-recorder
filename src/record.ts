import { appendFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';

import type { TimelineEvent } from './timeline';

/**
 * What the machine was doing while the take was recorded.
 *
 * Kept because a take's timings are only readable next to this. One run's slow
 * call took 11.1s and another 39.1s against byte-identical replayed traffic,
 * and neither number meant anything on its own: the second ran with a load
 * average of 12 and two other builds competing for the cores. Without this the
 * only way to tell a slow app from a busy laptop was to remember what else had
 * been running, which does not survive to the next day.
 */
export type HostFacts = {
  /** One, five and fifteen minute load averages. */
  load: [number, number, number];
  cpus: number;
};

export const realHost = (): HostFacts => {
  const [one, five, fifteen] = loadavg();
  return { load: [one, five, fifteen], cpus: cpus().length };
};

/** One take, as a row in the history. */
export type TakeRecord = {
  runAtEpochMs: number;
  host: HostFacts;
  video: { width: number; height: number; durationSeconds: number };
  terminalState: string;
  failedChecks: string[];
  /**
   * Every span the run measured, keyed `kind target`, in milliseconds.
   *
   * Only entries that took time, because an instant is not a duration and a map
   * full of zeroes buries the handful of numbers worth comparing. Repeats are
   * summed: a control waited on twice is one line of the story, and keeping
   * only the last would silently drop the first.
   */
  spans: Record<string, number>;
  /** Total length of the transcript, which is where the video's length comes from. */
  lastEventMs: number;
};

export const spansOf = (events: TimelineEvent[]): Record<string, number> => {
  const spans: Record<string, number> = {};
  for (const event of events) {
    if (event.durationMs === undefined) continue;
    const key = `${event.kind} ${event.target}`;
    spans[key] = (spans[key] ?? 0) + event.durationMs;
  }
  return spans;
};

export const takeRecord = ({
  events,
  video,
  terminalState,
  failedChecks,
  host,
  runAtEpochMs,
}: {
  events: TimelineEvent[];
  video: { width: number; height: number; durationSeconds: number };
  terminalState: string;
  failedChecks: string[];
  host: HostFacts;
  runAtEpochMs: number;
}): TakeRecord => ({
  runAtEpochMs,
  host,
  video,
  terminalState,
  failedChecks,
  spans: spansOf(events),
  lastEventMs: events.at(-1)?.at ?? 0,
});

/**
 * Appends a take to the history beside its video.
 *
 * One line per take, never overwritten, because the question worth asking is
 * always about two takes rather than one. The transcript next to the video is
 * the CURRENT take and is clobbered by the next, so a run's timings used to
 * survive only in a terminal scrollback, and comparing "the review scan today
 * against the review scan an hour ago" was impossible ten minutes later.
 */
export const appendTake = (
  historyPath: string,
  record: TakeRecord,
  append: (path: string, line: string) => void = (path, line) => {
    appendFileSync(path, line);
  },
): void => {
  append(historyPath, `${JSON.stringify(record)}\n`);
};
