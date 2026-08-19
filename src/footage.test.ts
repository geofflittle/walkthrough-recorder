import { describe, expect, it } from 'vitest';

import { makeFootage } from './footage';

/**
 * Synchronous throughout, because frames resolve the waiters and nothing here
 * owns a timer. That is the point of the split: the thing that decides when a
 * hold is complete can be tested without waiting for one.
 */
const AT = 1_787_079_464_872;

describe('makeFootage', () => {
  it('knows nothing before a frame arrives', () => {
    expect(makeFootage().recordedUntilMs()).toBeUndefined();
  });

  it('reports the newest frame it has seen', () => {
    const footage = makeFootage();

    footage.sawFrame(AT);
    footage.sawFrame(AT + 200);

    expect(footage.recordedUntilMs()).toBe(AT + 200);
  });

  it('refuses to let the clock run backwards', () => {
    // Frames arrive out of order under load. Accepting an older timestamp would
    // not un-resolve anything, but it would make the NEXT wait hang for the
    // difference, which reads as a stalled encoder.
    const footage = makeFootage();

    footage.sawFrame(AT + 500);
    footage.sawFrame(AT + 100);

    expect(footage.recordedUntilMs()).toBe(AT + 500);
  });
});

describe('awaiting footage', () => {
  it('waits until the frames have actually arrived', async () => {
    // The defect this exists for. A wall-clock sleep returns whether or not the
    // encoder kept up, and the file ends short of the hold that was asked for.
    const footage = makeFootage();
    footage.sawFrame(AT);

    let arrived = false;
    const held = footage.awaitFootage(AT, 800).then(() => {
      arrived = true;
    });

    footage.sawFrame(AT + 400);
    await Promise.resolve();
    expect(arrived).toBe(false);

    footage.sawFrame(AT + 800);
    await held;
    expect(arrived).toBe(true);
  });

  it('returns at once when the footage is already there', async () => {
    const footage = makeFootage();
    footage.sawFrame(AT + 5000);

    await footage.awaitFootage(AT, 800);

    expect(footage.waiting()).toBe(0);
  });

  it('releases every waiter a single frame satisfies', async () => {
    // Splicing forwards used to skip the next one, which left a waiter pending
    // behind a frame that had already passed it.
    const footage = makeFootage();
    footage.sawFrame(AT);
    const all = Promise.all([
      footage.awaitFootage(AT, 100),
      footage.awaitFootage(AT, 200),
      footage.awaitFootage(AT, 300),
    ]);

    footage.sawFrame(AT + 400);

    await all;
    expect(footage.waiting()).toBe(0);
  });

  it('keeps waiting for the one the frame did not reach', async () => {
    const footage = makeFootage();
    footage.sawFrame(AT);
    let far = false;
    void footage.awaitFootage(AT, 100);
    void footage.awaitFootage(AT, 5000).then(() => {
      far = true;
    });

    footage.sawFrame(AT + 200);
    await Promise.resolve();

    expect(far).toBe(false);
    expect(footage.waiting()).toBe(1);
  });

  it('waits forever when no frame ever arrives, so a caller must bound it', async () => {
    // Stated rather than fixed. A stalled encoder is a real failure and the
    // caller races its own ceiling, which keeps timers out of here entirely.
    const footage = makeFootage();
    let arrived = false;
    void footage.awaitFootage(AT, 100).then(() => {
      arrived = true;
    });

    await Promise.resolve();

    expect(arrived).toBe(false);
    expect(footage.waiting()).toBe(1);
  });
});
