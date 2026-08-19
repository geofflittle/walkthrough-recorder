import { describe, expect, it } from 'vitest';

import {
  ffmpegScreenRecorder,
  noRecorder,
  parseScreenCaptureDevice,
} from './recorder';

import type { SpawnLike } from './recorder';

// Real output from `ffmpeg -f avfoundation -list_devices true -i ""`.
const LISTING = `[AVFoundation indev @ 0x12a705e90] AVFoundation video devices:
[AVFoundation indev @ 0x12a705e90] [0] MacBook Air Camera
[AVFoundation indev @ 0x12a705e90] [1] MacBook Air Desk View Camera
[AVFoundation indev @ 0x12a705e90] [2] Capture screen 0
[AVFoundation indev @ 0x12a705e90] AVFoundation audio devices:
[AVFoundation indev @ 0x12a705e90] [0] MacBook Air Microphone`;

describe('parseScreenCaptureDevice', () => {
  it('finds the screen index among the cameras', () => {
    expect(parseScreenCaptureDevice(LISTING)).toBe('2');
  });

  it('does not settle for a camera when no screen is listed', () => {
    // The failure this guards is silent: a wrong index still records a valid,
    // playable file, just of the wrong thing.
    expect(() =>
      parseScreenCaptureDevice(
        LISTING.split('\n')
          .filter(line => !line.includes('Capture screen'))
          .join('\n'),
      ),
    ).toThrow(/Capture screen/);
  });

  it('follows the index when the device order changes', () => {
    expect(
      parseScreenCaptureDevice(
        LISTING.replace('[2] Capture screen', '[5] Capture screen'),
      ),
    ).toBe('5');
  });
});

/** A child process that records what was written to it, without spawning one. */
const fakeChild = ({ exitCode = null }: { exitCode?: number | null } = {}) => {
  const written: string[] = [];
  const listeners = new Map<string, () => void>();
  return {
    written,
    listeners,
    process: {
      exitCode,
      stdin: { write: (chunk: string) => written.push(chunk) },
      on: (event: string, handler: () => void) => {
        listeners.set(event, handler);
      },
    } as unknown as ReturnType<SpawnLike>,
  };
};

const recorderWith = (
  child: ReturnType<typeof fakeChild>,
  { size = 1024 }: { size?: number } = {},
) => {
  const calls: { command: string; args: string[] }[] = [];
  const recorder = ffmpegScreenRecorder({
    outputPath: '/tmp/take.mp4',
    device: '2',
    deps: {
      spawnProcess: (command, args) => {
        calls.push({ command, args });
        return child.process;
      },
      sizeOf: () => size,
      startupMs: 0,
      shutdownMs: 0,
    },
  });
  return { recorder, calls };
};

describe('ffmpegScreenRecorder', () => {
  it('stops by asking ffmpeg to quit, never by signalling it', async () => {
    // A killed ffmpeg never writes the moov atom, so the mp4 is unplayable.
    const child = fakeChild();
    const { recorder } = recorderWith(child);

    await recorder.start();
    await recorder.stop();

    expect(child.written).toEqual(['q']);
  });

  it('throws when ffmpeg exits during startup', async () => {
    const { recorder } = recorderWith(fakeChild({ exitCode: 1 }));

    await expect(recorder.start()).rejects.toThrow('exited immediately');
  });

  it('throws when the recording produced no data', async () => {
    // The one thing that proves a capture worked, since stderr goes to the
    // terminal rather than anywhere this can inspect.
    const { recorder } = recorderWith(fakeChild(), { size: 0 });

    await recorder.start();
    await expect(recorder.stop()).rejects.toThrow('produced no data');
  });

  it('returns the path when the file has content', async () => {
    const { recorder } = recorderWith(fakeChild());

    await recorder.start();

    await expect(recorder.stop()).resolves.toBe('/tmp/take.mp4');
  });

  it('is a no-op when stopped without starting', async () => {
    const { recorder } = recorderWith(fakeChild());

    await expect(recorder.stop()).resolves.toBeUndefined();
  });

  it('listens for spawn errors, so a missing ffmpeg is not an uncaught event', async () => {
    const child = fakeChild();
    const { recorder } = recorderWith(child);

    await recorder.start();

    expect(child.listeners.has('error')).toBe(true);
  });

  it('passes the resolved device to ffmpeg', async () => {
    const child = fakeChild();
    const { recorder, calls } = recorderWith(child);

    await recorder.start();

    expect(calls[0].command).toBe('ffmpeg');
    expect(calls[0].args).toContain('2');
  });
});

describe('noRecorder', () => {
  it('reports no artifact, so RECORD=0 cannot look like a successful capture', async () => {
    await expect(noRecorder().stop()).resolves.toBeUndefined();
  });
});
