jest.mock('@jupyterlab/apputils', () => ({
  Notification: { emit: jest.fn(), dismiss: jest.fn() }
}));

import { Notification } from '@jupyterlab/apputils';

import { Speaker } from '../speaker';

import { SPEAKER_PROCESSOR_NAME } from '../speaker-worklet';

/**
 * Playback lifecycle tests with minimal Web Audio + WebSocket fakes, as in
 * audio-capture.spec.ts. The fake context starts suspended and resumes only while
 * `allowed` is set, which stands in for the browser's autoplay policy.
 */

class FakeAudioContext {
  static last: FakeAudioContext;
  sampleRate: number;
  state = 'suspended';
  allowed = false;
  destination = {};
  onstatechange: (() => void) | null = null;
  audioWorklet = { addModule: jest.fn().mockResolvedValue(undefined) };
  resume = jest.fn(() => {
    if (this.allowed) {
      this.state = 'running';
      this.onstatechange?.();
    }
    return Promise.resolve();
  });
  constructor(opts: { sampleRate: number }) {
    this.sampleRate = opts.sampleRate;
    FakeAudioContext.last = this;
  }
}

class FakeWorkletNode {
  static last: FakeWorkletNode;
  port = { postMessage: jest.fn() };
  connect = jest.fn();
  constructor(
    public ctx: FakeAudioContext,
    public name: string,
    public options: { outputChannelCount: number[] }
  ) {
    FakeWorkletNode.last = this;
  }
}

class FakeWebSocket {
  static last: FakeWebSocket;
  static count = 0;
  url: string;
  binaryType = '';
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.last = this;
    FakeWebSocket.count++;
  }
  /** test helper: simulate the server accepting the connection */
  _open(): void {
    this.onopen?.({});
  }
  /** test helper: simulate a binary message from the server */
  _message(data: ArrayBuffer): void {
    this.onmessage?.({ data });
  }
  /** test helper: simulate the connection closing from the server side */
  _drop(code: number): void {
    this.onclose?.({ code });
  }
}

const SETTINGS = {
  wsUrl: 'ws://localhost/',
  baseUrl: 'http://localhost/',
  token: 'secret-token'
} as any;

beforeEach(() => {
  (navigator as any).mediaDevices = { getUserMedia: jest.fn() };
  (globalThis as any).AudioContext = FakeAudioContext as any;
  (globalThis as any).AudioWorkletNode = FakeWorkletNode as any;
  (globalThis as any).WebSocket = FakeWebSocket as any;
  (globalThis as any).URL.createObjectURL = jest.fn(() => 'blob:fake');
  (globalThis as any).URL.revokeObjectURL = jest.fn();
});

