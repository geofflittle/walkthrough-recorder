import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Running an external program, as a value rather than an import.
 *
 * ffmpeg and ffprobe are the harness's only dependency on the world outside
 * node, and they are why two of its modules could not be tested at all: the
 * logic that reads their output was welded to the call that produced it, so
 * exercising it meant having a video on disk and several seconds per case.
 *
 * Shared rather than one seam per caller, because the harness shells out from
 * two places already and every future measurement of a take is a third.
 */
export type Shell = (
  command: string,
  args: string[],
  options?: { maxBuffer?: number },
) => Promise<{ stdout: string }>;

export const realShell: Shell = async (command, args, options) => {
  try {
    // Narrowed to a string: execFile's type admits a Buffer, for the encoding
    // options this never passes.
    const { stdout } = await run(command, args, options);
    return { stdout: stdout.toString() };
  } catch (error) {
    throw new Error(missingProgramMessage(command, error) ?? String(error), {
      cause: error,
    });
  }
};

/**
 * The message for a program that is not installed, or undefined if that is not
 * what went wrong.
 *
 * Node reports a missing executable as `spawn ffprobe ENOENT`, which names
 * neither what needs installing nor why anything wanted it. That lands on
 * someone running the recorder for the first time, at the end of a walkthrough
 * that otherwise worked, so it is worth saying plainly.
 */
const missingProgramMessage = (
  command: string,
  error: unknown,
): string | undefined => {
  if ((error as { code?: string })?.code !== 'ENOENT') return undefined;
  return `${command} is not installed, or not on PATH. The recorder shells out to ffmpeg and ffprobe to measure a take and produce its mp4. Install them (\`brew install ffmpeg\`, \`apt-get install ffmpeg\`) and run again.`;
};
