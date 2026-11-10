import { expect, galata, test } from '@jupyterlab/galata';
import type { BrowserContext, Page } from '@playwright/test';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Functional tests: a real JupyterLab, a real browser with Chromium's fake microphone, the
 * real server handler, and a FIFO read by fifo_reader.py in place of PulseAudio. Ids in
 * the test titles are the criteria in docs/acc-crit-voice-capture.md.
 */

const SINK = process.env.VOICE_TEST_SINK as string;
const STATUS = '.jp-VoiceCapture-status';
const ICON = '.jp-VoiceCapture-icon';
const BYTES_PER_SECOND = 16000 * 2; // 16 kHz, mono, 2 bytes per sample

const SPEAKER_FIFO = path.join(path.dirname(SINK), 'speaker.fifo');
const SPEAKER_BYTES_PER_SECOND = 48000 * 4; // 48 kHz, stereo, 2 bytes per sample
const TONE_AMPLITUDE = 0.5; // of full scale, written by speaker_writer.py
const PLAYING = TONE_AMPLITUDE / 2; // analyser peak above which the tab plays the tone
const SPEAKER_OPEN = 'voice-capture test: speaker socket open';
const LOGO = '#jp-MainLogo'; // a click target with no action of its own

test.use({ autoGoto: false });

/** Runs in the page before the app loads: records what the extension asks of the browser. */
function instrument(options: { denyMic?: boolean }): void {
  const w = window as any;
  const vc: any = { gum: 0, streams: [], sockets: [], frames: {} };
  w.__vc = vc;
  const md = navigator.mediaDevices;
  const getUserMedia = md.getUserMedia.bind(md);
  md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
    vc.gum++;
    if (options.denyMic) {
      throw new DOMException('denied', 'NotAllowedError');
    }
    const stream = await getUserMedia(constraints);
    vc.streams.push(stream);
    return stream;
  };
  const NativeWebSocket = window.WebSocket;
  w.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      if (!String(url).includes('jupyterlab-voice-capture-extension/stream')) {
        return;
      }
      vc.sockets.push(this);
      const send = this.send.bind(this);
      this.send = (data: any) => {
        const key = `${data.constructor.name}:${data.byteLength}`;
        vc.frames[key] = (vc.frames[key] || 0) + 1;
        send(data);
      };
    }
  };
}

interface IRecord {
  gum: number;
  sockets: number;
  liveTracks: number;
  frames: Record<string, number>;
}

async function record(page: Page): Promise<IRecord> {
  return page.evaluate(() => {
    const vc = (window as any).__vc;
    const tracks = vc.streams.flatMap((s: MediaStream) => s.getTracks());
    return {
      gum: vc.gum,
      sockets: vc.sockets.length,
      liveTracks: tracks.filter(
        (t: MediaStreamTrack) => t.readyState === 'live'
      ).length,
      frames: vc.frames
    };
  });
}

async function openLab(
  page: Page,
  url: string,
  options: { denyMic?: boolean } = {}
): Promise<void> {
  await page.addInitScript(instrument, options);
  await page.goto(url);
  await page.locator(STATUS).waitFor();
}

async function animation(page: Page): Promise<string> {
  return page
    .locator(`${STATUS} ${ICON}`)
    .evaluate(el => getComputedStyle(el).animationName);
}

interface ISample {
  t: number;
  bytes: number;
  peak: number;
}

/** The FIFO's reader, standing in for PulseAudio's module-pipe-source. */
class FifoReader {
  static async start(): Promise<FifoReader> {
    const reader = new FifoReader();
    await expect
      .poll(() => fs.existsSync(SINK) && fs.statSync(SINK).isFIFO(), {
        timeout: 10000
      })
      .toBe(true);
    return reader;
  }

