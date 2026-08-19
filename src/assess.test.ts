import { describe, expect, it } from 'vitest';

import { assessTake, failedChecks } from './assess';

import type { TakeFacts, TakeIntent } from './assess';

const INTENT: TakeIntent = {
  width: 1240,
  height: 1492,
  finishHoldMs: 7000,
  successState: 'done',
  plausibleSeconds: { least: 20, most: 600 },
};

/** A take with nothing wrong with it. */
const GOOD: TakeFacts = {
  width: 1240,
  height: 1492,
  durationSeconds: 95,
  lastEventMs: 87_000,
  terminalState: 'done',
  backdropRows: 0,
};

const assess = (facts: Partial<TakeFacts>) =>
  failedChecks(assessTake({ ...GOOD, ...facts }, INTENT));

describe('assessTake', () => {
  it('passes a take with nothing wrong with it', () => {
    expect(assess({})).toEqual([]);
  });

  it('catches a frame that is not the shape it was asked for', () => {
    // The landscape-preset bug: a portrait take scaled into 1920x1080 and
    // cropped down the sides, which no other check would have noticed.
    expect(assess({ width: 1920, height: 1080 })).toEqual([
      'frame is 1240x1492',
    ]);
  });

  it('catches the backdrop band, but tolerates encoder rounding', () => {
    expect(assess({ backdropRows: 27 })).toEqual([
      'no backdrop band along the bottom',
    ]);
    expect(assess({ backdropRows: 2 })).toEqual([]);
  });

  it('catches a take that ends before the final screen can be read', () => {
    // Shipped: the last click at 01:05.7 in a 66.96s file, so the screen the
    // whole walkthrough builds to got about a second.
    expect(assess({ durationSeconds: 66.96, lastEventMs: 65_700 })).toEqual([
      'holds on the final screen after the last action',
    ]);
  });

  it('absorbs a fixed loss on a SHORT hold, not just a proportional one', () => {
    // What the encoder loses off the tail is roughly absolute. A flat fifth
    // gave a 7000ms hold 1400ms of slack and an 800ms hold only 160ms, so the
    // short one failed on a two-cpu CI runner while the take itself was fine.
    const brisk: TakeIntent = {
      ...INTENT,
      finishHoldMs: 800,
      // Widened too, or the eight-second take below trips the length check
      // instead of the one under test.
      plausibleSeconds: { least: 5, most: 60 },
    };
    const held = (durationSeconds: number, lastEventMs: number) =>
      failedChecks(
        assessTake({ ...GOOD, durationSeconds, lastEventMs }, brisk),
      );

    // 450ms of tail against an 800ms hold: short, and still a real hold.
    expect(held(8, 7550)).toEqual([]);
    // 100ms of tail is not a hold by any reading.
    expect(held(8, 7900)).toContain(
      'holds on the final screen after the last action',
    );
  });

  it('does not loosen a LONG hold, where a fifth is already generous', () => {
    // 7000ms hold, 1400ms allowance, so 5600ms of tail is the bar. The absolute
    // half-second floor must not become the rule for every hold.
    expect(assess({ durationSeconds: 92, lastEventMs: 87_000 })).toContain(
      'holds on the final screen after the last action',
    );
    expect(assess({ durationSeconds: 93, lastEventMs: 87_000 })).toEqual([]);
  });

  it('still demands a real tail from a hold of half a second or less', () => {
    // The absolute floor was uncapped, so at a 500ms hold the required tail was
    // zero and at 400ms it was negative. A take whose file ended on the same
    // millisecond as its last event passed 'holds on the final screen'.
    const brief: TakeIntent = {
      ...INTENT,
      finishHoldMs: 500,
      plausibleSeconds: { least: 5, most: 60 },
    };
    const held = (durationSeconds: number, lastEventMs: number) =>
      failedChecks(
        assessTake({ ...GOOD, durationSeconds, lastEventMs }, brief),
      );

    // No tail at all is not a hold by any reading.
    expect(held(8, 8000)).toContain(
      'holds on the final screen after the last action',
    );
    // A fifth of a second short of 500ms still counts.
    expect(held(8, 7600)).toEqual([]);
  });

  it('allows a hold that falls a little short of the intended one', () => {
    // The hold is wall-clock and the encode is not exact, so grading it as
    // all-or-nothing would fail takes that are fine.
    expect(assess({ durationSeconds: 93, lastEventMs: 87_000 })).toEqual([]);
  });

  it('catches a transcript that runs past the end of its own video', () => {
    // The two-clock failure: timestamps mapped through a speed table that
    // disagreed with the file, describing frames that do not exist.
    const failures = assess({ durationSeconds: 60, lastEventMs: 87_000 });

    expect(failures).toContain('transcript ends within the video');
  });

  it('catches a refusal being recorded as a working demo', () => {
    expect(assess({ terminalState: 'failed' })).toContain(
      'reached its done screen',
    );
  });

  it('grades against the success state the CALLER named', () => {
    // The seam. This check hardcoded 'done', which is one app's success state
    // sitting in the generic grader. An app whose happy path ends on a screen
    // called anything else was graded as having failed every take.
    const shopIntent: TakeIntent = { ...INTENT, successState: 'checkout-done' };
    const graded = (terminalState: string) =>
      assessTake({ ...GOOD, terminalState }, shopIntent)
        .filter(check => !check.didPass)
        .map(check => check.label);

    expect(graded('checkout-done')).toEqual([]);
    expect(graded('done')).toContain('reached its checkout-done screen');
  });

  it('catches a take that is too short to be a walkthrough', () => {
    expect(assess({ durationSeconds: 4, lastEventMs: 1000 })).toContain(
      'runs for a plausible length (20 to 600s)',
    );
  });

  it('catches a take that hung rather than finished', () => {
    expect(assess({ durationSeconds: 4000, lastEventMs: 3_990_000 })).toContain(
      'runs for a plausible length (20 to 600s)',
    );
  });

  it('reports every failure, not just the first', () => {
    // A bad take usually breaks several at once, and fixing them one viewing at
    // a time is the loop this exists to end.
    expect(
      assess({
        width: 800,
        height: 600,
        backdropRows: 30,
        terminalState: 'failed',
      }).length,
    ).toBe(3);
  });
});

