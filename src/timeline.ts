/**
 * A timestamped log of what the walkthrough did, in video time.
 *
 * Every entry's `at` is milliseconds since RECORDING started, not since the
 * process started, so an entry doubles as a seek position in the finished
 * video. That is what turns "it lingers too long on the code" from a
 * judgement into a number you can look up and change.
 */
export type TimelineEvent = {
  /** Milliseconds since recording began. */
  at: number;
  kind: 'click' | 'enter' | 'note' | 'ready' | 'scroll' | 'type' | 'wait';
  /** The testID acted on, or the screen entered. */
  target: string;
  /** How long this took, for entries that span time. */
  durationMs?: number;
  detail?: string;
};

export type Timeline = {
  /** Call when recording starts, so every later `at` is video time. */
  start: () => void;
  record: (event: Omit<TimelineEvent, 'at'>) => void;
  /** Wraps a span, recording its real duration rather than an intention. */
  span: <T>(
    event: Omit<TimelineEvent, 'at' | 'durationMs'>,
    work: () => Promise<T>,
  ) => Promise<T>;
  events: () => TimelineEvent[];
  /** Epoch ms the clock was zeroed at, for aligning against another recording. */
  originEpochMs: () => number;
  /**
   * Human-readable, one line per event, for reading next to the video.
   *
   * `toVideoMs` carries an entry from this clock into the finished video's.
   * A function rather than a constant offset, because the render compresses
   * dead stretches, and a video that plays at more than one speed cannot be
   * described by a single shift. Defaults to the identity.
   */
  format: (toVideoMs?: (atMs: number) => number) => string;
};

const asClock = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(
    seconds % 60,
  ).padStart(2, '0')}.${String(Math.floor((ms % 1000) / 100))}`;
};

export const makeTimeline = (now: () => number = Date.now): Timeline => {
  // Until start() is called, entries are relative to construction. Recording
  // begins partway through the run, and an entry before that has no video
  // position, so it is clamped rather than reported as negative.
  let origin = now();
  const events: TimelineEvent[] = [];
  const at = () => Math.max(0, now() - origin);

  const record: Timeline['record'] = event => {
    events.push({ at: at(), ...event });
  };

  return {
    start: () => {
      origin = now();
    },
    record,
    span: async (event, work) => {
      const startedAt = now();
      const result = await work();
      events.push({
        at: Math.max(0, startedAt - origin),
        ...event,
        durationMs: now() - startedAt,
      });
      return result;
    },
    events: () => [...events],
    originEpochMs: () => origin,
    format: (toVideoMs = at => at) =>
      events
        .map(event => {
          const took =
            event.durationMs === undefined
              ? ''
              : ` (${(event.durationMs / 1000).toFixed(1)}s)`;
          const detail = event.detail ? ` ${event.detail}` : '';
          return `${asClock(
            Math.max(0, toVideoMs(event.at)),
          )}  ${event.kind.padEnd(5)} ${event.target}${took}${detail}`;
        })
        .join('\n'),
  };
};