  private constructor() {
    this._child = spawn(process.env.PYTHON || 'python3', [
      path.join(__dirname, 'fifo_reader.py'),
      SINK
    ]);
    this._child.on('error', e => (this._error = `spawn failed: ${e}`));
    let pending = '';
    this._child.stdout!.on('data', chunk => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() as string;
      for (const line of lines) {
        this._last = JSON.parse(line);
      }
    });
  }

  last(): ISample {
    if (this._error) {
      throw new Error(this._error);
    }
    return this._last;
  }

  /** Bytes per second over `ms` of wall time. */
  async rate(page: Page, ms: number): Promise<number> {
    const a = this.last();
    await page.waitForTimeout(ms);
    const b = this.last();
    return (b.bytes - a.bytes) / (b.t - a.t);
  }

  /**
   * Waits for one `ms` window whose byte rate satisfies `ok`. A busy main thread holds
   * websocket sends back and releases them in a burst, so a single window can read low
   * during the stall and high after it.
   */
  async waitForRate(
    page: Page,
    ok: (rate: number) => boolean,
    ms: number
  ): Promise<void> {
    await expect
      .poll(async () => ok(await this.rate(page, ms)), {
        timeout: 30000,
        intervals: [0]
      })
      .toBe(true);
  }

  async waitForBytes(n: number): Promise<void> {
    await expect
      .poll(() => this.last().bytes, { timeout: 10000 })
      .toBeGreaterThan(n);
  }

  async stop(): Promise<void> {
    const exited = new Promise(resolve => this._child.on('close', resolve));
    this._child.kill('SIGTERM');
    await exited;
  }

  private _child: ChildProcess;
  private _error = '';
  private _last: ISample = { t: 0, bytes: 0, peak: 0 };
}

