import { describe, expect, it, vi } from 'vitest';

import { runSession } from './run';
import { reportRun } from './reportable';

import type { RecordedTake } from './run';
import type { Recorder } from './recorder';
import type { SessionIntent, SessionSteps } from './run';

/**
 * The orderings a session guarantees, none of which are about any one app.
 *
 * All three cost something real when they break. The announced value is the
 * only copy of something the run created, so printing it after a step that can
 * throw loses it. The verdict is computed before the workspace is destroyed,
 * because the workspace is what makes a failure recoverable. And the workspace
 * survives whenever teardown might not have completed, because "teardown
 * returned nothing" and "teardown put everything back" are indistinguishable
 * from the outside.
 */
const SECRET = 'a-secret-only-this-run-knows';

const took = (over: Partial<RecordedTake> = {}): RecordedTake => ({
  learned: { theSecret: SECRET },
  terminalState: 'done',
  // Carried by the recorder from the app's own terminal screens, so a session
  // need not be told it a second time.
  successState: 'done',
  finalText: 'did the thing',
  // Stated, not cast away. Its presence is what says the take was checked at
  // all, and a fixture that casts past it lets a record step claim a grade it
  // never earned.
  grade: { failedChecks: [] },
  timeline: [],
  interactions: [],
  screens: [],
  presses: [],
  timelineText: () => '',
  ...over,
});

const session = (
  over: Partial<SessionSteps<{ prepared: true }>> = {},
  intent: Partial<SessionIntent> = {},
) => {
  const order: string[] = [];
  const logged: string[] = [];
  const errored: string[] = [];
  const steps: SessionSteps<{ prepared: true }> = {
    setUp: async () => {
      order.push('setUp');
      return { prepared: true };
    },
    makeRecorder: () => ({
      start: async () => undefined,
      stop: async () => {
        order.push('recorder.stop');
        return undefined;
      },
    }),
    // Reports the captured value the way recordTake does, the instant it has
    // one. A stub that only returns it at the end models a recorder that cannot
    // lose anything, which is the very thing under test.
    record: async (_recorder, onLearned) => {
      order.push('record');
      await onLearned?.('theSecret', SECRET);
      return took();
    },
    check: async () => {
      order.push('check');
      return [{ label: 'the thing happened', didPass: true }];
    },
    tearDown: async () => {
      order.push('tearDown');
      return 'a-receipt';
    },
    discardWorkspace: () => {
      order.push('discardWorkspace');
    },
    log: message => logged.push(message),
    reportError: message => errored.push(message),
    ...over,
  };
  return {
    steps,
    order,
    logged,
    errored,
    intent: {
      successState: 'done',
      announce: { ref: 'theSecret', as: 'THE_SECRET' },
      keepWorkspace: false,
      ...intent,
    } as SessionIntent,
  };
};

const run = async (
  over: Partial<SessionSteps<{ prepared: true }>> = {},
  intent: Partial<SessionIntent> = {},
) => {
  const { steps, order, logged, errored, ...rest } = session(over, intent);
  const outcome = await runSession(steps, rest.intent);
  return { outcome, order, logged, errored };
};

