import { Notification } from '@jupyterlab/apputils';

import { ServerConnection } from '@jupyterlab/services';

import { SPEAKER_SAMPLE_RATE } from './pcm';

import { voiceCaptureWsUrl } from './request';

import {
  SPEAKER_PROCESSOR_NAME,
  speakerWorkletModuleUrl
} from './speaker-worklet';

import { BASE_BACKOFF_MS, MAX_BACKOFF_MS } from './voice-capture';

const GESTURE_EVENTS = ['pointerdown', 'keydown'];
// Audio that arrives while the context is not running is held this long, then dropped.
const HOLD_MS = 500;

/**
 * Plays the container's default PulseAudio sink in this tab: the /speaker websocket feeds
 * a 48 kHz AudioWorklet player connected to the AudioContext destination. Always on,
 * independent of capture: its own AudioContext and socket, no microphone.
 */
export class Speaker {
  constructor(serverSettings: ServerConnection.ISettings) {
    this._serverSettings = serverSettings;
  }

  async start(): Promise<void> {
    const ctx = new AudioContext({ sampleRate: SPEAKER_SAMPLE_RATE });
    this._ctx = ctx;
    const url = speakerWorkletModuleUrl();
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    this._node = new AudioWorkletNode(ctx, SPEAKER_PROCESSOR_NAME, {
      outputChannelCount: [2]
    });
    this._node.connect(ctx.destination);
    ctx.onstatechange = this._onStateChange;
    this._onStateChange();
    this._resume(); // starts at once when the page already has sticky activation
    this._connect();
  }

  // While the context is suspended, the next pointerdown or keydown resumes it.
  private _onStateChange = (): void => {
    for (const type of GESTURE_EVENTS) {
      if (this._ctx.state !== 'running') {
        document.addEventListener(type, this._resume, true);
      } else {
        document.removeEventListener(type, this._resume, true);
      }
    }
    if (this._ctx.state === 'running') {
      if (this._cueId) {
        Notification.dismiss(this._cueId);
        this._cueId = null;
      }
    }
    this._play();
  };

  /**
   * Posts the held audio to the player once the context runs. Until then it drops audio
   * held longer than HOLD_MS and resumes the context, at most once per HOLD_MS, because
   * the browser logs a warning for every resume it refuses.
   */
  private _play(): void {
    const now = performance.now();
    if (
      this._ctx.state !== 'running' &&
      !this._cueId &&
      this._held.some(chunk => now - chunk.at > HOLD_MS)
    ) {
      // The backlog is dropped below; say why the tab is silent, once per suspension.
      this._cueId = Notification.emit(
        'This tab is not playing audio: the browser blocks sound until you click or press a key in this tab.',
        'info',
        { autoClose: false }
      );
    }
    this._held = this._held.filter(chunk => now - chunk.at <= HOLD_MS);
    if (this._ctx.state === 'running') {
      for (const { pcm } of this._held) {
        this._node.port.postMessage(pcm, [pcm]);
      }
      this._held = [];
    } else if (this._held.length && now - this._resumedAt > HOLD_MS) {
      this._resumedAt = now;
      this._resume();
    }
  }

  private _resume = (): void => {
    // Without a user gesture the browser keeps the context suspended; the next gesture or
    // arriving audio retries.
    this._ctx.resume().catch(() => undefined);
  };

  private _connect(): void {
    const ws = new WebSocket(
      voiceCaptureWsUrl(this._serverSettings, 'speaker')
    );
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      this._backoff = BASE_BACKOFF_MS;
    };
    ws.onmessage = (ev: MessageEvent) => {
      this._held.push({ pcm: ev.data as ArrayBuffer, at: performance.now() });
      this._play();
    };
    ws.onclose = () => {
      const delay = this._backoff;
      this._backoff = Math.min(this._backoff * 2, MAX_BACKOFF_MS);
      window.setTimeout(() => this._connect(), delay);
    };
  }

  private readonly _serverSettings: ServerConnection.ISettings;
  private _ctx!: AudioContext;
  private _node!: AudioWorkletNode;
  private _backoff = BASE_BACKOFF_MS;
  private _held: { pcm: ArrayBuffer; at: number }[] = [];
  private _resumedAt = -Infinity;
  private _cueId: string | null = null;
}