test.describe('voice capture', () => {
  let reader: FifoReader;

  test.beforeEach(async () => {
    reader = await FifoReader.start();
  });

  test.afterEach(async () => {
    await reader.stop();
  });

  test('A1: captures nothing until the user turns it on', async ({
    page,
    baseURL
  }) => {
    await openLab(page, `${baseURL}/lab`);
    const status = page.locator(STATUS);
    await expect(status).toHaveAttribute('data-vc-state', 'idle');
    await expect(status).toHaveText('Disconnected');
    expect(await animation(page)).toBe('none');

    await page.waitForTimeout(1000);
    expect((await record(page)).gum).toBe(0);
    expect(reader.last().bytes).toBe(0);

    await status.click();
    await expect.poll(async () => (await record(page)).gum).toBe(1);
  });

  test('A2/B1/B3/B4/C2: streams 16 kHz mono s16le in 640-byte binary frames to the FIFO', async ({
    page,
    baseURL
  }) => {
    await openLab(page, `${baseURL}/lab`);
    const status = page.locator(STATUS);
    await status.click();
    await expect(status).toHaveAttribute('data-vc-state', 'streaming', {
      timeout: 15000
    });
    await expect(status).toHaveText('Connected');
    expect(await animation(page)).toBe('vc-pulse');
    expect((await record(page)).liveTracks).toBe(1);

    await reader.waitForRate(
      page,
      rate => Math.abs(rate - BYTES_PER_SECOND) < BYTES_PER_SECOND * 0.15,
      3000
    );
    expect(reader.last().peak).toBeGreaterThan(1000); // the fake microphone's tone, not silence
    expect(Object.keys((await record(page)).frames)).toEqual([
      'ArrayBuffer:640'
    ]);
  });

  test('A3: a second click stops capture, releases the microphone and the FIFO goes quiet', async ({
    page,
    baseURL
  }) => {
    await openLab(page, `${baseURL}/lab`);
    const status = page.locator(STATUS);
    await status.click();
    await expect(status).toHaveAttribute('data-vc-state', 'streaming', {
      timeout: 15000
    });
    await reader.waitForBytes(BYTES_PER_SECOND / 2);

    await status.click();
    await expect(status).toHaveAttribute('data-vc-state', 'idle');
    await expect(status).toHaveText('Disconnected');
    await expect
      .poll(async () => (await record(page)).liveTracks, { timeout: 1000 })
      .toBe(0);
    await reader.waitForRate(page, rate => rate === 0, 1000);
  });

  test('A5/A6: voice-capture:enable resolves streaming, voice-capture:disable stops, a repeat does nothing', async ({
    page,
    baseURL
  }) => {
    await openLab(page, `${baseURL}/lab`);
    const status = page.locator(STATUS);
    // The status item's state when the command settles, or the rejection message.
    const execute = (id: string): Promise<string> =>
      page.evaluate(
        ([id, selector]) =>
          (window as any).jupyterapp.commands.execute(id).then(
            () =>
              (document.querySelector(selector) as HTMLElement).dataset.vcState,
            (e: Error) => e.message
          ),
        [id, STATUS]
      );
    const socket = (): Promise<string> =>
      page.evaluate(
        () =>
          ['connecting', 'open', 'closing', 'closed'][
            (window as any).__vc.sockets[0].readyState
          ]
      );

    expect(await execute('voice-capture:enable')).toBe('streaming');
    await expect(status).toHaveText('Connected');
    expect(await socket()).toBe('open');
    await reader.waitForBytes(BYTES_PER_SECOND / 2);
    expect(await execute('voice-capture:enable')).toBe('streaming');
    expect(await record(page)).toMatchObject({ gum: 1, sockets: 1 });

    expect(await execute('voice-capture:disable')).toBe('idle');
    await expect(status).toHaveText('Disconnected');
    await expect.poll(socket).toBe('closed');
    expect((await record(page)).liveTracks).toBe(0);
    await reader.waitForRate(page, rate => rate === 0, 1000);
    expect(await execute('voice-capture:disable')).toBe('idle');
    expect(await record(page)).toMatchObject({ gum: 1, sockets: 1 });
  });

  test('E1: a denied microphone shows Error, and a click disconnects without retrying', async ({
    page,
    baseURL
  }) => {
    await openLab(page, `${baseURL}/lab`, { denyMic: true });
    const status = page.locator(STATUS);
    await status.click();
    await expect(status).toHaveAttribute('data-vc-state', 'error');
    await expect(status).toHaveText('Error');
    await expect(status).toHaveAttribute(
      'title',
      'Microphone permission denied.'
    );
    expect(await animation(page)).toBe('vc-blink');

    await status.click();
    await expect(status).toHaveAttribute('data-vc-state', 'idle');
    await expect(status).toHaveText('Disconnected');
    await page.waitForTimeout(1000);
    expect((await record(page)).gum).toBe(1);
  });

  test('D1: reconnects after the connection drops and keeps capture on', async ({
    page,
    baseURL
  }) => {
    await openLab(page, `${baseURL}/lab`);
    const status = page.locator(STATUS);
    await status.click();
    await expect(status).toHaveAttribute('data-vc-state', 'streaming', {
      timeout: 15000
    });

    await page.evaluate(() => (window as any).__vc.sockets.at(-1).close());
    await expect
      .poll(async () => (await record(page)).sockets, { timeout: 15000 })
      .toBe(2);
    await expect(status).toHaveAttribute('data-vc-state', 'streaming', {
      timeout: 15000
    });
    expect((await record(page)).liveTracks).toBe(1);
    await reader.waitForBytes(BYTES_PER_SECOND / 2);
  });

  test('D2: closing the tab stops the stream into the FIFO', async ({
    page,
    baseURL
  }) => {
    const tab = await page.context().newPage();
    await openLab(tab, `${baseURL}/lab`);
    const status = tab.locator(STATUS);
    await status.click();
    await expect(status).toHaveAttribute('data-vc-state', 'streaming', {
      timeout: 15000
    });
    await reader.waitForBytes(BYTES_PER_SECOND / 2);

    await tab.close({ runBeforeUnload: true });
    await reader.waitForRate(page, rate => rate === 0, 1000);
  });

  test('D3: a second tab takes over and the first tab stays stopped', async ({
    page,
    baseURL
  }) => {
    await openLab(page, `${baseURL}/lab`);
    const first = page.locator(STATUS);
    await first.click();
    await expect(first).toHaveAttribute('data-vc-state', 'streaming', {
      timeout: 15000
    });

    const tab = await page.context().newPage();
    await openLab(tab, `${baseURL}/lab`);
    const second = tab.locator(STATUS);
    await second.click();
    await expect(second).toHaveAttribute('data-vc-state', 'streaming', {
      timeout: 15000
    });

    await expect(first).toHaveAttribute('data-vc-state', 'idle', {
      timeout: 5000
    });
    await tab.waitForTimeout(3000);
    await expect(first).toHaveAttribute('data-vc-state', 'idle');
    await expect(second).toHaveAttribute('data-vc-state', 'streaming');
    expect((await record(tab)).sockets).toBe(1);
    expect((await record(page)).liveTracks).toBe(0);
    await tab.close();
  });

  test('D4: streaming adds little main-thread script time', async ({
    page,
    baseURL
  }) => {
    await openLab(page, `${baseURL}/lab`);
    const cdp = await page.context().newCDPSession(page.page);
    await cdp.send('Performance.enable');
    const scriptSeconds = async (): Promise<number> => {
      const { metrics } = await cdp.send('Performance.getMetrics');
      return metrics.find(m => m.name === 'ScriptDuration')!.value;
    };
    const window = async (): Promise<number> => {
      const start = await scriptSeconds();
      await page.waitForTimeout(3000);
      return (await scriptSeconds()) - start;
    };

    const idle = await window();
    const status = page.locator(STATUS);
    await status.click();
    await expect(status).toHaveAttribute('data-vc-state', 'streaming', {
      timeout: 15000
    });
    await reader.waitForBytes(BYTES_PER_SECOND / 2);
    const streaming = await window();

    // Encoding runs in the AudioWorklet; the main thread only forwards 50 frames/s.
    test.info().annotations.push({
      type: 'main-thread script seconds per 3 s',
      description: `idle ${idle.toFixed(3)}, streaming ${streaming.toFixed(3)}`
    });
    expect(streaming - idle).toBeLessThan(0.15); // under 5% of the 3 s window
  });
});

