import { describe, expect, it } from 'vitest';

import { asObserved, assessTiming } from './timing';

import type { Press } from './press-mark';
import type { Interaction, TimingIntent } from './timing';

const INTENT: TimingIntent = {
  minPressVisibleMs: 250,
  // The two screens that legitimately arrive on their own: a slow backend call
  // finishing and a slow action confirming.
  arrivesUnprompted: ['shop-cart-step'],
};

/**
 * The press log a cooperative page would have produced.
 *
 * Supplied rather than left empty, because assessTiming now times each press by
 * what the PAGE saw. With no presses at all every interaction is unobserved and
 * the rest of the checks have nothing left to grade, so a test that omitted
 * them would pass while asserting nothing.
 */
const asSeenByPage = (interactions: Interaction[]): Press[] =>
  interactions.map(interaction => ({
    testId: interaction.target,
    atEpochMs: interaction.clickedAtMs,
    x: 0,
    y: 0,
  }));

const failuresOf = (
  interactions: Interaction[],
  screens: { testId: string; atEpochMs: number }[],
  presses: Press[] = asSeenByPage(interactions),
) =>
  assessTiming(interactions, screens, INTENT, presses)
    .filter(check => !check.didPass)
    .map(check => check.label);

describe('assessTiming', () => {
  it('passes an interaction that reads as cause and then effect', () => {
    // Ready, clicked a beat later, and the screen follows well after the press
    // and its label have had their moment.
    expect(
      failuresOf(
        [{ target: 'get-started', readyAtMs: 1000, clickedAtMs: 3000 }],
        [{ testId: 'next-step', atEpochMs: 4200 }],
      ),
    ).toEqual([]);
  });

  it('catches a screen that changed under the press', () => {
    // The defect the eye kept catching: the app navigates within milliseconds
    // of the click, so the press and the new screen arrive together and the
    // press appears to belong to the screen it caused.
    const failures = failuresOf(
      [{ target: 'get-started', readyAtMs: 1000, clickedAtMs: 3000 }],
      [{ testId: 'next-step', atEpochMs: 3005 }],
    );

    expect(failures).toContainEqual(
      expect.stringContaining('visible for 250ms before its screen changed'),
    );
    expect(failures.join(' ')).toContain('get-started');
  });

  it('names which interaction was rushed, not just how many', () => {
    // A failure that says '2 problems' sends you back to watching the video,
    // which is the loop this replaces.
    const failures = failuresOf(
      [
        { target: 'first', readyAtMs: 0, clickedAtMs: 1000 },
        { target: 'second', readyAtMs: 2000, clickedAtMs: 3000 },
      ],
      [
        { testId: 'a', atEpochMs: 1010 },
        { testId: 'b', atEpochMs: 3010 },
      ],
    );

    expect(failures.join(' ')).toContain('first, second');
  });

  it('catches a click aimed at something that had already gone', () => {
    // A screen arrived between the target settling and the click landing, so
    // whatever was clicked, it was not the thing that had been aimed at.
    expect(
      failuresOf(
        [{ target: 'get-started', readyAtMs: 1000, clickedAtMs: 3000 }],
        [{ testId: 'moved-on', atEpochMs: 2000 }],
      ).join(' '),
    ).toContain('still there');
  });

  it('does not fault a press for a screen that follows it promptly', () => {
    // There used to be a check here that the mark had finished before the next
    // screen, and this case failed it. The mark is drawn by the page now and
    // removed the moment its target leaves the DOM, so a screen arriving soon
    // after a press is simply a responsive app, not a mark left hanging.
    // press-mark.test.ts covers the removal that makes this true.
    expect(
      failuresOf(
        [{ target: 'get-started', readyAtMs: 0, clickedAtMs: 1000 }],
        [{ testId: 'next', atEpochMs: 1400 }],
      ),
    ).toEqual([]);
  });

  it('does not fault the last interaction, which changes no screen', () => {
    // The final click submits and the take ends on that screen, so there is no
    // following change and nothing to be early or late against. The review
    // screen arrives BEFORE its button settles, which is the only coherent
    // order: a target cannot be ready on a screen that has not arrived.
    expect(
      failuresOf(
        [
          // The click that brought the review screen up, far enough ahead of
          // it that its label is long gone before the screen changes.
          { target: 'first-primary', readyAtMs: 0, clickedAtMs: 100 },
          // The last click of the take. Nothing follows it, so there is no
          // screen for it to be early or late against.
          { target: 'confirm', readyAtMs: 3000, clickedAtMs: 4000 },
        ],
        [{ testId: 'shop-confirm-step', atEpochMs: 2000 }],
      ),
    ).toEqual([]);
  });

  it('catches a screen that arrived without anyone clicking anything', () => {
    // If the walkthrough is genuinely reactive, a page cannot move unless a
    // present control was pressed. So a screen with no click behind it, and no
    // standing reason to appear on its own, means something drove the app that
    // the walkthrough did not.
    const failures = failuresOf(
      [{ target: 'get-started', readyAtMs: 0, clickedAtMs: 1000 }],
      [
        { testId: 'expected', atEpochMs: 1400 },
        // Nothing was pressed between 'expected' and this, so the app moved on
        // its own.
        { testId: 'out-of-nowhere', atEpochMs: 30_000 },
      ],
    );

    expect(failures.join(' ')).toContain('out-of-nowhere');
    expect(failures.join(' ')).not.toContain('expected,');
  });

  it('credits a click however long the app then takes to arrive', () => {
    // That step lands well over three seconds after the click that causes
    // it, because the app does slow work in between. An elapsed-time rule reported
    // that as appearing out of nowhere, which is what replaced it with order.
    expect(
      failuresOf(
        [{ target: 'verify-primary', readyAtMs: 0, clickedAtMs: 1000 }],
        [{ testId: 'shop-pay-step', atEpochMs: 45_000 }],
      ).join(' '),
    ).not.toContain('reached by clicking');
  });

  it('allows a screen that is listed as arriving on its own', () => {
    expect(
      failuresOf([], [{ testId: 'shop-cart-step', atEpochMs: 500 }]).join(' '),
    ).not.toContain('reached by clicking');
  });

  it('passes when nothing was recorded rather than inventing a verdict', () => {
    // An empty screen log means the page watcher never installed. That is a
    // real problem, but it is not evidence of bad timing, and reporting it as
    // such would send someone chasing the wrong thing.
    expect(
      failuresOf(
        [{ target: 'get-started', readyAtMs: 0, clickedAtMs: 1000 }],
        [],
      ),
    ).toEqual([]);
  });
});

