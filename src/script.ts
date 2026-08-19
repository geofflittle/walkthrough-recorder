/**
 * A walkthrough, as data, for any app.
 *
 * Parameterised by the names an app gives the values its script refers to, so
 * each app declares its own vocabulary rather than borrowing another's.
 *
 * A parameter rather than widening to `string`, because widening would trade
 * every app's compile-time check for the runtime throw in `valueOf`. This way
 * each app declares its own union and still cannot typo a reference.
 */
/**
 * One thing the walkthrough does.
 *
 * The whole walkthrough is a list of these, and the driver interprets it. That
 * is the point: the walkthrough currently exists TWICE, once as imperative
 * calls in drive.ts and once as expected steps in sequence.ts, and two
 * hand-written copies of one thing can disagree in either direction. A step
 * added to the driver and not the script goes unchecked, and a step in the
 * script and not the driver fails for the wrong reason.
 *
 * With one list interpreted by one interpreter, "the run matches the script" is
 * true by construction rather than a check that happens to pass, and the
 * interpreter becomes the only path to the page, which is what makes recording
 * inseparable from acting.
 */
export type Step<Ref extends string> =
  /** Travel to a control, rest on it, press it. */
  | {
      do: 'click';
      target: string;
      /** A beat before the pointer sets off, for a screen worth reading first. */
      beforeMs?: number;
      /** How long the pointer rests on the control before pressing. */
      dwellMs?: number;
    }
  /** Click into a field, then enter it a character at a time. */
  | { do: 'type'; target: string; value: Ref }
  /** Click into a field, then put the whole value in at once, as a paste. */
  | { do: 'paste'; target: string; value: Ref }
  /** Wait for a screen, recording how long it took to arrive. */
  | { do: 'awaitScreen'; target: string; timeoutMs?: number }
  /** Scroll a below-the-fold control into view, deliberately and visibly. */
  | { do: 'scrollTo'; target: string }
  /** Hold still so a viewer can read. The note says what they are reading. */
  | { do: 'hold'; ms: number; note: string }
  /**
   * Read a value out of the page and bind it for later steps.
   *
   * The backup screen shows the phrase as 24 separately-addressed words, so
   * this reads `${template}` with the index substituted, in order, and joins
   * them. Expressed as a step rather than as driver code because it is the one
   * thing the walkthrough LEARNS, and leaving it outside the list would put a
   * page access back outside the interpreter.
   */
  | { do: 'capture'; as: Ref; wordTemplate: string; count: number }
  /**
   * A sub-sequence that runs only if a control appears.
   *
   * The wizard prompts for the password twice, and only one of those is
   * certain: importing the source has asked in every observed run, while
   * creating the destination usually does not, because the app lock is still
   * already unlocked. `required` distinguishes a prompt that is allowed to be
   * absent from one whose absence means the action is never confirmed.
   */
  | {
      do: 'ifPresent';
      target: string;
      required: boolean;
      then: Step<Ref>[];
      /**
       * How long to wait before calling it absent, in milliseconds.
       *
       * Defaulted, and the defaults are one app's stopwatch readings: a prompt
       * that mounts with its screen was already there 1.4s after the click. An
       * app whose optional step needs a round trip waits longer, and awaitScreen
       * already takes the same knob.
       */
      timeoutMs?: number;
    }
  /**
   * Put a value on the system clipboard.
   *
   * Part of the script rather than setup, because the long-value step's paste button
   * reads the real clipboard and clears it afterwards. Without this the button
   * pastes nothing and the walkthrough stalls on a screen that looks fine.
   */
  | { do: 'setClipboard'; value: Ref };

/**
 * The testIDs a `capture` step reads, one per word.
 *
 * Here rather than inside the performer because the driver's selector guard has
 * to know them too, and a second expansion of the same template is a second
 * place for the indexing to be wrong. `targetsOf` missed these entirely while
 * the performer built 24 of them per run.
 */
export const wordTargetsOf = (step: {
  wordTemplate: string;
  count: number;
}): string[] =>
  Array.from({ length: step.count }, (_unused, at) =>
    step.wordTemplate.replace('{index}', String(at + 1)),
  );
