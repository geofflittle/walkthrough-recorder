import { describe, expect, it } from 'vitest';

import {
  allowedPresses,
  targetsOf,
  assessPresses,
  assessSequence,
  expectedFrom,
  extraPresses,
  firstDivergence,
} from './sequence';

import type { ExpectedEvent } from './sequence';

const SCRIPT: ExpectedEvent[] = [
  { kind: 'click', target: 'first' },
  { kind: 'type', target: 'a-field' },
  { kind: 'click', target: 'last' },
];

const ran = (steps: { kind: string; target: string }[]) =>
  steps as Parameters<typeof firstDivergence>[0];

describe('firstDivergence', () => {
  it('is undefined when every step was performed in order', () => {
    expect(firstDivergence(ran(SCRIPT), SCRIPT)).toBe(undefined);
  });

  it('ignores everything the run did in between', () => {
    // Matched as a subsequence, so waits, notes and screens arriving do not
    // have to be enumerated in the script, and a take may do more than it says.
    expect(
      firstDivergence(
        ran([
          { kind: 'ready', target: 'first' },
          { kind: 'click', target: 'first' },
          { kind: 'wait', target: 'linger' },
          { kind: 'type', target: 'a-field' },
          { kind: 'note', target: 'anything' },
          { kind: 'click', target: 'last' },
        ]),
        SCRIPT,
      ),
    ).toBe(undefined);
  });

  it('catches a step that was skipped entirely', () => {
    // The failure every other check is blind to: a well-formed video of the
    // wrong thing. A take that never presses the paste button still has correct
    // framing, correct timing and a terminal screen.
    expect(
      firstDivergence(
        ran([
          { kind: 'click', target: 'first' },
          { kind: 'click', target: 'last' },
        ]),
        SCRIPT,
      ),
    ).toEqual({ atStep: 1, expected: { kind: 'type', target: 'a-field' } });
  });

  it('catches steps performed out of order', () => {
    expect(
      firstDivergence(
        ran([
          { kind: 'click', target: 'last' },
          { kind: 'click', target: 'first' },
          { kind: 'type', target: 'a-field' },
        ]),
        SCRIPT,
      ),
    ).toEqual({ atStep: 2, expected: { kind: 'click', target: 'last' } });
  });

  it('distinguishes typing a field from clicking it', () => {
    // The password fields are typed on purpose. A take that filled them
    // instantly would otherwise look identical to this check.
    expect(
      firstDivergence(
        ran([
          { kind: 'click', target: 'first' },
          { kind: 'click', target: 'a-field' },
          { kind: 'click', target: 'last' },
        ]),
        SCRIPT,
      )?.expected,
    ).toEqual({ kind: 'type', target: 'a-field' });
  });

  it('requires a repeated step to happen as many times as it is written', () => {
    // The reveal toggle is pressed twice, on and then off. Matching from
    // after the previous hit is what stops one press satisfying both.
    const twice: ExpectedEvent[] = [
      { kind: 'click', target: 'toggle' },
      { kind: 'click', target: 'toggle' },
    ];

    expect(
      firstDivergence(ran([{ kind: 'click', target: 'toggle' }]), twice),
    ).toEqual({ atStep: 1, expected: { kind: 'click', target: 'toggle' } });
    expect(
      firstDivergence(
        ran([
          { kind: 'click', target: 'toggle' },
          { kind: 'click', target: 'toggle' },
        ]),
        twice,
      ),
    ).toBe(undefined);
  });
});

describe('assessSequence', () => {
  it('names the step that was missed, not just that one was', () => {
    const [check] = assessSequence(
      ran([{ kind: 'click', target: 'first' }]),
      SCRIPT,
    );

    expect(check.didPass).toBe(false);
    expect(check.label).toContain('step 2: type a-field');
  });
});