describe("plausible length is the caller's, not the library's", () => {
  it('accepts a short take for an app whose walkthrough IS short', () => {
    // The seam. This was hardcoded at 20 seconds, one app's floor,
    // and it failed the eight-second example that ships with the library.
    const brisk: TakeIntent = {
      ...INTENT,
      plausibleSeconds: { least: 5, most: 60 },
    };

    // A coherent short take, not just a short number: the transcript has to end
    // inside the video and leave room for the closing hold.
    expect(
      failedChecks(
        assessTake(
          { ...GOOD, durationSeconds: 8, lastEventMs: 500 },
          { ...brisk, finishHoldMs: 800 },
        ),
      ),
    ).toEqual([]);
  });

  it("still catches a take too short even by the caller's own floor", () => {
    const brisk: TakeIntent = {
      ...INTENT,
      plausibleSeconds: { least: 5, most: 60 },
    };

    expect(
      failedChecks(
        assessTake(
          { ...GOOD, durationSeconds: 2, lastEventMs: 200 },
          { ...brisk, finishHoldMs: 800 },
        ),
      ),
    ).toContain('runs for a plausible length (5 to 60s)');
  });

  it('names the bounds it applied, so a failure is actionable', () => {
    // "runs for a plausible length" alone left a reader guessing what the
    // library thought plausible meant.
    expect(
      failedChecks(assessTake({ ...GOOD, durationSeconds: 900 }, INTENT)),
    ).toContain('runs for a plausible length (20 to 600s)');
  });
});