/**
 * Runs in the page before the app loads: taps the speaker output (every node connected to
 * the speaker context's destination) with an AnalyserNode and records the speaker sockets.
 * It logs `marker` when a speaker socket opens, so a spec can wait for the speaker without
 * page.evaluate, which Playwright runs as a user gesture.
 */
function tapSpeaker(marker: string): void {
  const w = window as any;
  const spk: any = { sockets: [], closes: [], bytes: 0 };
  w.__spk = spk;
  const NativeNode = window.AudioWorkletNode;
  w.AudioWorkletNode = class extends NativeNode {
    constructor(
      ctx: BaseAudioContext,
      name: string,
      options?: AudioWorkletNodeOptions
    ) {
      super(ctx, name, options);
      if (name === 'voice-speaker-processor') {
        spk.ctx = ctx;
        spk.analyser = new AnalyserNode(ctx, { fftSize: 2048 });
      }
    }
  };
  const connect = AudioNode.prototype.connect as any;
  AudioNode.prototype.connect = function (this: AudioNode, ...args: any[]) {
    if (spk.ctx && args[0] === spk.ctx.destination) {
      connect.call(this, spk.analyser);
    }
    return connect.apply(this, args);
  } as any;
  const NativeWebSocket = window.WebSocket;
  w.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      if (!String(url).includes('jupyterlab-voice-capture-extension/speaker')) {
        return;
      }
      spk.sockets.push(this);
      this.addEventListener('open', () => console.log(marker));
      // Added before the extension's onmessage, which transfers the buffer to the worklet.
      this.addEventListener(
        'message',
        (ev: MessageEvent) => (spk.bytes += ev.data.byteLength)
      );
      this.addEventListener('close', (ev: CloseEvent) =>
        spk.closes.push(ev.code)
      );
    }
  };
}

