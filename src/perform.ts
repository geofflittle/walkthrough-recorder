import { makeActor } from './actor';

import type { Actor } from './actor';
import { wordTargetsOf } from './script';

import type { Step } from './script';
import type { Timeline } from './timeline';
import type { Interaction } from './timing';
import type { Page } from 'playwright';

/** Values a step can refer to, resolved as the run learns them. */
export type Bindings<Ref extends string = string> = Partial<
  Record<Ref, string>
>;

/**
 * Runs a walkthrough, and is the only thing that can.
 *
 * The walkthrough used to exist twice: as imperative calls in the driver, and
 * as a list of expected steps used to check them. Two hand-written copies of
 * one thing, free to disagree in either direction, so a step added to the
 * driver went unchecked and a step in the script failed for the wrong reason.
 * Now there is one list and this interprets it, which makes "the run matched
 * the script" true by construction rather than a check that happens to pass.
 *
 * It talks only to the Actor, never to the page, so every interaction is
 * recorded by construction too. That is what an earlier version got wrong when
 * it clicked into a field without logging it: the video showed two presses and
 * the transcript admitted one.
 */
/**
 * Told the instant a capture binds a value, before anything else can run.
 *
 * The seam exists because a captured value can be irreplaceable, and the
 * alternative is carrying it through every throw site between here and whoever
 * needs it. This makes the window zero rather than defended.
 */
export type OnLearned = (ref: string, value: string) => void | Promise<void>;

export const performWalkthrough = async <Ref extends string>(
  actor: Actor,
  steps: Step<Ref>[],
  bindings: Bindings<Ref>,
  onLearned?: OnLearned,
): Promise<Bindings<Ref>> => {
  const known: Bindings<Ref> = { ...bindings };

  const valueOf = (ref: Ref): string => {
    const value = known[ref];
    // Loud, because the alternative is typing the word "undefined" into a
    // password field and discovering it four screens later.
    if (value === undefined)
      throw new Error(`the walkthrough referred to ${ref} before it was known`);
    return value;
  };

  for (const step of steps) {
    switch (step.do) {
      case 'click': {
        await actor.click(await actor.awaitReady(step.target), {
          beforeMs: step.beforeMs,
          dwellMs: step.dwellMs,
        });
        break;
      }
      case 'type': {
        await actor.type(
          await actor.awaitReady(step.target),
          valueOf(step.value),
        );
        break;
      }
      case 'paste': {
        await actor.fill(
          await actor.awaitReady(step.target),
          valueOf(step.value),
        );
        break;
      }
      case 'awaitScreen': {
        await actor.awaitScreen(step.target, step.timeoutMs);
        break;
      }
      case 'scrollTo': {
        await actor.revealBottom(await actor.awaitReady(step.target));
        break;
      }
      case 'hold': {
        await actor.linger(step.ms, step.note);
        break;
      }
      case 'capture': {
        const words: string[] = [];
        for (const target of wordTargetsOf(step)) {
          words.push((await actor.textOf(target)).trim());
        }
        const learnedNow = words.join(' ');
        known[step.as] = learnedNow;
        // Handed over the INSTANT it exists, because this may be the only copy
        // and everything downstream can throw: the mustLearn check, the
        // terminal wait, ffprobe, closing the context. Announcing here means
        // there is no window to defend.
        await onLearned?.(step.as, learnedNow);
        break;
      }
      case 'setClipboard': {
        await actor.setClipboard(valueOf(step.value));
        break;
      }
      case 'ifPresent': {
        // Waiting rather than counting: a sheet that mounts late reads as
        // absent to an instantaneous check, and the two failures need telling
        // apart. Where the step cannot proceed without it, absence is an error
        // rather than a branch not taken.
        const present = await actor.appears(step.target, {
          timeout:
            step.timeoutMs ??
            (step.required ? REQUIRED_TIMEOUT_MS : ABSENT_TIMEOUT_MS),
          required: step.required,
        });
        // Merged back rather than discarded: a sub-sequence that captures
        // something would otherwise learn it and throw it away, and the failure
        // would surface much later as a value the run "referred to before it
        // was known".
        if (present)
          Object.assign(
            known,
            await performWalkthrough(actor, step.then, known, onLearned),
          );
        break;
      }
    }
  }

  return known;
};

/**
 * How long a control that MUST appear gets. Generous, because it is only ever
 * paid when something is wrong, and the alternative is failing a good take.
 */
const REQUIRED_TIMEOUT_MS = 20_000;

/**
 * How long a control that may legitimately be absent gets.
 *
 * Short, because this one is paid on EVERY run where the branch is not taken,
 * and it is paid as a frozen screen in the video. The two prompts guarded this
 * way are usually absent, so the old shared 20s was charged almost every take:
 * measured on one, a waitForSelector for the password prompt started the
 * instant its screen finished painting and burned the full twenty seconds,
 * which is twenty seconds of a still frame two thirds of the way through.
 *
 * 2.5s is generous against what it is actually waiting for. The prompt mounts
 * with the screen behind it, not after work: on the run where it DID appear it
 * was already there 1.4 seconds after the click, before anything even asked.
 */
const ABSENT_TIMEOUT_MS = 2500;

/**
 * Everything a driver may do to the page, which is deliberately not much.
 *
 * `perform` runs steps. `hold` waits, which touches nothing. `interactions`
 * reports what happened. There is no click, no type, no locator and no page,
 * so a driver cannot interact except by writing a Step, and a Step cannot skip
 * the wait that proves its target is there.
 *
 * The Actor lives inside here rather than being handed out. Holding one was
 * how an interaction once happened without being recorded, and how the
 * walkthrough could in principle have been written imperatively again.
 */
export type Performer<Ref extends string = string> = {
  perform: (
    steps: Step<Ref>[],
    bindings: Bindings<Ref>,
    onLearned?: OnLearned,
  ) => Promise<Bindings<Ref>>;
  /** Rest on the current screen. Touches nothing, so it is safe to expose. */
  hold: (ms: number, note: string) => Promise<void>;
  /** Each interaction's ready and click moments, for grading their ordering. */
  interactions: () => Interaction[];
};

export const performerFor = <Ref extends string>({
  page,
  timeline,
  dwellMs,
}: {
  page: Page;
  timeline: Timeline;
  dwellMs?: number;
}): Performer<Ref> => {
  const actor = makeActor({ page, timeline, dwellMs });
  return {
    perform: async (steps, bindings, onLearned) =>
      performWalkthrough(actor, steps, bindings, onLearned),
    hold: async (ms, note) => actor.linger(ms, note),
    interactions: () => actor.interactions(),
  };
};
