import { describe, expect, it } from 'vitest';

import { appendTake, spansOf, takeRecord } from './record';

import type { HostFacts } from './record';
import type { TimelineEvent } from './timeline';

const HOST: HostFacts = { load: [1.5, 2, 2.5], cpus: 10 };
const VIDEO = { width: 620, height: 760, durationSeconds: 118.5 };

const event = (partial: Partial<TimelineEvent>): TimelineEvent => ({
  at: 0,
  kind: 'ready',
  target: 'a-button',
  ...partial,
});

describe('spansOf', () => {
  it('keeps only the entries that took time', () => {
    // A click is an instant. Recording it as a zero would bury the handful of
    // durations that are actually worth comparing between two takes.
    expect(
      spansOf([
        event({ kind: 'click', target: 'a-button' }),
        event({ kind: 'enter', target: 'a-screen', durationMs: 11_100 }),
      ]),
    ).toEqual({ 'enter a-screen': 11_100 });
  });

  it('sums a target waited on more than once', () => {
    // The reveal toggle is pressed twice on purpose. Keeping only the last
    // would quietly halve it, and a halved number reads as an improvement.
    expect(
      spansOf([
        event({ kind: 'ready', target: 'a-toggle', durationMs: 300 }),
        event({ kind: 'ready', target: 'a-toggle', durationMs: 500 }),
      ]),
    ).toEqual({ 'ready a-toggle': 800 });
  });

  it('is empty when nothing was measured', () => {
    expect(spansOf([])).toEqual({});
  });
});

describe('takeRecord', () => {
  it('carries the host, so a slow take can be read against a busy machine', () => {
    // The whole reason this exists. One run's slow call took 11.1s and another
    // 39.1s on identical replayed traffic, and the difference was a load
    // average of 12. Without the host on the row, neither number means
    // anything later.
    const record = takeRecord({
      events: [event({ kind: 'enter', target: 'review', durationMs: 27_300 })],
      video: VIDEO,
      terminalState: 'done',
      failedChecks: [],
      host: HOST,
      runAtEpochMs: 1_700_000_000_000,
    });

    expect(record.host).toEqual(HOST);
    expect(record.spans).toEqual({ 'enter review': 27_300 });
    expect(record.runAtEpochMs).toBe(1_700_000_000_000);
  });

  it('records where the transcript ended, which is what sets the length', () => {
    const record = takeRecord({
      events: [event({ at: 0 }), event({ at: 118_000 })],
      video: VIDEO,
      terminalState: 'done',
      failedChecks: [],
      host: HOST,
      runAtEpochMs: 1,
    });

    expect(record.lastEventMs).toBe(118_000);
  });

  it('records a failed take too, since a bad take is worth comparing', () => {
    const record = takeRecord({
      events: [],
      video: VIDEO,
      terminalState: 'failed',
      failedChecks: ['frame is 620x760'],
      host: HOST,
      runAtEpochMs: 1,
    });

    expect(record.terminalState).toBe('failed');
    expect(record.failedChecks).toEqual(['frame is 620x760']);
    expect(record.lastEventMs).toBe(0);
  });
});

describe('appendTake', () => {
  it('appends one parseable line, rather than replacing the history', () => {
    // Appending is the point: the transcript beside the video is always the
    // CURRENT take, so a run's timings used to survive only in a terminal
    // scrollback and were gone by the time anyone wanted to compare them.
    const lines: [string, string][] = [];
    const record = takeRecord({
      events: [event({ kind: 'enter', target: 'review', durationMs: 27_300 })],
      video: VIDEO,
      terminalState: 'done',
      failedChecks: [],
      host: HOST,
      runAtEpochMs: 1,
    });

    appendTake('/tmp/takes.jsonl', record, (path, line) =>
      lines.push([path, line]),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toBe('/tmp/takes.jsonl');
    expect(lines[0][1].endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0][1])).toEqual(record);
  });
});
