import type { TakeCheck } from './assess';
import { wordTargetsOf } from './script';

import type { Step } from './script';
import type { TimelineEvent } from './timeline';

/**
 * What the transcript must contain if a walkthrough was performed faithfully.
 *
 * DERIVED from the walkthrough rather than written beside it. It used to be a
 * second hand-written copy, which could disagree with the driver in either
 * direction: a step added to the driver went unchecked, and a step in the
 * script failed for the wrong reason. One list, two consumers, no drift.
 *
 * Optional steps are deliberately excluded. The wizard's password prompt
 * appears only sometimes, so requiring it would fail honest takes, and it is
 * covered instead by `required` at the point it is performed.
 */
export const expectedFrom = (steps: Step<string>[]): ExpectedEvent[] =>
  steps.flatMap((step): ExpectedEvent[] => {
    switch (step.do) {
      case 'click':
        return [{ kind: 'click', target: step.target }];
      // No click before either. Reaching a field used to be a click and then a
      // type, two actions on one element, which playwright outlined twice. The
      // typing focuses the field itself, so the gesture is one action now and
      // the transcript says so.
      case 'type':
      case 'paste':
        return [{ kind: 'type', target: step.target }];
      case 'awaitScreen':
        return [{ kind: 'enter', target: step.target }];
      case 'scrollTo':
        return [{ kind: 'scroll', target: step.target }];
      case 'hold':
        return [{ kind: 'wait', target: 'linger' }];
      // Reads nothing into the timeline, and runs only sometimes.
      case 'capture':
      case 'ifPresent':
      case 'setClipboard':
        return [];
    }
  });

/** One event the transcript must show, in this order. */
export type ExpectedEvent = { kind: TimelineEvent['kind']; target: string };

// No EXPECTED_WALKTHROUGH constant, and no defaults below. They defaulted to
// one app's script, so a caller that forgot the argument was graded against the
// that one script and passed for the wrong reason. The script is the caller's, and
// asking for it is the only way this file stays honest for a second app.

/** Where the observed run stopped matching what was expected. */
export type Divergence = { atStep: number; expected: ExpectedEvent };

/**
 * The first expected step the run failed to perform, in order.
 *
 * Undefined when the run performed all of them. Reported as the FIRST
 * divergence rather than a count, because the first one is where the walkthrough
 * actually went wrong and everything after it is a consequence.
 */
export const firstDivergence = (
  observed: Pick<TimelineEvent, 'kind' | 'target'>[],
  expected: ExpectedEvent[],
): Divergence | undefined => {
  let cursor = 0;
  for (const [index, step] of expected.entries()) {
    const found = observed.findIndex(
      (event, at) =>
        at >= cursor &&
        event.kind === step.kind &&
        event.target === step.target,
    );
    if (found === -1) return { atStep: index, expected: step };
    cursor = found + 1;
  }
  return undefined;
};

export const assessSequence = (
  observed: Pick<TimelineEvent, 'kind' | 'target'>[],
  expected: ExpectedEvent[],
): TakeCheck[] => {
  const divergence = firstDivergence(observed, expected);
  return [
    {
      label: divergence
        ? `walkthrough performed every step in order, missing step ${
            divergence.atStep + 1
          }: ${divergence.expected.kind} ${divergence.expected.target}`
        : 'walkthrough performed every step in order',
      didPass: divergence === undefined,
    },
  ];
};

const pressCounts = (
  events: Pick<TimelineEvent, 'kind' | 'target'>[],
): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const event of events)
    if (event.kind === 'click')
      counts.set(event.target, (counts.get(event.target) ?? 0) + 1);
  return counts;
};

/**
 * How many times the script could press each control, optional steps included.
 *
 * NOT the same as the expected transcript. That list deliberately omits
 * anything conditional, since requiring an optional step would fail an honest
 * take, but an ALLOWANCE has to count them: an app's optional prompt is
 * pressed for real whenever it does appear. Counting it as zero flagged two
 * legitimate prompts as phantom presses.
 *
 * Text entry allows NO press. Typing focuses its own field, so a press on a
 * field is a press nobody asked for, and leaving the old allowance in place
 * would have kept a slot open for exactly the stray click this checks for.
 */
export const allowedPresses = (steps: Step<string>[]): Map<string, number> => {
  const allowed = new Map<string, number>();
  const add = (target: string) =>
    allowed.set(target, (allowed.get(target) ?? 0) + 1);
  const walk = (within: Step<string>[]) => {
    for (const step of within) {
      if (step.do === 'click') add(step.target);
      if (step.do === 'ifPresent') walk(step.then);
    }
  };
  walk(steps);
  return allowed;
};

/**
 * Controls pressed more often than the script asked, and by how much.
 *
 * Compared against the script rather than judged by a rule, because a rule gets
 * this wrong in both directions. "No two presses in a row on one control" flags
 * the reveal toggle, which the walkthrough deliberately presses on and then
 * off. Counting against what was ASKED FOR has no such problem: two asked, two
 * drawn, fine.
 *
 * What this catches is the failure that shipped: one control drawn as pressed
 * twice where the script asked once. It is fed the PAGE's press log, one entry
 * per real pointerdown, because the timeline records one press per script step
 * and grading that against the script compares the script to itself.
 */
export const extraPresses = (
  observed: Pick<TimelineEvent, 'kind' | 'target'>[],
  allowance: Map<string, number>,
): { target: string; extra: number }[] => {
  const asked = allowance;
  return [...pressCounts(observed)]
    .map(([target, drawn]) => ({
      target,
      extra: drawn - (asked.get(target) ?? 0),
    }))
    .filter(({ extra }) => extra > 0);
};

/**
 * Every testID the script touches, including inside optional branches.
 *
 * Derived rather than listed. A hand-written copy of these ids drifted in both
 * directions: two entries no longer driven, and six awaitScreen targets never
 * pinned, which is exactly the rename this was written to catch.
 */
export const targetsOf = <Ref extends string>(steps: Step<Ref>[]): string[] => [
  ...new Set(
    steps.flatMap(step =>
      step.do === 'ifPresent'
        ? [step.target, ...targetsOf(step.then)]
        : step.do === 'capture'
          ? wordTargetsOf(step)
          : 'target' in step
            ? [step.target]
            : [],
    ),
  ),
];

export const assessPresses = (
  observed: Pick<TimelineEvent, 'kind' | 'target'>[],
  allowance: Map<string, number>,
): TakeCheck[] => {
  const extra = extraPresses(observed, allowance);
  return [
    {
      label:
        extra.length === 0
          ? 'every control was pressed as often as the script asked'
          : `a control was drawn as pressed more often than the script asked: ${extra
              .map(({ target, extra: by }) => `${target} (+${by})`)
              .join(', ')}`,
      didPass: extra.length === 0,
    },
  ];
};
