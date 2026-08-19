import { describe, expect, it, vi } from 'vitest';

import { makeActor, PRESS_HOLD_MS } from './actor';
import { makeTimeline } from './timeline';

import type { Page } from 'playwright';

/**
 * Just enough page to drive the actor's waiting.
 *
 * Hand-rolled rather than mocked wholesale, because what matters is WHICH
 * conditions are waited for and in what order, and a stub that records them
 * says that directly.
 */
const stubPage = ({
  visible = true,
  settles = true,
  attached = true,
}: {
  visible?: boolean;
  /** Whether playwright's own stability wait resolves or times out. */
  settles?: boolean;
  /** Whether an element handle can still be taken once it is visible. */
  attached?: boolean;
} = {}) => {
  const asked: string[] = [];
  const page = {
    locator: () => ({
      waitFor: vi.fn(async () => {
        asked.push('visible');
        if (!visible) throw new Error('locator.waitFor timed out');
      }),
      elementHandle: vi.fn(async () => {
        // Waits for the element itself, so an invisible control times out here
        // rather than in a separate visibility wait.
        if (!visible) throw new Error('elementHandle timed out');
        if (!attached) return null;
        return {
          waitForElementState: vi.fn(async (state: string) => {
            asked.push(state);
            if (!settles) throw new Error('waitForElementState timed out');
          }),
        };
      }),
    }),
    waitForTimeout: vi.fn(async () => undefined),
  } as unknown as Page;

  return { page, asked };
};

const actorFor = (page: Page) => makeActor({ page, timeline: makeTimeline() });

describe('awaitReady', () => {
  it('waits on stability, which already covers visibility', async () => {
    // A control mid-transition is visible and still moving, and the pointer
    // would be drawn travelling to where it used to be. 'stable' is
    // playwright's own condition for both, so waiting on visibility separately
    // was redundant and only widened the window for the handle to go stale.
    const { page, asked } = stubPage();

    await actorFor(page).awaitReady('a-button');

    expect(asked).toEqual(['stable']);
  });

  it('refuses to mint proof for a control that never settles', async () => {
    // The token asserts a control was painted and had settled. An earlier
    // version ran out of polling attempts and handed one back anyway, so a
    // control that never stopped moving was declared ready, which makes every
    // guarantee built on the token decorative in exactly the case it covers.
    const { page } = stubPage({ settles: false });

    await expect(
      actorFor(page).awaitReady('a-restless-button'),
    ).rejects.toThrow(/timed out/);
  });

  it('refuses to mint proof for a control that goes away again', async () => {
    // Visible one moment and detached the next. There is nothing left to be
    // stable, so there is nothing to prove.
    const { page } = stubPage({ attached: false });

    await expect(actorFor(page).awaitReady('a-ghost')).rejects.toThrow(
      /a-ghost never appeared/,
    );
  });

  it('propagates a control that never becomes visible', async () => {
    const { page } = stubPage({ visible: false });

    await expect(actorFor(page).awaitReady('a-missing-button')).rejects.toThrow(
      /timed out/,
    );
  });
});

describe('appears', () => {
  it('reports a control that turns up', async () => {
    const { page } = stubPage();

    expect(
      await actorFor(page).appears('a-prompt', {
        timeout: 10,
        required: false,
      }),
    ).toBe(true);
  });

  it('reports absence rather than failing, when absence is allowed', async () => {
    // The wizard's password prompt is usually absent, because the app lock is
    // already unlocked, and failing there would fail honest takes.
    const { page } = stubPage({ visible: false });

    expect(
      await actorFor(page).appears('a-prompt', {
        timeout: 10,
        required: false,
      }),
    ).toBe(false);
  });

  it('fails when the control was required', async () => {
    // Importing the source has prompted in every observed run, and a missing
    // prompt there means the action is never confirmed.
    const { page } = stubPage({ visible: false });

    await expect(
      actorFor(page).appears('a-prompt', { timeout: 10, required: true }),
    ).rejects.toThrow(/timed out/);
  });
});

/**
 * A page that records what was done to it, for the acting half of the actor.
 *
 * Separate from stubPage above, which exists to drive the waiting. What matters
 * here is the opposite: which playwright calls an interaction makes, and which
 * it does NOT. Most of the defects this file guards were extra calls rather
 * than missing ones, because playwright decorates every action it recognises
 * and two decorations on one control read as two interactions.
 */
