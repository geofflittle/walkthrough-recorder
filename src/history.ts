import type { TakeRecord } from './record';

/**
 * The take history, parsed.
 *
 * Tolerant of a truncated last line, because the file is appended to by a run
 * that can be interrupted, and refusing to read the other forty takes because
 * the last one was cut off would make the history useless exactly when a run
 * has just crashed.
 */
export const readTakes = (text: string): TakeRecord[] => {
  const takes: TakeRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      takes.push(JSON.parse(line) as TakeRecord);
    } catch {
      continue;
    }
  }
  return takes;
};

const asSeconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * How a span changed across takes, worst regression first.
 *
 * Reported next to the host load rather than alone, because that is the whole
 * lesson of the numbers this was built for: the same slow call measured 11.1s
 * and 39.1s against byte-identical replayed traffic, and the second ran at a
 * load average of 12. A duration that grew on a busier machine is not evidence
 * of anything, and this puts both on the screen so nobody has to remember.
 */
export const compareTakes = (takes: TakeRecord[]): string => {
  const first = takes[0];
  const last = takes.at(-1);
  if (!first || !last || takes.length < 2) return 'need two takes to compare';

  const keys = [
    ...new Set([...Object.keys(first.spans), ...Object.keys(last.spans)]),
  ];
  const moved = keys
    .map(key => ({
      key,
      was: first.spans[key] ?? 0,
      now: last.spans[key] ?? 0,
    }))
    .map(row => ({ ...row, delta: row.now - row.was }))
    .filter(row => Math.abs(row.delta) >= 500)
    .sort((left, right) => right.delta - left.delta);

  const lines = [
    `${takes.length} takes, comparing the first and last of them`,
    `  length   ${first.video.durationSeconds.toFixed(
      1,
    )}s  to  ${last.video.durationSeconds.toFixed(1)}s`,
    `  load     ${first.host.load[0].toFixed(
      1,
    )}  to  ${last.host.load[0].toFixed(1)}   across ${last.host.cpus} cpus`,
    moved.length === 0
      ? '  no span moved by half a second or more'
      : '  spans that moved, slowest first:',
  ];
  for (const row of moved)
    lines.push(
      `    ${row.delta >= 0 ? '+' : ''}${asSeconds(row.delta)}  ${
        row.key
      }   (${asSeconds(row.was)} to ${asSeconds(row.now)})`,
    );
  return lines.join('\n');
};
