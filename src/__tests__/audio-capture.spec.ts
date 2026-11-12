import plugin from '../index';

import { AudioCapture } from '../audio-capture';

// The plugin's commands without the speaker, the status widget and the modules Jest cannot
// load, which the plugin imports only for their tokens.
jest.mock('@jupyterlab/apputils', () => ({}));
jest.mock('@jupyterlab/statusbar', () => ({}));
jest.mock('../speaker', () => ({
  Speaker: class {
    async start(): Promise<void> {}
  }
}));
jest.mock('../status', () => ({
  VoiceStatus: class {
    constructor(readonly model: AudioCapture) {}
  }
}));

/**
 * Browser-side lifecycle tests. The Web Audio + WebSocket APIs are not implemented by
 * jsdom, so we install minimal fakes that let us drive the state machine deterministically
 * and assert that frames pushed from the (faked) AudioWorklet are forwarded over the
 * websocket - the browser end of the "push dummy data and the other end receives it" path.
 */

class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeStream {
  tracks = [new FakeTrack()];
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

class FakePort {
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
}

class FakeWorkletNode {
  static last: FakeWorkletNode;
  port = new FakePort();
  constructor() {
    FakeWorkletNode.last = this;
  }
  connect(): void {}
  disconnect(): void {}
}

class FakeSourceNode {
  connect(): void {}
  disconnect(): void {}
}

class FakeAudioContext {
  static last: FakeAudioContext;
  sampleRate: number;
  audioWorklet = { addModule: jest.fn().mockResolvedValue(undefined) };
  close = jest.fn().mockResolvedValue(undefined);
  constructor(opts: { sampleRate: number }) {
    this.sampleRate = opts.sampleRate;
    FakeAudioContext.last = this;
  }
  createMediaStreamSource(): FakeSourceNode {
    return new FakeSourceNode();
  }
}

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static last: FakeWebSocket;
  url: string;
  binaryType = '';
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  sent: ArrayBuffer[] = [];
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.last = this;
  }
  send(data: ArrayBuffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({});
  }
  /** test helper: simulate the server accepting the connection */
  _open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }
  /** test helper: simulate the connection closing from the server side */
  _drop(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

/** jsdom has no BroadcastChannel: delivers to every other open channel of the same name. */
class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly name: string) {
    FakeBroadcastChannel.instances.push(this);
  }
  postMessage(data: unknown): void {
    for (const other of FakeBroadcastChannel.instances) {
      if (other !== this && other.name === this.name) {
        queueMicrotask(() => other.onmessage?.({ data }));
      }
    }
  }
}

const SETTINGS = {
  wsUrl: 'ws://localhost/',
  baseUrl: 'http://localhost/',
  token: 'secret-token'
} as any;

let stream: FakeStream;

beforeEach(() => {
  (window as any).isSecureContext = true;
  stream = new FakeStream();
  (navigator as any).mediaDevices = {
    getUserMedia: jest.fn().mockResolvedValue(stream)
  };
  (globalThis as any).AudioContext = FakeAudioContext as any;
  (globalThis as any).AudioWorkletNode = FakeWorkletNode as any;
  (globalThis as any).WebSocket = FakeWebSocket as any;
  FakeBroadcastChannel.instances = [];
  (globalThis as any).BroadcastChannel = FakeBroadcastChannel as any;
  (globalThis as any).URL.createObjectURL = jest.fn(() => 'blob:fake');
  (globalThis as any).URL.revokeObjectURL = jest.fn();
});