const recordingPage = ({ painted = 760 } = {}) => {
  const did: string[] = [];
  const locator = (selector: string) => ({
    click: vi.fn(async (options?: { delay?: number }) => {
      did.push(`click ${selector} delay=${options?.delay}`);
    }),
    hover: vi.fn(async () => {
      did.push(`hover ${selector}`);
    }),
    fill: vi.fn(async (value: string) => {
      did.push(`fill ${selector}=${value}`);
    }),
    press: vi.fn(async (key: string) => {
      did.push(`press ${selector} ${key}`);
    }),
    pressSequentially: vi.fn(async (value: string) => {
      did.push(`typeInto ${selector}=${value}`);
    }),
    waitFor: vi.fn(async () => {
      did.push(`waitFor ${selector}`);
    }),
    innerText: vi.fn(async () => 'the text'),
    count: vi.fn(async () => 3),
    evaluate: vi.fn(async () => {
      did.push(`scroll ${selector}`);
    }),
    elementHandle: vi.fn(async () => ({
      waitForElementState: vi.fn(async () => undefined),
    })),
  });
  const page = {
    locator: vi.fn(locator),
    waitForTimeout: vi.fn(async (ms: number) => {
      did.push(`wait ${ms}`);
    }),
    evaluate: vi.fn(async () => painted),
    keyboard: {
      press: vi.fn(async (key: string) => {
        did.push(`keyboard ${key}`);
      }),
    },
  } as unknown as Page;

  return { page, did };
};

const acting = (page: Page) => {
  const timeline = makeTimeline();
  return { actor: makeActor({ page, timeline, dwellMs: 100 }), timeline };
};

/** A token, minted the only legitimate way, for the methods that need one. */
const proofOf = async (actor: ReturnType<typeof acting>['actor'], id: string) =>
  actor.awaitReady(id);

describe('click', () => {
  it('holds the press, rather than pressing instantaneously', async () => {
    // playwright's default puts mousedown and mouseup in the same millisecond,
    // so the button never enters its own :active state and the app navigates
    // before anything is visible. The press has to occupy real time for the
    // drawn indicator to sit on top of something true.
    //
    // Asserted against the constant rather than a literal, so tuning the hold
    // does not fail a test about whether it is passed at all.
    const { page, did } = recordingPage();
    const { actor } = acting(page);

    await actor.click(await proofOf(actor, 'a-button'));

    expect(did.some(entry => entry.includes(`delay=${PRESS_HOLD_MS}`))).toBe(
      true,
    );
  });

  it('holds long enough for the mark to be seen before the app reacts', () => {
    // The hold IS the still moment. The mark is drawn on mousedown and the app
    // reacts on mouseup, so anything shorter puts the mark on a screen that is
    // already repainting. Measured on a take, the two presses that read clearly
    // were the ones whose screen happened not to move for two seconds.
    expect(PRESS_HOLD_MS).toBeGreaterThanOrEqual(250);
  });

  it('never hovers first', async () => {
    // The regression this exists for. Hovering and then clicking drew two
    // decorations on one button, each with its own outline and title, a dwell
    // apart, which a viewer counts as two presses.
    const { page, did } = recordingPage();
    const { actor } = acting(page);

    await actor.click(await proofOf(actor, 'a-button'));

    expect(did.filter(entry => entry.startsWith('hover'))).toEqual([]);
  });

  it('takes the extra beat before acting when one is asked for', async () => {
    const { page, did } = recordingPage();
    const { actor } = acting(page);

    await actor.click(await proofOf(actor, 'a-button'), { beforeMs: 3000 });

    expect(did[0]).toBe('wait 3000');
  });

  it('records the press, and when its target was ready', async () => {
    // Both timestamps, because the check they feed asks whether the screen
    // changed between the target settling and the press landing, which is how
    // a press on something already gone was finally caught by code.
    const { page } = recordingPage();
    const { actor, timeline } = acting(page);

    await actor.click(await proofOf(actor, 'a-button'));

    expect(timeline.events().map(event => event.kind)).toContain('click');
    const [interaction] = actor.interactions();
    expect(interaction.target).toBe('a-button');
    expect(interaction.readyAtMs).toBeLessThanOrEqual(interaction.clickedAtMs);
  });
});

describe('type', () => {
  it('never clicks the field first', async () => {
    // pressSequentially focuses the element itself. A separate click was
    // performed once so the transcript would admit to a press a viewer could
    // see, but it made the field light up twice for one gesture.
    const { page, did } = recordingPage();
    const { actor } = acting(page);

    await actor.type(await proofOf(actor, 'a-field'), 'secret');

    expect(did.filter(entry => entry.startsWith('click'))).toEqual([]);
    expect(did).toContain('typeInto [data-testid="a-field"]=secret');
  });

  it('records how long the typing took, and how much there was', async () => {
    const { page } = recordingPage();
    const { actor, timeline } = acting(page);

    await actor.type(await proofOf(actor, 'a-field'), 'secret');

    expect(timeline.events().at(-1)).toMatchObject({
      kind: 'type',
      target: 'a-field',
      detail: '6 chars',
    });
  });
});