describe('expectedFrom', () => {
  it('expects only the value for a text entry, never a press first', () => {
    // Typing focuses its own field. A separate click was performed once, so the
    // transcript would admit to a press a viewer could see, but playwright
    // outlines the target of every action and the field therefore lit up twice
    // for one gesture. Expecting a press here again would re-open the slot.
    expect(
      expectedFrom([{ do: 'type', target: 'a-field', value: 'password' }]),
    ).toEqual([{ kind: 'type', target: 'a-field' }]);
  });

  it('expects nothing from steps that may not happen', () => {
    // The wizard's password prompt appears only sometimes, so requiring it
    // would fail honest takes. It is covered by `required` where it runs.
    expect(
      expectedFrom([
        {
          do: 'ifPresent',
          target: 'a-prompt',
          required: false,
          then: [{ do: 'click', target: 'confirm' }],
        },
        {
          do: 'capture',
          as: 'recoveredCode',
          wordTemplate: 'w-{index}',
          count: 2,
        },
      ]),
    ).toEqual([]);
  });

  it('expects a scroll of its own, since a viewer can see one', () => {
    // A scroll moves the frame, so leaving it out of the expectation means the
    // transcript and the video disagree about what the take did.
    expect(expectedFrom([{ do: 'scrollTo', target: 'a-panel' }])).toEqual([
      { kind: 'scroll', target: 'a-panel' },
    ]);
  });

  it('expects a wait for a deliberate pause, under one shared name', () => {
    // Targeted at 'linger' rather than a control, because a hold is not about
    // any element. Two holds in a row are therefore indistinguishable, which is
    // correct: a viewer cannot tell them apart either.
    expect(
      expectedFrom([
        { do: 'hold', ms: 1200, note: 'reading the phrase' },
        { do: 'hold', ms: 800, note: 'reading it again' },
      ]),
    ).toEqual([
      { kind: 'wait', target: 'linger' },
      { kind: 'wait', target: 'linger' },
    ]);
  });

  it('keeps every step in the order the script wrote them', () => {
    // The whole value of deriving the expectation: a script read top to bottom
    // IS the sequence, so a reordering in the driver shows up as a divergence
    // rather than as a video someone has to watch.
    expect(
      expectedFrom([
        { do: 'scrollTo', target: 'a-panel' },
        { do: 'click', target: 'a-button' },
        { do: 'hold', ms: 500, note: 'settling' },
        { do: 'awaitScreen', target: 'next-step' },
      ]),
    ).toEqual([
      { kind: 'scroll', target: 'a-panel' },
      { kind: 'click', target: 'a-button' },
      { kind: 'wait', target: 'linger' },
      { kind: 'enter', target: 'next-step' },
    ]);
  });
});

describe('assessPresses', () => {
  const pressed = (...targets: string[]) =>
    targets.map(target => ({ kind: 'click' as const, target }));

  it('passes when every press was one the script asked for', () => {
    expect(
      assessPresses(pressed('a-button'), new Map([['a-button', 1]])),
    ).toEqual([
      {
        label: 'every control was pressed as often as the script asked',
        didPass: true,
      },
    ]);
  });

  it('names the control and the surplus when one was pressed twice', () => {
    // This is the doubled-mark defect stated as a failure a reader can act on.
    // "presses do not match" would have sent someone back to the video, which
    // is the loop the grading exists to end.
    expect(
      assessPresses(
        pressed('a-button', 'a-button'),
        new Map([['a-button', 1]]),
      ),
    ).toEqual([
      {
        label:
          'a control was drawn as pressed more often than the script asked: a-button (+1)',
        didPass: false,
      },
    ]);
  });

  it('lists every offending control, not just the first', () => {
    expect(
      assessPresses(
        pressed('one', 'one', 'two', 'two', 'two'),
        new Map([
          ['one', 1],
          ['two', 1],
        ]),
      )[0].label,
    ).toBe(
      'a control was drawn as pressed more often than the script asked: one (+1), two (+2)',
    );
  });

  it('fails a press on a control the script never mentions', () => {
    // Allowance zero rather than absent. A press nobody asked for is the same
    // defect as one press too many, and reads the same way.
    expect(assessPresses(pressed('a-ghost'), new Map())[0].didPass).toBe(false);
  });
});

describe('allowedPresses', () => {
  it('allows one press per click and none for a text entry', () => {
    // Nothing presses a field any more, so any press on one is a press nobody
    // asked for. The allowance used to cover a deliberate click into the field,
    // and leaving it would keep a slot open for exactly the stray press this
    // check exists to catch.
    expect([
      ...allowedPresses([
        { do: 'click', target: 'submit' },
        { do: 'type', target: 'a-field', value: 'password' },
      ]),
    ]).toEqual([['submit', 1]]);
  });

  it('counts presses inside an optional branch', () => {
    // The wizard's password prompt is optional, so it is absent from the
    // EXPECTED transcript. But when it does appear it is pressed for real, and
    // an allowance of zero flagged two legitimate prompts as phantom presses.
    expect([
      ...allowedPresses([
        {
          do: 'ifPresent',
          target: 'a-prompt',
          required: false,
          then: [{ do: 'click', target: 'confirm' }],
        },
      ]),
    ]).toEqual([['confirm', 1]]);
  });

  it('allows a control the script presses more than once', () => {
    expect(
      allowedPresses([
        { do: 'click', target: 'toggle' },
        { do: 'click', target: 'toggle' },
      ]).get('toggle'),
    ).toBe(2);
  });
});

