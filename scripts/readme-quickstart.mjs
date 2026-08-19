/**
 * Writes the README's quickstart out as a compilable file.
 *
 * So the front page is type-checked against the PACKAGED types rather than
 * proof-read. It stopped compiling once already, missing a field that had just
 * become required, and nothing noticed because no build read it.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [readmePath, outPath] = process.argv.slice(2);
const block = /```ts\n([\s\S]*?)```/.exec(readFileSync(readmePath, 'utf8'));
if (!block) throw new Error(`no ts block in ${readmePath}`);

const lines = block[1].split('\n');
const isImport = line => line.startsWith('import ');
writeFileSync(
  outPath,
  [
    ...lines.filter(isImport),
    '',
    'export const quickstart = async () => {',
    ...lines.filter(line => !isImport(line)),
    '};',
  ].join('\n'),
);