interface ISpeaker {
  state: string;
  peak: number;
  sockets: number;
  closes: number[];
  bytes: number;
}

/** Runs in the page: what tapSpeaker recorded, and the output peak now. */
function readSpeaker(): ISpeaker {
  const spk = (window as any).__spk;
  const samples = new Float32Array(spk.analyser.fftSize);
  spk.analyser.getFloatTimeDomainData(samples);
  // A context that is not running outputs nothing; a closed one keeps stale samples.
  const running = spk.ctx.state === 'running';
  return {
    state: spk.ctx.state,
    peak: running ? samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0) : 0,
    sockets: spk.sockets.length,
    closes: spk.closes,
    bytes: spk.bytes
  };
}

async function speaker(page: Page): Promise<ISpeaker> {
  return page.evaluate(readSpeaker);
}

/**
 * Waits until the tab plays the tone, reading the output through a CDP evaluate without
 * userGesture, so the tab gets no user activation from the test.
 */
async function waitForPlayingWithoutGesture(tab: Page): Promise<void> {
  const cdp = await tab.context().newCDPSession(tab);
  // 'playing', else the state, so a failure shows whether the browser kept it suspended.
  const output = async (): Promise<string> => {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `(${readSpeaker})()`,
      returnByValue: true
    });
    const { state, peak, bytes } = result.value as ISpeaker;
    return peak > PLAYING ? 'playing' : `${state}, peak ${peak}, ${bytes} B`;
  };
  await expect.poll(output, { timeout: 10000 }).toBe('playing');
  await cdp.detach();
}

/**
 * Opens the lab in a new tab and waits for its speaker socket. Neither step evaluates in
 * the page, so the tab has had no user gesture when this returns.
 */
async function openSpeakerTab(
  context: BrowserContext,
  url: string,
  init?: () => void
): Promise<Page> {
  const tab = await context.newPage();
  await tab.addInitScript(tapSpeaker, SPEAKER_OPEN);
  if (init) {
    await tab.addInitScript(init);
  }
  const opened = tab.waitForEvent('console', m => m.text() === SPEAKER_OPEN);
  await tab.goto(url);
  await opened;
  return tab;
}

async function waitForPlaying(page: Page): Promise<void> {
  await expect
    .poll(async () => (await speaker(page)).peak, { timeout: 10000 })
    .toBeGreaterThan(PLAYING);
}

/** The speaker FIFO's writer, standing in for PulseAudio's module-pipe-sink. */
class SpeakerWriter {
  static async start(): Promise<SpeakerWriter> {
    const writer = new SpeakerWriter();
    await expect
      .poll(
        () => fs.existsSync(SPEAKER_FIFO) && fs.statSync(SPEAKER_FIFO).isFIFO(),
        { timeout: 10000 }
      )
      .toBe(true);
    return writer;
  }

  private constructor() {
    this._child = spawn(process.env.PYTHON || 'python3', [
      path.join(__dirname, 'speaker_writer.py'),
      SPEAKER_FIFO,
      String(TONE_AMPLITUDE)
    ]);
    this._child.on('error', () => undefined); // start() then times out on the FIFO
  }

  async stop(): Promise<void> {
    const exited = new Promise(resolve => this._child.on('close', resolve));
    this._child.kill('SIGTERM');
    await exited;
  }

  private _child: ChildProcess;
}

