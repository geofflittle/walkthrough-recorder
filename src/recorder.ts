import { execSync, spawn } from 'node:child_process';
import { statSync } from 'node:fs';

import type { ChildProcess } from 'node:child_process';

export type Recorder = {
  start: () => Promise<void>;
  stop: () => Promise<string | undefined>;
};

/** Used when a run only needs the outcome, not a video. */
export const noRecorder = (): Recorder => ({
  start: async () => undefined,
  stop: async () => undefined,
});

/**
 * The avfoundation index of the screen capture device.
 *
 * Resolved, never hardcoded: macOS renumbers these when displays or cameras
 * change, and a stale index yields a perfectly valid, playable recording of the
 * WRONG screen, which no output check can detect.
 */
export const findScreenCaptureDevice = (): string => {
  // ffmpeg writes the device list to stderr and exits non-zero by design here,
  // since no input was given.
  let listing = '';
  try {
    execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1', {
      stdio: 'pipe',
    });
  } catch (error) {
    listing = String((error as { stdout?: Buffer }).stdout ?? '');
  }
  return parseScreenCaptureDevice(listing);
};

/** Split out from the spawn so the parse can be pinned without running ffmpeg. */
export const parseScreenCaptureDevice = (listing: string): string => {
  const match = /\[(\d+)\]\s+Capture screen/i.exec(listing);
  if (!match)
    throw new Error(
      'no avfoundation "Capture screen" device. Grant the terminal macOS Screen Recording permission and restart it.',
    );
  return match[1];
};

/** The slice of child_process this uses, so a test can supply a fake one. */
export type SpawnLike = (
  command: string,
  args: string[],
  options: { stdio: ['pipe', 'ignore', 'inherit'] },
) => ChildProcess;

/** The slice of fs this uses, for the same reason. */
export type SizeOf = (path: string) => number;

export type RecorderDeps = {
  spawnProcess?: SpawnLike;
  sizeOf?: SizeOf;
  /** Time allowed for ffmpeg to open the device before its exit code is read. */
  startupMs?: number;
  /** Time allowed for ffmpeg to finish writing after being asked to quit. */
  shutdownMs?: number;
};

/**
 * Captures the whole screen with ffmpeg's avfoundation input.
 *
 * macOS gates this behind the Screen Recording permission, granted to the
 * TERMINAL running the harness rather than to ffmpeg, and the grant only takes
 * effect after that terminal restarts. Without it, capture fails immediately
 * with `Input/output error` rather than producing a short or empty file, so a
 * failure here is a permissions problem until proven otherwise.
 */
export const ffmpegScreenRecorder = ({
  outputPath,
  device,
  framerate = 30,
  deps = {},
}: {
  outputPath: string;
  /** Defaults to the resolved "Capture screen" index. */
  device?: string;
  framerate?: number;
  /**
   * What the recorder is WIRED TO, kept apart from what it is configured with.
   * Injected because the lifecycle is otherwise unreachable without ffmpeg, a
   * screen, and a macOS permission, and the failure it guards is a run that
   * reports success with no usable video.
   */
  deps?: RecorderDeps;
}): Recorder => {
  const {
    spawnProcess = spawn as SpawnLike,
    sizeOf = path => statSync(path, { throwIfNoEntry: false })?.size ?? 0,
    startupMs = 3000,
    shutdownMs = 10_000,
  } = deps;
  let child: ChildProcess | undefined;

  return {
    start: async () => {
      const input = device ?? findScreenCaptureDevice();
      const started = spawnProcess(
        'ffmpeg',
        [
          '-y',
          '-f',
          'avfoundation',
          '-framerate',
          `${framerate}`,
          '-i',
          input,
          '-pix_fmt',
          'yuv420p',
          outputPath,
        ],
        // stderr kept: ffmpeg reports every diagnostic there, and discarding
        // it is why a failed capture used to look like a successful one.
        { stdio: ['pipe', 'ignore', 'inherit'] },
      );
      // Without a listener, a spawn failure (ffmpeg not installed) is an
      // uncaught 'error' event that kills the process mid-run.
      started.on('error', error => {
        console.error(`  recorder failed to start: ${String(error)}`);
      });
      child = started;
      // ffmpeg needs a moment to open the device, and frames captured before it
      // is ready are simply lost, which would clip the start of the walkthrough.
      //
      // A real sleep, and the one place the fence below is wrong to fire. It is
      // not standing in for a condition that could be observed: ffmpeg reports
      // no readiness on any channel this holds, so there is nothing to wait
      // for. Nothing is asserted after it either, so a slow machine costs the
      // first frames of a take rather than a false failure.
      // eslint-disable-next-line no-restricted-syntax
      await new Promise(resolve => setTimeout(resolve, startupMs));
      if (started.exitCode !== null)
        throw new Error(`ffmpeg exited immediately (code ${started.exitCode})`);
    },
    stop: async () => {
      if (!child) return undefined;
      // 'q' on stdin, not SIGKILL: ffmpeg must write the moov atom or the file
      // is unplayable.
      child.stdin?.write('q');
      await new Promise(resolve => {
        child?.on('exit', resolve);
        setTimeout(resolve, shutdownMs);
      });
      child = undefined;
      // ffmpeg reports on stderr, which is discarded, so the only evidence the
      // capture worked is the file. A zero-byte or missing output means a bad
      // device index, a denied permission, or a kill before the moov atom.
      const size = sizeOf(outputPath);
      if (size === 0)
        throw new Error(`recording produced no data: ${outputPath}`);
      return outputPath;
    },
  };
};