describe('fill', () => {
  it('pastes for real, clipboard then chord, rather than setting the value', async () => {
    // locator.fill titles itself with its argument, and the argument here is a
    // generated code, which playwright drew at the full width of the frame.
    const { page, did } = recordingPage();
    const { actor } = acting(page);

    await actor.fill(await proofOf(actor, 'a-field'), 'a phrase');

    expect(did.filter(entry => entry.startsWith('fill'))).toEqual([]);
    expect(did.some(entry => /^press .*(Meta|Control)\+V$/.test(entry))).toBe(
      true,
    );
  });

  it('presses the chord on the field, not on the keyboard at large', async () => {
    // locator.press focuses the element as part of the same action, which is
    // what the removed click was really for. A bare keyboard press would land
    // on whatever happened to hold focus.
    const { page, did } = recordingPage();
    const { actor } = acting(page);

    await actor.fill(await proofOf(actor, 'a-field'), 'a phrase');

    expect(did.filter(entry => entry.startsWith('keyboard'))).toEqual([]);
  });

  it('records it as a paste', async () => {
    const { page } = recordingPage();
    const { actor, timeline } = acting(page);

    await actor.fill(await proofOf(actor, 'a-field'), 'a phrase');

    expect(timeline.events().at(-1)).toMatchObject({
      kind: 'type',
      detail: 'pasted',
    });
  });
});

describe('linger', () => {
  it('waits, and touches nothing while it waits', async () => {
    // It used to hover the body every couple of seconds so a post-render would
    // not compress the hold. Nothing compresses anything now, and each tick
    // outlined its target, so every held screen flashed blue end to end.
    const { page, did } = recordingPage();
    const { actor } = acting(page);

    await actor.linger(6000, 'reading');

    expect(did).toEqual(['wait 6000']);
  });

  it('records the hold and what it was for', async () => {
    const { page } = recordingPage();
    const { actor, timeline } = acting(page);

    await actor.linger(6000, 'reading');

    expect(timeline.events()).toHaveLength(1);
    expect(timeline.events()[0]).toMatchObject({
      kind: 'wait',
      target: 'linger',
      durationMs: 6000,
      detail: 'reading',
    });
  });
});

describe('awaitScreen', () => {
  it('records the arrival and how tall the app actually painted', async () => {
    // The painted height is what says whether the frame is the right size. Any
    // surplus shows as Chromium's unpainted grey along the bottom.
    const { page } = recordingPage({ painted: 812 });
    const { actor, timeline } = acting(page);

    await actor.awaitScreen('a-screen');

    expect(timeline.events().map(event => event.kind)).toEqual([
      'enter',
      'note',
    ]);
    expect(timeline.events().at(-1)?.detail).toBe('painted 812px');
  });
});

describe('revealBottom', () => {
  it('scrolls, then lets the smooth scroll land before anything is clicked', async () => {
    const { page, did } = recordingPage();
    const { actor } = acting(page);

    await actor.revealBottom(await proofOf(actor, 'a-button'), 500);

    expect(did).toEqual(['scroll [data-testid="a-button"]', 'wait 500']);
  });

  it('records it as a scroll, with how long it took', async () => {
    const { page } = recordingPage();
    const { actor, timeline } = acting(page);

    await actor.revealBottom(await proofOf(actor, 'a-button'), 10);

    expect(timeline.events().at(-1)).toMatchObject({
      kind: 'scroll',
      target: 'a-button',
    });
  });
});

describe('the read-only methods', () => {
  it('read without recording anything, so they are not mistaken for actions', async () => {
    // textOf and count exist so the driver can look at the page without going
    // through an interaction. Recording them would put entries in the
    // transcript that the video cannot show.
    const { page, did } = recordingPage();
    const { actor, timeline } = acting(page);

    expect(await actor.textOf('a-label')).toBe('the text');
    expect(await actor.count('a-thing')).toBe(3);
    expect(timeline.events()).toEqual([]);
    expect(did).toEqual([]);
  });

  it('hands out a copy of the interactions, not the list it appends to', async () => {
    const { page } = recordingPage();
    const { actor } = acting(page);

    await actor.click(await proofOf(actor, 'a-button'));
    const taken = actor.interactions();
    await actor.click(await proofOf(actor, 'another-button'));

    expect(taken).toHaveLength(1);
  });
});

describe('setClipboard', () => {
  it('writes through the page, since the affordance reads the real clipboard', async () => {
    const { page } = recordingPage();
    const { actor, timeline } = acting(page);

    await actor.setClipboard('a phrase');

    expect(page.evaluate).toHaveBeenCalled();
    expect(timeline.events()).toEqual([]);
  });
});