describe('asObserved', () => {
  const click = (target: string, readyAtMs: number, clickedAtMs: number) => ({
    target,
    readyAtMs,
    clickedAtMs,
  });
  const seen = (testId: string, atEpochMs: number): Press => ({
    testId,
    atEpochMs,
    x: 0,
    y: 0,
  });

  it('retimes a press to the moment the page saw it', () => {
    // The whole point. The harness stamps a press when it CALLS click, and
    // playwright then resolves, checks actionability, scrolls and computes a
    // hit target before dispatching anything, so the recorded moment can lead
    // the real one by most of a second.
    const { observed } = asObserved(
      [click('get-started', 1000, 2000)],
      [seen('get-started', 2900)],
    );

    expect(observed).toEqual([
      { target: 'get-started', readyAtMs: 1000, clickedAtMs: 2900 },
    ]);
  });

  it('reports a click the page never saw, rather than keeping the guess', () => {
    // Keeping the assumed timestamp would let every downstream check pass on a
    // press that never happened, which is the failure mode this file exists to
    // catch in the first place.
    const { observed, unobserved } = asObserved(
      [click('get-started', 1000, 2000)],
      [],
    );

    expect(observed).toEqual([]);
    expect(unobserved.map(interaction => interaction.target)).toEqual([
      'get-started',
    ]);
  });

  it('ignores a press that happened before its target was ready', () => {
    // A press on the same testID from an earlier screen. Matching it would
    // date this interaction to something that happened before its control
    // existed, and the staleness check would then read as fine.
    const { unobserved } = asObserved(
      [click('a-toggle', 5000, 6000)],
      [seen('a-toggle', 1000)],
    );

    expect(unobserved).toHaveLength(1);
  });

  it('pairs repeated presses on one control in order', () => {
    // The reveal toggle is pressed twice on purpose. Both presses have to
    // find their own report, or the second is called unobserved and the first
    // is timed twice.
    const { observed, unobserved } = asObserved(
      [click('a-toggle', 1000, 2000), click('a-toggle', 3000, 4000)],
      [seen('a-toggle', 2100), seen('a-toggle', 4100)],
    );

    expect(observed.map(interaction => interaction.clickedAtMs)).toEqual([
      2100, 4100,
    ]);
    expect(unobserved).toEqual([]);
  });

  it('does not let one report cover two interactions', () => {
    const { observed, unobserved } = asObserved(
      [click('a-toggle', 1000, 2000), click('a-toggle', 3000, 4000)],
      [seen('a-toggle', 2100)],
    );

    expect(observed).toHaveLength(1);
    expect(unobserved).toHaveLength(1);
  });

  it('ignores presses on other controls', () => {
    const { observed } = asObserved(
      [click('get-started', 1000, 2000)],
      [seen('something-else', 2100), seen('get-started', 2500)],
    );

    expect(observed[0].clickedAtMs).toBe(2500);
  });
});
