/**
 * What the encoder has actually recorded, as opposed to how long we waited.
 *
 * The harness sleeps in wall-clock time, but the screencast captures frames on
 * its own schedule and falls behind on a loaded machine. Measured on an idle
 * laptop: 10 frames spanning 2216ms across 3060ms of wall time, so 844ms of
 * waiting produced no footage at all.
 *
 * That gap is a whole class of defect. A closing hold that occupies 800ms of
 * wall clock can leave 300ms in the file, and every check comparing transcript
 * milliseconds against video milliseconds is assuming two clocks agree when
 * they do not. Holding until the FOOTAGE arrives makes them one clock.
 *
 * No timers here on purpose. Frames resolve the waiters, so this is pure and
 * synchronous, and a caller that needs a ceiling races its own.
 */
export type Footage = {
  /** Note a frame, timestamped by the encoder in epoch milliseconds. */
  sawFrame: (timestampMs: number) => void;
  /** The most recent frame's timestamp, or undefined before any arrived. */
  recordedUntilMs: () => number | undefined;
  /** Resolves once `ms` of footage exists past `fromMs`. */
  awaitFootage: (fromMs: number, ms: number) => Promise<void>;
  /** How many waiters are still unresolved, for a caller reporting a stall. */
  waiting: () => number;
};

export const makeFootage = (): Footage => {
  let latest: number | undefined;
  const waiters: { untilMs: number; resolve: () => void }[] = [];

  const release = () => {
    if (latest === undefined) return;
    // Backwards, so splicing does not skip the next waiter.
    for (let index = waiters.length - 1; index >= 0; index -= 1)
      if (latest >= waiters[index].untilMs)
        waiters.splice(index, 1)[0].resolve();
  };

  return {
    sawFrame: timestampMs => {
      // Monotonic by construction. Frames can arrive out of order under load,
      // and letting the clock go backwards would un-resolve nothing but would
      // make a later wait hang for the difference.
      if (latest === undefined || timestampMs > latest) latest = timestampMs;
      release();
    },
    recordedUntilMs: () => latest,
    awaitFootage: async (fromMs, ms) =>
      new Promise<void>(resolve => {
        const untilMs = fromMs + ms;
        if (latest !== undefined && latest >= untilMs) {
          resolve();
          return;
        }
        waiters.push({ untilMs, resolve });
      }),
    waiting: () => waiters.length,
  };
};