test.describe('speaker', () => {
  let writer: SpeakerWriter;
  let reader: FifoReader;

  test.beforeEach(async () => {
    writer = await SpeakerWriter.start();
    reader = await FifoReader.start();
  });

  test.afterEach(async () => {
    await reader.stop();
    await writer.stop();
  });

  test('G1/G2: plays nothing before a user gesture and the tone after one click', async ({
    page,
    baseURL
  }) => {
    const tab = await openSpeakerTab(page.context(), `${baseURL}/lab`);
    await tab.waitForTimeout(1000);
    const before = await speaker(tab);
    expect(before.bytes).toBeGreaterThan(0); // the audio reaches the tab,
    expect(before.state).toBe('suspended'); // but the browser holds the context

    await tab.locator(LOGO).click();
    await waitForPlaying(tab);
    expect((await speaker(tab)).state).toBe('running');
  });

  test('G7: every tab plays and no speaker socket closes', async ({
    page,
    baseURL
  }) => {
    const first = await openSpeakerTab(page.context(), `${baseURL}/lab`);
    await first.locator(LOGO).click();
    await waitForPlaying(first);

    const second = await openSpeakerTab(page.context(), `${baseURL}/lab`);
    await second.locator(LOGO).click();
    await waitForPlaying(second);
    await second.waitForTimeout(2000);
    for (const tab of [first, second]) {
      await waitForPlaying(tab);
      const { sockets, closes } = await speaker(tab);
      expect(sockets).toBe(1);
      expect(closes).toEqual([]);
    }
  });

  test('G13: microphone capture streams at 16 kHz beside playback', async ({
    page,
    baseURL
  }) => {
    const tab = await openSpeakerTab(page.context(), `${baseURL}/lab`);
    await tab.locator(LOGO).click();
    await waitForPlaying(tab);

    const status = tab.locator(STATUS);
    await status.click();
    await expect(status).toHaveAttribute('data-vc-state', 'streaming', {
      timeout: 15000
    });
    await reader.waitForRate(
      tab,
      rate => Math.abs(rate - BYTES_PER_SECOND) < BYTES_PER_SECOND * 0.15,
      3000
    );
    expect(reader.last().peak).toBeGreaterThan(1000);
    expect((await speaker(tab)).peak).toBeGreaterThan(PLAYING);
  });

  test('G9: the speaker socket reconnects after a drop and playback resumes', async ({
    page,
    baseURL
  }) => {
    const tab = await openSpeakerTab(page.context(), `${baseURL}/lab`);
    await tab.locator(LOGO).click();
    await waitForPlaying(tab);

    await tab.evaluate(() => (window as any).__spk.sockets[0].close());
    await expect
      .poll(async () => (await speaker(tab)).sockets, { timeout: 15000 })
      .toBe(2);
    const { bytes } = await speaker(tab);
    // After half a second of audio on the new socket, the player holds none from before the drop.
    await expect
      .poll(
        async () => {
          const now = await speaker(tab);
          return (
            now.bytes - bytes >= SPEAKER_BYTES_PER_SECOND / 2 &&
            now.peak > PLAYING
          );
        },
        { timeout: 10000 }
      )
      .toBe(true);
  });
});

/** Runs in the page before the app loads: adds a frame above the app at the top left corner. */
function addFrame(): void {
  if (window !== window.top) {
    return; // init scripts run in every frame, the added one too
  }
  document.addEventListener('DOMContentLoaded', () => {
    const frame = document.createElement('iframe');
    frame.srcdoc = '<p>frame</p>';
    frame.style.cssText =
      'position: fixed; left: 0; top: 0; width: 100px; height: 100px; z-index: 100000';
    document.body.appendChild(frame);
  });
}

