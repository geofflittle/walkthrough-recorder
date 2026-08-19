import { describe, expect, it } from 'vitest';

import { makeTimeline } from './timeline';

/** A clock the test drives, so nothing here depends on real time passing. */
const fakeClock = (startAt = 1000) => {
  let current = startAt;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
};

describe('makeTimeline', () => {
  it('measures from construction until recording starts', () => {
    // The run does real work before the camera rolls, opening the browser and
    // waiting for the extension. Those entries have no position in a video that
    // does not exist yet.
    const clock = fakeClock();
    const timeline = makeTimeline(clock.now);

    clock.advance(5000);
    timeline.record({ kind: 'note', target: 'before-recording' });
    timeline.start();
    clock.advance(250);
    timeline.record({ kind: 'click', target: 'a-button' });

    expect(timeline.events().map(event => event.at)).toEqual([5000, 250]);
  });

  it('never reports a negative position', () => {
    // An entry made before start() is clamped rather than reported as negative,
    // because a transcript is read as seek positions and a negative one is not
    // somewhere a viewer can go.
    const clock = fakeClock();
    const timeline = makeTimeline(clock.now);

    clock.advance(3000);
    timeline.start();
    // Nothing advances the clock, so this lands exactly on the origin.
    timeline.record({ kind: 'note', target: 'at-the-origin' });

    expect(timeline.events()[0].at).toBe(0);
  });

  it('stamps a span at its START, and records how long it really took', async () => {
    // Both halves matter. Stamping at the end would put a wait's entry at the
    // moment it finished, so reading the transcript against the video would
    // show the wait beginning where it ended. And the duration is measured, not
    // declared, which is how a twenty second timeout was found charged to a
    // step that claimed to be instant.
    const clock = fakeClock();
    const timeline = makeTimeline(clock.now);
    timeline.start();
    clock.advance(2000);

    await timeline.span({ kind: 'ready', target: 'a-button' }, async () => {
      clock.advance(750);
    });

    expect(timeline.events()).toEqual([
      { at: 2000, kind: 'ready', target: 'a-button', durationMs: 750 },
    ]);
  });

  it('returns whatever the span produced', async () => {
    const timeline = makeTimeline(fakeClock().now);

    expect(
      await timeline.span(
        { kind: 'ready', target: 'a-button' },
        async () => 42,
      ),
    ).toBe(42);
  });

  it('hands out a copy of its events, not the list it is appending to', () => {
    const timeline = makeTimeline(fakeClock().now);
    timeline.record({ kind: 'click', target: 'a-button' });

    const taken = timeline.events();
    timeline.record({ kind: 'click', target: 'another-button' });

    expect(taken).toHaveLength(1);
  });

  it('reports the epoch it was zeroed at, for lining up another recording', () => {
    const clock = fakeClock(1_700_000_000_000);
    const timeline = makeTimeline(clock.now);
    clock.advance(4000);
    timeline.start();

    expect(timeline.originEpochMs()).toBe(1_700_000_004_000);
  });
});

describe('format', () => {
  const formatted = (events: Parameters<typeof lines>[0]) => lines(events);
  const lines = (
    records: { kind: 'click' | 'note' | 'wait'; target: string; at: number }[],
  ) => {
    const clock = fakeClock();
    const timeline = makeTimeline(clock.now);
    timeline.start();
    for (const record of records) {
      clock.advance(record.at - (clock.now() - timeline.originEpochMs()));
      timeline.record({ kind: record.kind, target: record.target });
    }
    return timeline.format().split('\n');
  };

  it('writes minutes, seconds and tenths, zero padded', () => {
    // Padded so the column lines up when the transcript is read as a block,
    // which is how a long gap is spotted at all.
    expect(
      formatted([
        { kind: 'click', target: 'a', at: 0 },
        { kind: 'click', target: 'b', at: 9500 },
        { kind: 'click', target: 'c', at: 61_400 },
        { kind: 'click', target: 'd', at: 605_000 },
      ]),
    ).toEqual([
      '00:00.0  click a',
      '00:09.5  click b',
      '01:01.4  click c',
      '10:05.0  click d',
    ]);
  });

  it('truncates to a tenth rather than rounding up past a second', () => {
    // 59.99 seconds is still in the 59th second. Rounding would print 01:00.0
    // and send a reader to a frame after the one being described.
    expect(formatted([{ kind: 'click', target: 'a', at: 59_990 }])).toEqual([
      '00:59.9  click a',
    ]);
  });

  it('shows a duration when the entry spans time', async () => {
    const clock = fakeClock();
    const timeline = makeTimeline(clock.now);
    timeline.start();
    await timeline.span({ kind: 'ready', target: 'a-button' }, async () => {
      clock.advance(1234);
    });

    expect(timeline.format()).toBe('00:00.0  ready a-button (1.2s)');
  });

  it('appends the detail, so a bare kind is not the whole story', () => {
    const timeline = makeTimeline(fakeClock().now);
    timeline.record({
      kind: 'wait',
      target: 'linger',
      durationMs: 6000,
      detail: 'reading what is about to move',
    });

    expect(timeline.format()).toBe(
      '00:00.0  wait  linger (6.0s) reading what is about to move',
    );
  });

  it('carries every entry through a mapping into another clock', () => {
    // The transcript and the video shared a clock only after screencast made
    // that true. The hook stays because a render that compresses dead stretches
    // cannot be described by one offset, and a transcript that does not match
    // the video it sits beside is worse than none.
    const timeline = makeTimeline(fakeClock().now);
    timeline.record({ kind: 'click', target: 'a-button' });

    expect(timeline.format(at => at + 90_000)).toBe('01:30.0  click a-button');
  });

  it('clamps a mapping that sends an entry before the start of the video', () => {
    const timeline = makeTimeline(fakeClock().now);
    timeline.record({ kind: 'click', target: 'a-button' });

    expect(timeline.format(() => -5000)).toBe('00:00.0  click a-button');
  });
});