describe('AudioCapture', () => {
  it('captures at 16 kHz, connects with the token, and reaches Connected', async () => {
    const vc = new AudioCapture(SETTINGS);
    await vc.enable();

    expect((navigator as any).mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: true
    });
    expect(FakeAudioContext.last.sampleRate).toBe(16000); // B1
    expect(FakeWebSocket.last.url).toContain(
      'jupyterlab-audio-extension/stream'
    );
    expect(FakeWebSocket.last.url).toContain('token=secret-token'); // C1
    expect(FakeWebSocket.last.binaryType).toBe('arraybuffer'); // B4
    expect(vc.state).toBe('connecting');

    FakeWebSocket.last._open();
    expect(vc.state).toBe('streaming');

    vc.dispose();
  });

  it('forwards a frame pushed by the worklet to the websocket', async () => {
    const vc = new AudioCapture(SETTINGS);
    await vc.enable();
    FakeWebSocket.last._open();

    // the browser end "pushes dummy data": the worklet posts a PCM frame...
    const frame = new Int16Array([0, 1, -1, 32767, -32768]).buffer;
    FakeWorkletNode.last.port.onmessage!({ data: frame });

    // ...and the websocket (the receiving end of the browser half) gets it verbatim
    expect(FakeWebSocket.last.sent).toHaveLength(1);
    expect(FakeWebSocket.last.sent[0]).toBe(frame);

    vc.dispose();
  });

  it('does not send frames before the socket is open', async () => {
    const vc = new AudioCapture(SETTINGS);
    await vc.enable(); // connecting, not open yet
    FakeWorkletNode.last.port.onmessage!({ data: new ArrayBuffer(8) });
    expect(FakeWebSocket.last.sent).toHaveLength(0);
    vc.dispose();
  });

  it('releases the mic and closes the socket on disable (A3/D2)', async () => {
    const vc = new AudioCapture(SETTINGS);
    await vc.enable();
    FakeWebSocket.last._open();

    vc.disable();

    expect(stream.getTracks()[0].stopped).toBe(true);
    expect(FakeAudioContext.last.close).toHaveBeenCalled();
    expect(FakeWebSocket.last.readyState).toBe(FakeWebSocket.CLOSED);
    expect(vc.state).toBe('idle');
    expect(vc.enabled).toBe(false);

    vc.dispose();
  });

  it('maps a denied permission to a terminal error, capture off (E1)', async () => {
    const denied = Object.assign(new Error('denied'), {
      name: 'NotAllowedError'
    });
    (navigator as any).mediaDevices.getUserMedia = jest
      .fn()
      .mockRejectedValue(denied);

    const vc = new AudioCapture(SETTINGS);
    await vc.enable();

    expect(vc.state).toBe('error');
    expect(vc.enabled).toBe(false);

    vc.dispose();
  });

  it('refuses to capture outside a secure context (E3)', async () => {
    (window as any).isSecureContext = false;
    const vc = new AudioCapture(SETTINGS);
    await vc.enable();

    expect(vc.state).toBe('error');
    expect((navigator as any).mediaDevices.getUserMedia).not.toHaveBeenCalled();

    vc.dispose();
  });

  it('captures nothing until it is turned on (A1)', () => {
    const vc = new AudioCapture(SETTINGS);
    expect((navigator as any).mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(vc.state).toBe('idle');

    vc.toggle();

    expect((navigator as any).mediaDevices.getUserMedia).toHaveBeenCalledTimes(
      1
    );
    vc.dispose();
  });

  it('a second click during the permission prompt releases the late stream', async () => {
    let grant: (s: FakeStream) => void = () => undefined;
    (navigator as any).mediaDevices.getUserMedia = jest.fn(
      () => new Promise(resolve => (grant = resolve))
    );
    (FakeWebSocket as any).last = undefined;
    const vc = new AudioCapture(SETTINGS);

    vc.toggle(); // enable: waiting on the permission prompt
    vc.toggle(); // disable before the prompt resolves
    grant(stream);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(vc.state).toBe('idle');
    expect(vc.enabled).toBe(false);
    expect(stream.getTracks()[0].stopped).toBe(true);
    expect(FakeWebSocket.last).toBeUndefined();
    vc.dispose();
  });

  it('schedules nothing while idle (D4)', async () => {
    jest.useFakeTimers();
    try {
      const vc = new AudioCapture(SETTINGS);
      expect(jest.getTimerCount()).toBe(0);

      await vc.enable();
      FakeWebSocket.last._open();
      vc.disable();

      expect(jest.getTimerCount()).toBe(0);
      vc.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports a missing device differently from a denial (E2)', async () => {
    (navigator as any).mediaDevices.getUserMedia = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('none'), { name: 'NotFoundError' })
      );
    const vc = new AudioCapture(SETTINGS);
    await vc.enable();

    expect(vc.state).toBe('error');
    expect(vc.enabled).toBe(false);
    expect(vc.message).toBe('No microphone input device found.');
    vc.dispose();
  });

  it('reconnects after a dropped connection and keeps capture on (D1)', async () => {
    jest.useFakeTimers();
    try {
      const vc = new AudioCapture(SETTINGS);
      await vc.enable();
      const first = FakeWebSocket.last;
      first._open();

      first._drop(1006);
      expect(vc.state).toBe('connecting');
      expect(vc.enabled).toBe(true);
      jest.advanceTimersByTime(500); // first backoff step
      expect(FakeWebSocket.last).not.toBe(first);
      FakeWebSocket.last._open();

      expect(vc.state).toBe('streaming');
      expect(stream.getTracks()[0].stopped).toBe(false);
      vc.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops without reconnecting when another tab takes over (D3)', async () => {
    jest.useFakeTimers();
    try {
      const vc = new AudioCapture(SETTINGS);
      await vc.enable();
      const first = FakeWebSocket.last;
      first._open();

      first._drop(4001); // SUPERSEDED_CLOSE_CODE from routes.py
      jest.advanceTimersByTime(20000);

      expect(vc.state).toBe('idle');
      expect(vc.enabled).toBe(false);
      expect(stream.getTracks()[0].stopped).toBe(true);
      expect(FakeWebSocket.last).toBe(first); // no reconnect
      vc.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('disconnects on a click in a blocking error instead of retrying', async () => {
    (navigator as any).mediaDevices.getUserMedia = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('denied'), { name: 'NotAllowedError' })
      );
    const vc = new AudioCapture(SETTINGS);
    await vc.enable();
    expect(vc.state).toBe('error');

    vc.toggle();

    expect(vc.state).toBe('idle');
    expect(vc.enabled).toBe(false);
    expect((navigator as any).mediaDevices.getUserMedia).toHaveBeenCalledTimes(
      1
    );

    vc.dispose();
  });

  it('disconnects on a click in the endpoint-unreachable error (E4)', async () => {
    jest.useFakeTimers();
    try {
      const vc = new AudioCapture(SETTINGS);
      await vc.enable();
      jest.advanceTimersByTime(10000); // connect deadline → error, still retrying
      expect(vc.state).toBe('error');
      expect(vc.enabled).toBe(true);

      vc.toggle();

      expect(vc.state).toBe('idle');
      expect(vc.enabled).toBe(false);
      expect(stream.getTracks()[0].stopped).toBe(true);

      vc.dispose();
    } finally {
      jest.useRealTimers();
    }
  });
});

const ENABLE = 'audio:enable';
const DISABLE = 'audio:disable';

/** Activates the plugin with a status bar only: runs its commands, reads its model's state. */
function activatePlugin(): {
  execute: (id: string) => Promise<void>;
  state: () => string;
} {
  const commands = new Map<string, any>();
  let status: any;
  plugin.activate(
    {
      commands: {
        addCommand: (id: string, options: any) => commands.set(id, options)
      },
      serviceManager: { serverSettings: SETTINGS }
    } as any,
    null,
    {
      registerStatusItem: (id: string, options: any) => {
        if (id === 'jupyterlab_audio_extension:status') {
          status = options.item;
        }
      }
    } as any,
    null
  );
  return {
    execute: async (id: string) => commands.get(id).execute({}),
    state: () => status.model.state
  };
}

describe('audio:enable and audio:disable', () => {
  it('enable resolves once streaming, and a second enable does nothing', async () => {
    const lab = activatePlugin();
    let resolved = false;
    const enabled = lab.execute(ENABLE).then(() => (resolved = true));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(lab.state()).toBe('connecting');
    expect(resolved).toBe(false);

    const socket = FakeWebSocket.last;
    socket._open();
    await enabled;
    expect(lab.state()).toBe('streaming');

    await lab.execute(ENABLE);
    expect(lab.state()).toBe('streaming');
    expect((navigator as any).mediaDevices.getUserMedia).toHaveBeenCalledTimes(
      1
    );
    expect(FakeWebSocket.last).toBe(socket);
    await lab.execute(DISABLE);
  });

  it('enable rejects with the error message: a denied microphone at once, an unreachable endpoint at the connect deadline', async () => {
    jest.useFakeTimers();
    try {
      (navigator as any).mediaDevices.getUserMedia = jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('denied'), { name: 'NotAllowedError' })
        );
      const denied = activatePlugin();
      await expect(denied.execute(ENABLE)).rejects.toThrow(
        'Microphone permission denied.'
      );
      expect(denied.state()).toBe('error');

      (navigator as any).mediaDevices.getUserMedia = jest
        .fn()
        .mockResolvedValue(stream);
      const unreachable = activatePlugin();
      const rejected = expect(unreachable.execute(ENABLE)).rejects.toThrow(
        'Audio-capture endpoint unreachable'
      );
      await jest.advanceTimersByTimeAsync(10000);
      await rejected;
      await unreachable.execute(DISABLE);
    } finally {
      jest.useRealTimers();
    }
  });

  it('enable rejects at the connect deadline while the permission prompt is unanswered, and Allow later still starts capture', async () => {
    jest.useFakeTimers();
    try {
      let grant: (s: FakeStream) => void = () => undefined;
      (navigator as any).mediaDevices.getUserMedia = jest.fn(
        () => new Promise(resolve => (grant = resolve))
      );
      const lab = activatePlugin();
      const unanswered =
        'Answer the microphone permission prompt in the JupyterLab tab, then run audio:enable again.';

      // A first enable, then a second one while the prompt is still open.
      for (let run = 0; run < 2; run++) {
        let message = '';
        void lab.execute(ENABLE).catch((err: Error) => (message = err.message));
        await jest.advanceTimersByTimeAsync(10000);
        expect(message).toBe(unanswered);
        expect(lab.state()).toBe('connecting');
      }

      grant(stream);
      await jest.advanceTimersByTimeAsync(0);
      FakeWebSocket.last._open();
      expect(lab.state()).toBe('streaming');
      await lab.execute(DISABLE);
    } finally {
      jest.useRealTimers();
    }
  });

  it('disable stops capture, and a second disable does nothing', async () => {
    const lab = activatePlugin();
    await lab.execute(DISABLE);
    expect(lab.state()).toBe('idle');
    expect((navigator as any).mediaDevices.getUserMedia).not.toHaveBeenCalled();

    const enabled = lab.execute(ENABLE);
    await new Promise(resolve => setTimeout(resolve, 0));
    FakeWebSocket.last._open();
    await enabled;

    await lab.execute(DISABLE);
    expect(lab.state()).toBe('idle');
    expect(stream.getTracks()[0].stopped).toBe(true);
    expect(FakeWebSocket.last.readyState).toBe(FakeWebSocket.CLOSED);

    await lab.execute(DISABLE);
    expect(lab.state()).toBe('idle');
    expect((navigator as any).mediaDevices.getUserMedia).toHaveBeenCalledTimes(
      1
    );
  });

  it('disable in one tab stops capture in another tab', async () => {
    const tabA = activatePlugin();
    const tabB = activatePlugin();
    const enabled = tabA.execute(ENABLE);
    await new Promise(resolve => setTimeout(resolve, 0));
    const socket = FakeWebSocket.last;
    socket._open();
    await enabled;
    expect(tabA.state()).toBe('streaming');

    await tabB.execute(DISABLE);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(tabA.state()).toBe('idle');
    expect(stream.getTracks()[0].stopped).toBe(true);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });
});