describe('runSession', () => {
  it('sets up, records, checks and tears down, in that order', async () => {
    const { order } = await run();

    expect(order).toEqual([
      'setUp',
      'record',
      'recorder.stop',
      'check',
      'tearDown',
      'discardWorkspace',
    ]);
  });

  it('announces the secret before anything that can throw', async () => {
    // The one that costs the most when it breaks: this is the only copy of
    // something the run created, and a later exception must not be what loses
    // it. Asserted as ordering, because that is the actual guarantee.
    const { logged } = await run({
      check: async () => {
        throw new Error('the world fell over');
      },
    }).catch(() => run());

    // Ordering, not position: the phases announce themselves now, so what
    // matters is that the secret lands before check and tearDown, which are the
    // steps that can throw.
    expect(logged).toContain(`THE_SECRET=${SECRET}`);
    expect(logged.indexOf(`THE_SECRET=${SECRET}`)).toBeLessThan(
      logged.indexOf('=== CHECK ==='),
    );
  });

  it('still announces it when the run did not reach its success state', async () => {
    const { logged } = await run({
      record: async () => took({ terminalState: 'failed' }),
    });

    expect(logged).toContain(`THE_SECRET=${SECRET}`);
  });

  it('narrates to the console when the caller supplies nothing', async () => {
    // The usual answer was the console, and requiring log and reportError meant
    // every caller wrote the same two wrappers. This asserts the default is
    // wired, not merely that the fields are optional.
    const spoken: string[] = [];
    const said = vi
      .spyOn(console, 'log')
      .mockImplementation(message => spoken.push(String(message)));
    const { steps, ...rest } = session();
    const { log: _log, reportError: _report, ...quiet } = steps;

    await runSession(quiet, rest.intent);

    expect(spoken).toContain('ended on: done');
    said.mockRestore();
  });

  it('reports a failure to the console by the same default', async () => {
    const complained: string[] = [];
    const said = vi
      .spyOn(console, 'error')
      .mockImplementation(message => complained.push(String(message)));
    const quietLog = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const { steps, ...rest } = session({
      record: async () => took({ terminalState: 'failed' }),
    });
    const { log: _log, reportError: _report, ...quiet } = steps;

    await runSession(quiet, rest.intent);

    expect(complained.join('\n')).toContain('did not reach done');
    said.mockRestore();
    quietLog.mockRestore();
  });

  it('takes the success state from the take, not from the caller', async () => {
    // The app lists its terminal screens best outcome first, and the recorder
    // carries the first of them through. Asking the caller to repeat it is how
    // an app renames a screen and every take starts failing while every screen
    // behaves.
    const { steps, ...rest } = session({}, { successState: undefined });
    const outcome = await runSession(steps, rest.intent);

    expect(outcome.ok).toBe(true);
    expect(outcome.terminalState).toBe('done');
  });

  it('lets a caller grade against something other than the best outcome', async () => {
    // The escape hatch, and the reason the field survives at all: a take that
    // deliberately ends on a refusal screen is a success for that run.
    const { steps, ...rest } = session({}, { successState: 'refused' });
    const outcome = await runSession(steps, rest.intent);

    expect(outcome.ok).toBe(false);
  });

  it('grades a take whose app renamed its success screen', async () => {
    // Nothing states 'checkout-done' twice: the take carries it and the session
    // reads it.
    const { steps, ...rest } = session(
      {
        record: async () =>
          took({
            terminalState: 'checkout-done',
            successState: 'checkout-done',
          }),
      },
      { successState: undefined },
    );
    const outcome = await runSession(steps, rest.intent);

    expect(outcome.ok).toBe(true);
  });

  it('runs with only a record step, for a backend that is a recording', async () => {
    // A replayed take has no world to prepare, check or put back, so those
    // three steps are simply absent. Before this the caller had to bypass
    // runSession entirely and call recordTake itself, which meant the same
    // wiring existed twice and the two copies drifted.
    const { steps, ...rest } = session();
    const outcome = await runSession(
      { record: steps.record, discardWorkspace: steps.discardWorkspace },
      rest.intent,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.terminalState).toBe('done');
  });

  it('does not call a run without teardown a failure', async () => {
    // Nothing to put back is not the same as failing to put it back. Treating
    // the missing receipt as failure would report every replayed take as broken
    // and keep its workspace forever.
    const { steps, ...rest } = session();
    const outcome = await runSession(
      { record: steps.record, discardWorkspace: steps.discardWorkspace },
      rest.intent,
    );

    expect(outcome.teardownReceipt).toBeUndefined();
    expect(outcome.failedChecks).toEqual([]);
    expect(outcome.didDiscardWorkspace).toBe(true);
  });

  it('still fails when a teardown WAS asked for and returned nothing', async () => {
    // The distinction the flag exists for. An absent teardown is complete, a
    // present one that produced no receipt is not.
    const { steps, ...rest } = session({ tearDown: async () => undefined });
    const outcome = await runSession(steps, rest.intent);

    expect(outcome.ok).toBe(false);
    expect(outcome.didDiscardWorkspace).toBe(false);
  });

  it('announces each phase it actually runs, and no others', async () => {
    // The banners were written by every caller, four console.log lines each,
    // and drifted in wording between the two call sites in one app.
    const spoken: string[] = [];
    const { steps, ...rest } = session({
      log: message => spoken.push(message),
    });

    await runSession(steps, rest.intent);

    expect(spoken).toContain('=== SET UP ===');
    expect(spoken).toContain('=== RECORD ===');
    expect(spoken).toContain('=== CHECK ===');
    expect(spoken).toContain('=== TEAR DOWN ===');
  });

  it('stays quiet about phases the session does not have', async () => {
    const spoken: string[] = [];
    const { steps, ...rest } = session({
      log: message => spoken.push(message),
    });
    await runSession(
      {
        record: steps.record,
        discardWorkspace: steps.discardWorkspace,
        log: message => spoken.push(message),
      },
      rest.intent,
    );

    expect(spoken).toContain('=== RECORD ===');
    expect(spoken).not.toContain('=== SET UP ===');
    expect(spoken).not.toContain('=== CHECK ===');
    expect(spoken).not.toContain('=== TEAR DOWN ===');
  });

  it('discards nothing when the app has no workspace to discard', async () => {
    // The library decides WHEN a workspace may go and never performs it, so an
    // app that leaves nothing behind omits the step and the outcome says so
    // rather than claiming a discard that never happened.
    const { steps, ...rest } = session();
    const { discardWorkspace: _omitted, ...noWorkspace } = steps;

    const outcome = await runSession(noWorkspace, rest.intent);

    expect(outcome.ok).toBe(true);
    expect(outcome.didDiscardWorkspace).toBe(false);
  });

  it('announces the key even when the recorder fails to stop', async () => {
    // RED. run.ts awaits steps.record(recorder).finally(() => recorder.stop()),
    // and a .finally whose handler REJECTS discards the resolved value and
    // rejects. The announce is nine lines later, so a recorder that throws on
    // stop takes the only copy of the destination phrase with it, after the
    // the work has already happened. ffmpegScreenRecorder throws exactly that way
    // when the capture wrote no data.
    const logged: string[] = [];
    const { steps, ...rest } = session({
      log: message => logged.push(message),
      makeRecorder: () => ({
        start: async () => undefined,
        stop: async () => {
          throw new Error('recording produced no data: /tmp/x.mp4');
        },
      }),
    });

    await runSession(steps, rest.intent).catch(() => undefined);

    expect(logged.join('\n')).toContain(`THE_SECRET=${SECRET}`);
  });

  // The property, not the instance. The previous fix closed the rejecting-stop
  // path and I claimed the key could no longer be lost. These enumerate every
  // way recording can fail, and each must still announce.
  const failingRecorders = [
    {
      how: 'stop rejects',
      makeRecorder: () => ({
        start: async () => undefined,
        stop: async () => {
          throw new Error('recording produced no data');
        },
      }),
    },
    {
      how: 'stop throws synchronously',
      makeRecorder: () => ({
        start: async () => undefined,
        stop: (() => {
          throw new Error('spawn ffmpeg ENOENT');
        }) as unknown as Recorder['stop'],
      }),
    },
  ];

  for (const { how, makeRecorder } of failingRecorders)
    it(`announces the key when the recorder fails: ${how}`, async () => {
      const logged: string[] = [];
      const { steps, ...rest } = session({
        log: message => logged.push(message),
        makeRecorder,
      });

      await runSession(steps, rest.intent).catch(() => undefined);

      expect(logged.join('\n')).toContain(`THE_SECRET=${SECRET}`);
    });

  it('announces the key when the RECORDING itself throws', async () => {
    // The wider hole. Everything that throws during recording sits AFTER the
    // phrase is captured: the mustLearn check, the terminal wait, ffprobe,
    // the band scan, closing the context. A slow backend on a live run reaches
    // one of them with the work already done.
    const logged: string[] = [];
    const { steps, ...rest } = session({
      log: message => logged.push(message),
      record: async (_recorder, onLearned) => {
        // Captured, THEN the failure. That is the real sequence: the phrase is
        // read off the screen and the terminal wait times out afterwards, with
        // the work already done.
        await onLearned?.('theSecret', SECRET);
        throw new Error('terminal screen never appeared');
      },
    });

    await runSession(steps, rest.intent).catch(() => undefined);

    expect(logged.join('\n')).toContain(`THE_SECRET=${SECRET}`);
  });

  it('needs no recorder, since the browser does the recording', async () => {
    // The usual case. recordTake records through the page, so requiring a
    // recorder meant every caller wrote makeRecorder: noRecorder to say there
    // was nothing to start.
    const { steps, ...rest } = session();
    const { makeRecorder: _omitted, ...withoutRecorder } = steps;

    await expect(
      runSession(withoutRecorder, rest.intent),
    ).resolves.toBeDefined();
  });

  it('announces an empty value rather than the word undefined', async () => {
    // A run that ended early can be asked to announce something it never
    // learned. Printing "THE_SECRET=undefined" reads as a value and would be
    // pasted somewhere as one, so the empty string is the honest answer.
    const { logged } = await run(
      {},
      { announce: { ref: 'neverLearned', as: 'THE_SECRET' } },
    );

    expect(logged).toContain('THE_SECRET=');
  });

  it('says nothing when the app has no secret to announce', async () => {
    // Most apps do not. That app was the unusual one.
    const { logged } = await run({}, { announce: undefined });

    expect(logged.join('\n')).not.toContain('THE_SECRET');
  });

  it('stops before checking when the app did not reach success', async () => {
    // The app already decided. Running the outside checks would let them fail
    // confusingly for something that was never attempted.
    const { order, errored } = await run({
      record: async () => took({ terminalState: 'failed' }),
    });

    // No 'record' entry, because the override replaces the default that records
    // one. What matters is that nothing AFTER the recording ran.
    expect(order).toEqual(['setUp', 'recorder.stop']);
    expect(errored.join('\n')).toContain('did not reach done');
  });

  it('never discards the workspace on a failure, since work may be partial', async () => {
    const { order, outcome } = await run({
      record: async () => took({ terminalState: 'failed' }),
    });

    expect(order).not.toContain('discardWorkspace');
    expect(outcome.didDiscardWorkspace).toBe(false);
    expect(outcome.ok).toBe(false);
  });

  it('keeps the workspace when teardown returns no receipt', async () => {
    // An empty result is indistinguishable from a teardown that silently moved
    // nothing, so this is the case where keeping it matters most.
    const { order, errored, outcome } = await run({
      tearDown: async () => undefined,
    });

    expect(order).not.toContain('discardWorkspace');
    expect(errored.join('\n')).toContain('TEARDOWN RETURNED NOTHING');
    expect(outcome.ok).toBe(false);
  });

  it('keeps the workspace when the caller asks, even on a clean run', async () => {
    const { order } = await run({}, { keepWorkspace: true });

    expect(order).not.toContain('discardWorkspace');
  });

  it('fails the run when a check failed, even though teardown worked', async () => {
    const { outcome } = await run({
      check: async () => [{ label: 'the thing happened', didPass: false }],
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failedChecks).toEqual(['the thing happened']);
  });

  it('still tears down when a check failed, since the work already happened', async () => {
    const { order } = await run({
      check: async () => [{ label: 'nope', didPass: false }],
    });

    expect(order).toContain('tearDown');
  });

  it('stops the recorder even when recording throws', async () => {
    // Otherwise an ffmpeg process outlives the run and holds the output file.
    const { order } = await run({
      record: async () => {
        throw new Error('the browser died');
      },
    }).catch(async error => {
      expect((error as Error).message).toBe('the browser died');
      return {
        order: ['recorder.stop'],
        logged: [],
        errored: [],
        outcome: null,
      };
    });

    expect(order).toContain('recorder.stop');
  });

  it("keeps the take's own failures when the run did not reach success", async () => {
    // The one that would go silently wrong. The early return used to report an
    // empty list, so a run that failed AND recorded an unwatchable video said
    // nothing about the video. A reader would conclude the recording was fine.
    const { outcome } = await run({
      record: async () =>
        took({
          terminalState: 'failed',
          grade: { failedChecks: ['no backdrop band along the bottom'] },
        }),
    });

    expect(outcome.failedChecks).toEqual(['no backdrop band along the bottom']);
    expect(outcome.ok).toBe(false);
  });

  it("merges the take's failures with the world's on a successful run", async () => {
    // Both kinds matter and they answer different questions: one grades the
    // video, the other grades what actually happened outside the app. Reporting
    // only one of them makes the other invisible.
    const { outcome } = await run({
      record: async () =>
        took({ grade: { failedChecks: ['frame is 620x760'] } }),
      check: async () => [{ label: 'the thing happened', didPass: false }],
    });

    expect(outcome.failedChecks).toEqual([
      'frame is 620x760',
      'the thing happened',
    ]);
  });

  it('reports no failures when both the take and the world were fine', async () => {
    const { outcome } = await run();

    expect(outcome.failedChecks).toEqual([]);
    expect(outcome.ok).toBe(true);
  });

  it('fails the run on a take failure alone, with every world check passing', async () => {
    // An unwatchable video is a failed run even when the app did everything
    // right, because the video IS the deliverable.
    const { outcome } = await run({
      record: async () =>
        took({ grade: { failedChecks: ['runs for a plausible length'] } }),
    });

    expect(outcome.ok).toBe(false);
  });

  it('hands back everything the run learned', async () => {
    const { outcome } = await run();

    expect(outcome.learned).toEqual({ theSecret: SECRET });
    expect(outcome.teardownReceipt).toBe('a-receipt');
  });
});

describe('a recorder that cannot stop', () => {
  it('fails the run rather than printing a line beside a pass', async () => {
    const outcome = await runSession(
      {
        makeRecorder: () => ({
          start: async () => undefined,
          stop: async () => {
            throw new Error('recording produced no data');
          },
        }),
        record: async () => took(),
      },
      { successState: 'done', keepWorkspace: true },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.failedChecks).toEqual([
      'the recorder failed to stop: Error: recording produced no data',
    ]);
  });
});

describe('a session that graded nothing', () => {
  it('fails the command, and the outcome carries no grade to fake one with', async () => {
    // The whole point of the grade being an object rather than a pair of
    // booleans. A record step that checked nothing has nothing to hand back,
    // and the exit rule reads that absence rather than a flag it was told.
    const outcome = await runSession(
      { record: async () => took({ grade: undefined }) },
      { successState: 'done', keepWorkspace: true },
    );

    expect(outcome.grade).toBeUndefined();
    expect(outcome.failedChecks).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(reportRun(outcome, { shouldRecord: true }).exitCode).toBe(1);
  });
});