describe('extraPresses', () => {
  const allowance = new Map([
    ['toggle', 2],
    ['submit', 1],
  ]);

  it('accepts a control pressed exactly as often as allowed', () => {
    // The reveal toggle really is pressed twice running, on and then off.
    // A rule like "no two presses in a row" would flag that, which is why this
    // counts against the script instead of judging the shape.
    expect(
      extraPresses(
        [
          { kind: 'click', target: 'toggle' },
          { kind: 'click', target: 'toggle' },
        ],
        allowance,
      ),
    ).toEqual([]);
  });

  it('catches a control drawn as pressed more often than allowed', () => {
    // The failure that shipped: one control marked pressed twice where the
    // script asked once, which a viewer reads as two clicks.
    expect(
      extraPresses(
        [
          { kind: 'click', target: 'submit' },
          { kind: 'click', target: 'submit' },
        ],
        allowance,
      ),
    ).toEqual([{ target: 'submit', extra: 1 }]);
  });

  it('says by how much, so a doubling differs from a storm', () => {
    expect(
      extraPresses(
        [
          { kind: 'click', target: 'submit' },
          { kind: 'click', target: 'submit' },
          { kind: 'click', target: 'submit' },
        ],
        allowance,
      ),
    ).toEqual([{ target: 'submit', extra: 2 }]);
  });

  it('ignores typing, which is not a press', () => {
    expect(
      extraPresses(
        [
          { kind: 'click', target: 'submit' },
          { kind: 'type', target: 'submit' },
        ],
        allowance,
      ),
    ).toEqual([]);
  });
});

describe('targetsOf', () => {
  it('collects every testID the script touches', () => {
    expect(
      targetsOf([
        { do: 'click', target: 'a-button' },
        { do: 'awaitScreen', target: 'a-screen' },
        { do: 'scrollTo', target: 'a-panel' },
      ]),
    ).toEqual(['a-button', 'a-screen', 'a-panel']);
  });

  it('reaches inside an optional branch', () => {
    // A press behind an ifPresent is still a testID a rename can break, and a
    // hand-written list is exactly where those go missing.
    expect(
      targetsOf([
        {
          do: 'ifPresent',
          target: 'a-prompt',
          required: false,
          then: [{ do: 'click', target: 'a-confirm' }],
        },
      ]),
    ).toEqual(['a-prompt', 'a-confirm']);
  });

  it('says each id once, however often the script uses it', () => {
    expect(
      targetsOf([
        { do: 'click', target: 'a-toggle' },
        { do: 'click', target: 'a-toggle' },
      ]),
    ).toEqual(['a-toggle']);
  });

  it('ignores steps that touch no control', () => {
    expect(
      targetsOf([
        { do: 'hold', ms: 0, note: 'a beat' },
        { do: 'setClipboard', value: 'aValue' },
      ]),
    ).toEqual([]);
  });
});

describe('targetsOf and a capture step', () => {
  it('returns the word testIDs a capture reads, not nothing', () => {
    // A capture carries no `target` field, so the earlier shape skipped it
    // while the performer built one selector per word. In one real script
    // that is 24 live selectors the guard never saw.
    expect(
      targetsOf([
        {
          do: 'capture',
          as: 'phrase',
          wordTemplate: 'w-{index}-blur',
          count: 3,
        },
      ]),
    ).toEqual(['w-1-blur', 'w-2-blur', 'w-3-blur']);
  });

  it('finds a capture nested inside an ifPresent', () => {
    expect(
      targetsOf([
        {
          do: 'ifPresent',
          target: 'maybe',
          required: false,
          then: [
            {
              do: 'capture',
              as: 'phrase',
              wordTemplate: 'w-{index}',
              count: 2,
            },
          ],
        },
      ]),
    ).toEqual(['maybe', 'w-1', 'w-2']);
  });
});
