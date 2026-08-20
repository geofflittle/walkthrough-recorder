#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { compareTakes, readTakes } from '../history';

/**
 * Compares the last two takes of one run, or the last N.
 *
 * `walkthrough-takes <video.mp4 | history.takes.jsonl> [count]`
 *
 * Takes the video path for convenience, since the history the recorder writes
 * sits beside it under the same name. Answers "is this take slower than the
 * last one, and was the machine busier" without another run.
 */
const main = () => {
  const [given, count] = process.argv.slice(2);
  if (!given) {
    console.error('usage: walkthrough-takes <video.mp4> [count]');
    process.exitCode = 1;
    return;
  }

  const path = given.replace(/\.mp4$/, '.takes.jsonl');
  const takes = readTakes(readFileSync(path, 'utf8')).slice(
    -Number(count ?? 2),
  );
  if (takes.length < 2) {
    console.log(`${takes.length} take(s) in ${path}, need two to compare`);
    return;
  }
  console.log(compareTakes(takes));
};

main();