// G1/G2 is the third case: a tab with no gesture stays silent while the tone arrives.
test.describe('autoplay', () => {
  // The tone starts after the gesture, so the first audio that arrives resumes the context.
  let writer: SpeakerWriter | undefined;

  test.afterEach(async () => {
    await writer?.stop();
    writer = undefined;
  });

  test('G2: after a click only inside a frame, the tab plays the tone', async ({
    page,
    baseURL
  }) => {
    const tab = await openSpeakerTab(
      page.context(),
      `${baseURL}/lab`,
      addFrame
    );
    // The mouse alone, with no locator: a locator evaluates in the page first.
    await tab.mouse.click(50, 50);

    writer = await SpeakerWriter.start();
    await waitForPlayingWithoutGesture(tab);
  });

  test('G2: a tab with no gesture plays the tone when the browser allows autoplay', async ({
    playwright,
    launchOptions,
    baseURL
  }) => {
    // Playwright refuses launchOptions in test.use inside a describe group.
    const browser = await playwright.chromium.launch({
      ...launchOptions,
      args: [
        ...(launchOptions.args ?? []),
        '--autoplay-policy=no-user-gesture-required'
      ]
    });
    try {
      const tab = await openSpeakerTab(
        await browser.newContext(),
        `${baseURL}/lab`
      );

      writer = await SpeakerWriter.start();
      await waitForPlayingWithoutGesture(tab);
    } finally {
      await browser.close();
    }
  });
});

/** A 440 Hz tone at TONE_AMPLITUDE as a 48 kHz 16-bit mono wav file. */
function toneWav(seconds: number): Buffer {
  const rate = 48000;
  const n = rate * seconds;
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + n * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); // fmt chunk size
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28); // bytes per second
  wav.writeUInt16LE(2, 32); // bytes per frame
  wav.writeUInt16LE(16, 34); // bits per sample
  wav.write('data', 36);
  wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = TONE_AMPLITUDE * Math.sin((2 * Math.PI * 440 * i) / rate);
    wav.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return wav;
}

test.describe('player', () => {
  test('ACC-PLAYER-55: the palette Stop All Audio runs the player with action stop', async ({
    page,
    baseURL
  }) => {
    await openLab(page, `${baseURL}/lab`);
    await page.keyboard.press('Control+Shift+C');
    const input = page.locator('.lm-CommandPalette-input');
    await input.fill('Stop All Audio');
    const item = page.locator('.lm-CommandPalette-item', {
      hasText: 'Stop All Audio'
    });
    await expect(item).toBeVisible();

    const posted = page.waitForRequest(
      request =>
        request.method() === 'POST' &&
        request.url().includes('jupyterlab-voice-capture-extension/player')
    );
    await item.click();
    const request = await posted;
    expect(JSON.parse(request.postData() as string)).toEqual({
      action: 'stop'
    });
  });
});

/** Executes voice-capture:player in the page: the state as JSON, or the rejection message. */
function playerExpression(body: object): string {
  return `window.jupyterapp.commands
    .execute('voice-capture:player', ${JSON.stringify(body)})
    .then(state => JSON.stringify(state), e => e.message)`;
}

/**
 * The real chain, skipped unless VOICE_TEST_PULSE_SERVER names an isolated PulseAudio server
 * on which `jupyterlab_voice_capture start` loaded the bridge for VOICE_TEST_SINK. paplay of
 * VOICE_TEST_PLAY_FILE into voiceout must be heard in the tab while the tab's microphone
 * streams into voicein.
 *
 *   A=$(mktemp -d /tmp/vcspk.XXXXXX) && mkdir $A/run
 *   PULSE_RUNTIME_PATH=$A PULSE_STATE_PATH=$A/state pulseaudio -n --daemonize=yes \
 *     --exit-idle-time=-1 --load=module-native-protocol-unix
 *   PULSE_SERVER=unix:$A/native python -c "import jupyterlab_voice_capture_extension.cli as c; \
 *     c.PULSE_RUNTIME_PATH = '$A'; \
 *     raise SystemExit(c.main(['start', '-d', '--sink-path', '$A/run/pulseaudio.fifo']))"
 *   VOICE_TEST_PULSE_SERVER=unix:$A/native VOICE_TEST_SINK=$A/run/pulseaudio.fifo \
 *     VOICE_TEST_PLAY_FILE=<an mp3> jlpm playwright test -g "real chain"
 */
const PULSE_SERVER = process.env.VOICE_TEST_PULSE_SERVER;

