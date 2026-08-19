import { describe, expect, it } from 'vitest';

import { compareTakes, readTakes } from './history';

import type { TakeRecord } from './record';

const take = (partial: Partial<TakeRecord> = {}): TakeRecord => ({
  runAtEpochMs: 1,
  host: { load: [2, 2, 2], cpus: 10 },
  video: { width: 620, height: 760, durationSeconds: 118.5 },
  terminalState: 'done',
  failedChecks: [],
  spans: {},
  lastEventMs: 118_000,
  ...partial,
});

describe('readTakes', () => {
  it('reads a line per take', () => {
    const text = `${JSON.stringify(take())}\n${JSON.stringify(
      take({ runAtEpochMs: 2 }),
    )}\n`;

    expect(readTakes(text).map(row => row.runAtEpochMs)).toEqual([1, 2]);
  });

  it('keeps the takes before a truncated last line', () => {
    // The file is appended to by a run that can be killed partway. Refusing the
    // whole history because the newest line was cut off would lose it exactly
    // when a run has just crashed and the earlier takes are what you want.
    const text = `${JSON.stringify(take())}\n{"runAtEpochMs":2,"host":`;

    expect(readTakes(text)).toHaveLength(1);
  });

  it('ignores blank lines', () => {
    expect(readTakes(`\n${JSON.stringify(take())}\n\n`)).toHaveLength(1);
  });

  it('reads an empty history as no takes', () => {
    expect(readTakes('')).toEqual([]);
  });
});

describe('compareTakes', () => {
  it('reports a span that grew, with the host load beside it', () => {
    // The reason this exists: the same scan measured 11.1s and 27.3s against
    // identical replayed traffic, and the load average moved with it. Showing
    // the duration without the load is what made the earlier numbers
    // unreadable.
    const report = compareTakes([
      take({
        spans: { 'enter review': 11_100 },
        host: { load: [2, 2, 2], cpus: 10 },
      }),
      take({
        spans: { 'enter review': 27_300 },
        host: { load: [12.7, 11, 9], cpus: 10 },
      }),
    ]);

    expect(report).toContain('+16.2s  enter review');
    expect(report).toContain('2.0  to  12.7');
  });

  it('sorts the worst regression first', () => {
    const report = compareTakes([
      take({ spans: { small: 1000, large: 1000 } }),
      take({ spans: { small: 3000, large: 20_000 } }),
    ]);
    const lines = report.split('\n').filter(line => line.includes('  ('));

    expect(lines[0]).toContain('large');
    expect(lines[1]).toContain('small');
  });

  it('ignores movement under half a second, which is noise', () => {
    const report = compareTakes([
      take({ spans: { 'ready a-button': 200 } }),
      take({ spans: { 'ready a-button': 400 } }),
    ]);

    expect(report).toContain('no span moved');
  });

  it('handles a span that only one of the takes has', () => {
    // A step added or removed between takes. Treating the missing side as zero
    // is right: it did not happen, and reporting nothing would hide a step that
    // appeared and cost ten seconds.
    const report = compareTakes([
      take({ spans: {} }),
      take({ spans: { 'enter a-new-screen': 9000 } }),
    ]);

    expect(report).toContain('+9.0s  enter a-new-screen');
  });

  it('reports a span that vanished as the whole of its old cost', () => {
    // The mirror of the added step. A step that stopped happening is a change
    // worth seeing, and treating its missing side as zero is what makes the
    // two directions read the same way.
    expect(
      compareTakes([
        take({ spans: { 'hold reading the phrase': 7000 } }),
        take({ spans: {} }),
      ]),
    ).toContain('-7.0s  hold reading the phrase');
  });

  it('signs a span that got faster, so the direction is readable at a glance', () => {
    // Without the sign, a regression and an improvement are the same string,
    // and the report exists precisely to tell them apart.
    const report = compareTakes([
      take({ spans: { 'enter a-screen': 9000 } }),
      take({ spans: { 'enter a-screen': 3000 } }),
    ]);

    expect(report).toContain('-6.0s  enter a-screen');
    expect(report).not.toContain('+6.0s');
  });

  it('says so rather than guessing when there is only one take', () => {
    expect(compareTakes([take()])).toBe('need two takes to compare');
  });
});