describe('Speaker', () => {
  it('plays a 48 kHz stereo worklet into the destination from the /speaker socket', async () => {
    await new Speaker(SETTINGS).start();
    const ctx = FakeAudioContext.last;
    const node = FakeWorkletNode.last;

    expect(ctx.sampleRate).toBe(48000);
    expect(node.name).toBe(SPEAKER_PROCESSOR_NAME);
    expect(node.options.outputChannelCount).toEqual([2]);
    expect(node.connect).toHaveBeenCalledWith(ctx.destination);
    expect(FakeWebSocket.last.url).toContain(
      'jupyterlab-audio-extension/speaker'
    );
    expect(FakeWebSocket.last.url).toContain('token=secret-token');
    expect(FakeWebSocket.last.binaryType).toBe('arraybuffer');
    expect((navigator as any).mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('resumes when audio arrives and posts the audio held meanwhile once it runs', async () => {
    await new Speaker(SETTINGS).start();
    const ctx = FakeAudioContext.last;
    const port = FakeWorkletNode.last.port;
    FakeWebSocket.last._open();
    const first = new ArrayBuffer(8);
    const second = new ArrayBuffer(8);

    FakeWebSocket.last._message(first);
    expect(ctx.resume).toHaveBeenCalledTimes(2); // at start, and on arrival
    FakeWebSocket.last._message(second);
    expect(port.postMessage).not.toHaveBeenCalled();

    // The browser grants the pending resume.
    ctx.state = 'running';
    ctx.onstatechange?.();
    expect(port.postMessage.mock.calls).toEqual([
      [first, [first]],
      [second, [second]]
    ]);
    const third = new ArrayBuffer(8);
    FakeWebSocket.last._message(third);
    expect(port.postMessage).toHaveBeenLastCalledWith(third, [third]);
  });

  it('drops audio held longer than 0.5 s, so a late resume plays no backlog', async () => {
    const clock = jest.spyOn(performance, 'now').mockReturnValue(1000);
    await new Speaker(SETTINGS).start();
    const ctx = FakeAudioContext.last;
    const port = FakeWorkletNode.last.port;
    FakeWebSocket.last._open();
    FakeWebSocket.last._message(new ArrayBuffer(8));
    clock.mockReturnValue(1400);
    const fresh = new ArrayBuffer(8);
    FakeWebSocket.last._message(fresh);

    clock.mockReturnValue(1501);
    ctx.allowed = true;
    document.dispatchEvent(new Event('keydown'));
    expect(port.postMessage.mock.calls).toEqual([[fresh, [fresh]]]);
    clock.mockRestore();
  });

  it('cues once when a suspended tab drops audio, and again after a later suspension', async () => {
    const clock = jest.spyOn(performance, 'now').mockReturnValue(1000);
    const emit = Notification.emit as jest.Mock;
    const dismiss = Notification.dismiss as jest.Mock;
    emit.mockClear().mockReturnValueOnce('cue-1').mockReturnValueOnce('cue-2');
    dismiss.mockClear();
    await new Speaker(SETTINGS).start();
    const ctx = FakeAudioContext.last;
    FakeWebSocket.last._open();
    FakeWebSocket.last._message(new ArrayBuffer(8));
    expect(emit).not.toHaveBeenCalled();

    clock.mockReturnValue(1600);
    FakeWebSocket.last._message(new ArrayBuffer(8)); // the first chunk is now dropped
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      'This tab is not playing audio: the browser blocks sound until you click or press a key in this tab.',
      'info',
      { autoClose: false }
    );

    clock.mockReturnValue(2300);
    FakeWebSocket.last._message(new ArrayBuffer(8));
    expect(emit).toHaveBeenCalledTimes(1); // one cue per suspension episode

    ctx.state = 'running';
    ctx.onstatechange?.();
    expect(dismiss).toHaveBeenCalledWith('cue-1'); // the cue goes with its cause
    ctx.state = 'suspended';
    clock.mockReturnValue(3000);
    FakeWebSocket.last._message(new ArrayBuffer(8));
    clock.mockReturnValue(3600);
    FakeWebSocket.last._message(new ArrayBuffer(8));
    expect(emit).toHaveBeenCalledTimes(2); // a new suspension cues again
    ctx.state = 'running';
    ctx.onstatechange?.();
    expect(dismiss).toHaveBeenCalledWith('cue-2');
    clock.mockRestore();
  });

  it('resumes on arrival at most once per 0.5 s while the browser refuses', async () => {
    const clock = jest.spyOn(performance, 'now').mockReturnValue(1000);
    await new Speaker(SETTINGS).start();
    const ctx = FakeAudioContext.last;
    FakeWebSocket.last._open();

    for (const now of [1000, 1250, 1500]) {
      clock.mockReturnValue(now);
      FakeWebSocket.last._message(new ArrayBuffer(8));
    }
    expect(ctx.resume).toHaveBeenCalledTimes(2); // at start, and at 1000
    clock.mockReturnValue(1501);
    FakeWebSocket.last._message(new ArrayBuffer(8));
    expect(ctx.resume).toHaveBeenCalledTimes(3);
    clock.mockRestore();
  });

  it('resumes on the next pointerdown or keydown, in the capture phase, until it runs', async () => {
    await new Speaker(SETTINGS).start();
    const ctx = FakeAudioContext.last;
    expect(ctx.resume).toHaveBeenCalledTimes(1); // at start, no gesture yet

    // A page handler that stops propagation does not hide the gesture.
    const target = document.body.appendChild(document.createElement('div'));
    target.addEventListener('pointerdown', ev => ev.stopPropagation());
    target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(ctx.resume).toHaveBeenCalledTimes(2);
    expect(ctx.state).toBe('suspended');

    ctx.allowed = true;
    document.dispatchEvent(new Event('keydown'));
    expect(ctx.state).toBe('running');

    document.dispatchEvent(new Event('pointerdown'));
    document.dispatchEvent(new Event('keydown'));
    expect(ctx.resume).toHaveBeenCalledTimes(3); // listeners removed once running
    target.remove();
  });

  it('reconnects with a backoff of 500 ms doubling to 10 s', async () => {
    jest.useFakeTimers();
    try {
      await new Speaker(SETTINGS).start();
      const expectReconnectAfter = (ms: number): void => {
        const before = FakeWebSocket.count;
        FakeWebSocket.last._drop(1006);
        jest.advanceTimersByTime(ms - 1);
        expect(FakeWebSocket.count).toBe(before);
        jest.advanceTimersByTime(1);
        expect(FakeWebSocket.count).toBe(before + 1);
      };

      FakeWebSocket.last._open();
      for (const ms of [500, 1000, 2000, 4000, 8000, 10000, 10000]) {
        expectReconnectAfter(ms);
      }
      FakeWebSocket.last._open(); // a successful connection resets the backoff
      expectReconnectAfter(500);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('retired file playback', () => {
  it('the speaker no longer exposes playFile or stopFiles', () => {
    const speaker = new Speaker(SETTINGS) as any;
    expect(speaker.playFile).toBeUndefined();
    expect(speaker.stopFiles).toBeUndefined();
  });
});