test.describe('real chain', () => {
  test.skip(
    !PULSE_SERVER,
    'VOICE_TEST_PULSE_SERVER names no PulseAudio server'
  );

  test('G12/G13: paplay is heard in the tab while the microphone streams into voicein', async ({
    page,
    baseURL
  }) => {
    const tab = await openSpeakerTab(page.context(), `${baseURL}/lab`);
    const status = tab.locator(STATUS);
    await status.click(); // the one click: starts capture and lets the speaker play
    await expect(status).toHaveAttribute('data-vc-state', 'streaming', {
      timeout: 15000
    });

    const env = { ...process.env, PULSE_SERVER };
    const rec = spawn(
      'parec',
      [
        '-d',
        'voicein',
        '--raw',
        '--format=s16le',
        '--rate=16000',
        '--channels=1'
      ],
      { env }
    );
    let recBytes = 0;
    let recPeak = 0;
    let carry = Buffer.alloc(0);
    rec.stdout.on('data', (chunk: Buffer) => {
      recBytes += chunk.length;
      const data = Buffer.concat([carry, chunk]);
      const even = data.length - (data.length % 2);
      for (let i = 0; i < even; i += 2) {
        recPeak = Math.max(recPeak, Math.abs(data.readInt16LE(i)));
      }
      carry = data.subarray(even);
    });
    const play = spawn('paplay', [process.env.VOICE_TEST_PLAY_FILE as string], {
      env
    });
    try {
      await tab.waitForTimeout(1000);
      const t0 = Date.now();
      const bytes0 = recBytes;
      const tab0 = (await speaker(tab)).bytes;
      let peak = 0;
      while (Date.now() - t0 < 8000) {
        peak = Math.max(peak, (await speaker(tab)).peak);
        await tab.waitForTimeout(100);
      }
      const seconds = (Date.now() - t0) / 1000;
      const recRate = (recBytes - bytes0) / seconds;
      const tabRate = ((await speaker(tab)).bytes - tab0) / seconds;
      test.info().annotations.push({
        type: 'real chain over 8 s',
        description: `tab peak ${peak.toFixed(3)}, speaker ${Math.round(tabRate)} B/s; voicein ${Math.round(recRate)} B/s, peak ${recPeak}`
      });
      expect(peak).toBeGreaterThan(PLAYING);
      expect(Math.abs(recRate - BYTES_PER_SECOND)).toBeLessThan(
        BYTES_PER_SECOND * 0.15
      );
      expect(recPeak).toBeGreaterThan(1000); // the fake microphone's tone, not silence
    } finally {
      play.kill();
      rec.kill();
    }
  });

  test('ACC-PLAYER-51/59: the player plays a file at once and a tab that connects later hears it', async ({
    page,
    baseURL,
    request,
    tmpPath
  }) => {
    const wav = `${tmpPath}/player-tone.wav`;
    await galata
      .newContentsHelper(request)
      .uploadContent(toneWav(10).toString('base64'), 'base64', wav);

    const first = await openSpeakerTab(page.context(), `${baseURL}/lab`);
    await first.locator(LOGO).click();
    await expect
      .poll(async () => (await speaker(first)).state, { timeout: 10000 })
      .toBe('running');

    const played = await first.evaluate(
      playerExpression({ action: 'play', mode: 'now', path: wav })
    );
    const state = JSON.parse(played);
    expect(state.playing).toHaveLength(1);
    expect(state.playing[0].path).toContain('player-tone.wav');
    await waitForPlaying(first);

    // ACC-PLAYER-59: a tab opened after playback started hears the file as well.
    const later = await openSpeakerTab(page.context(), `${baseURL}/lab`);
    await later.locator(LOGO).click();
    await waitForPlaying(later);

    const stopped = JSON.parse(
      await first.evaluate(playerExpression({ action: 'stop' }))
    );
    expect(stopped.playing).toEqual([]);
    await expect
      .poll(async () => (await speaker(later)).peak, { timeout: 5000 })
      .toBe(0);
  });
});
