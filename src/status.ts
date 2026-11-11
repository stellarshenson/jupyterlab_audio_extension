import { URLExt } from '@jupyterlab/coreutils';

import { ServerConnection } from '@jupyterlab/services';

import { LabIcon } from '@jupyterlab/ui-components';

import { Widget } from '@lumino/widgets';

import { VoiceCapture, VoiceCaptureState } from './voice-capture';

const STATUS_POLL_MS = 2000;
// The missing-sink episode blinks for this long, then the lamp settles to the off ring.
const BLINK_MS = 30000;
const SINK_UNAVAILABLE = 'Audio output is unavailable';
const SINK_SHUT_DOWN = 'Audio output is shut down';

const MIC_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/>
  <path d="M19 11a7 7 0 0 1-6 6.92V21h-2v-3.08A7 7 0 0 1 5 11h2a5 5 0 0 0 10 0h2z"/>
</svg>`;

const PLAY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <path d="M8 5v14l11-7z"/>
</svg>`;

const PAUSE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <path d="M6 5h4v14H6zm8 0h4v14h-4z"/>
</svg>`;

const STOP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <path d="M6 6h12v12H6z"/>
</svg>`;

export const micIcon = new LabIcon({
  name: 'voice-capture:mic',
  svgstr: MIC_SVG
});

export const playIcon = new LabIcon({
  name: 'voice-capture:play',
  svgstr: PLAY_SVG
});

export const pauseIcon = new LabIcon({
  name: 'voice-capture:pause',
  svgstr: PAUSE_SVG
});

export const stopIcon = new LabIcon({
  name: 'voice-capture:stop',
  svgstr: STOP_SVG
});

type SinkState = 'ready' | 'off' | 'missing';

/** The part of the player route's state the controls read. */
interface IPlayerState {
  paused: boolean;
  playing: unknown[];
  sink: { state: SinkState };
}

type PlayerMode = 'playing' | 'paused' | 'idle';

const LABELS: Record<VoiceCaptureState, string> = {
  idle: 'Disconnected',
  connecting: 'Connecting',
  streaming: 'Connected',
  error: 'Error'
};

const TITLES: Record<VoiceCaptureState, string> = {
  idle: 'Voice capture off - click to start',
  connecting: 'Voice capture connecting...',
  streaming: 'Voice capture on - streaming to server',
  error: 'Voice capture error'
};

const PLAY_LABELS: Record<PlayerMode, string> = {
  playing: 'Stop',
  paused: 'Resume',
  idle: 'Play'
};

const PAUSE_LABEL = 'Pause';

/**
 * Status-bar pill: an audio-system lamp, the microphone toggle, a play/stop control and a
 * pause control between hairline dividers. The lamp is the leading child and reports the
 * speaker sink: ready, off, active or fault. The microphone reflects exactly one of idle /
 * connecting / streaming / error (A4), animates per state and carries the state word and
 * guide in its tooltip. The player state is polled every 2 s; a click applies the response
 * at once so the faces change without waiting. A missing sink blinks the lamp amber for
 * 30 s, then settles it to the off ring with both controls disabled and the plain message
 * left in the play tooltip; a deliberate shutdown shows the ring at once.
 */
export class VoiceStatus extends Widget {
  constructor(model: VoiceCapture, settings: ServerConnection.ISettings) {
    super();
    this._model = model;
    this._settings = settings;
    this.addClass('jp-VoiceCapture-status');
    this.addClass('jp-VoiceCapture-pill');

    this._lamp = document.createElement('span');
    this._lamp.className = 'jp-VoiceCapture-lamp';
    this._lamp.setAttribute('aria-hidden', 'true');
    this._mic = this._createMic();
    this._play = this._createControl('play');
    this._pause = this._createControl('pause');
    this.node.appendChild(this._lamp);
    this.node.appendChild(this._divider());
    this.node.appendChild(this._mic);
    this.node.appendChild(this._divider());
    this.node.appendChild(this._play);
    this.node.appendChild(this._divider());
    this.node.appendChild(this._pause);

    model.stateChanged.connect(this._refresh, this);
    this._refresh();
    this._render('idle');

    void this._request('status');
    this._timer = window.setInterval(
      () => void this._request('status'),
      STATUS_POLL_MS
    );
  }

  dispose(): void {
    window.clearInterval(this._timer);
    this._stopBlink();
    this._model.stateChanged.disconnect(this._refresh, this);
    super.dispose();
  }

  private _createMic(): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jp-VoiceCapture-control jp-VoiceCapture-mic';
    button.dataset.vcControl = 'mic';
    const icon = document.createElement('span');
    icon.className = 'jp-VoiceCapture-icon';
    button.appendChild(icon);
    micIcon.element({ container: icon });
    button.addEventListener('click', this._onMic);
    return button;
  }

  private _createControl(control: 'play' | 'pause'): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jp-VoiceCapture-control';
    button.dataset.vcControl = control;
    const icon = document.createElement('span');
    icon.className = 'jp-VoiceCapture-icon';
    button.appendChild(icon);
    button.addEventListener(
      'click',
      control === 'play' ? this._onPlay : this._onPause
    );
    if (control === 'pause') {
      pauseIcon.element({ container: icon });
      button.title = PAUSE_LABEL;
      button.setAttribute('aria-label', PAUSE_LABEL);
    }
    return button;
  }

  private _divider(): HTMLSpanElement {
    const divider = document.createElement('span');
    divider.className = 'jp-VoiceCapture-divider';
    return divider;
  }

  private _onMic = (): void => {
    this._model.toggle();
  };

  private _refresh(): void {
    const state = this._model.state;
    this.removeClass('jp-mod-idle');
    this.removeClass('jp-mod-connecting');
    this.removeClass('jp-mod-streaming');
    this.removeClass('jp-mod-error');
    this.addClass(`jp-mod-${state}`);
    this.node.dataset.vcState = state;
    const title =
      state === 'error' ? this._model.message || TITLES.error : TITLES[state];
    const tooltip = `${LABELS[state]} - ${title}`;
    this.node.title = tooltip;
    this._mic.title = tooltip;
    this._mic.setAttribute('aria-label', tooltip);
    this._paintLamp();
  }

  private _render(mode: PlayerMode, sink?: IPlayerState['sink']): void {
    this._mode = mode;
    const face = mode === 'playing' ? 'stop' : 'play';
    const icon = this._play.firstElementChild as HTMLSpanElement;
    icon.textContent = '';
    (face === 'stop' ? stopIcon : playIcon).element({ container: icon });
    this._play.dataset.vcFace = face;

    if (sink) {
      this._sink = sink.state;
    }
    if (this._sink !== 'missing') {
      this._stopBlink();
    } else if (!this._blinkDone && this._blinkTimer === null) {
      this._blinkTimer = window.setTimeout(() => {
        this._blinkTimer = null;
        this._blinkDone = true;
        this._paintLamp();
        this._applyControls();
      }, BLINK_MS);
    }

    const reason =
      this._sink === 'missing'
        ? SINK_UNAVAILABLE
        : this._sink === 'off'
          ? SINK_SHUT_DOWN
          : '';
    const label = reason
      ? `${PLAY_LABELS[mode]} - ${reason}`
      : PLAY_LABELS[mode];
    this._play.title = label;
    this._play.setAttribute('aria-label', label);
    this._paintLamp();
    this._applyControls();
    this.node.dataset.vcPlayer = mode;
  }

  /** Paints the leading lamp: amber fault during the blink, then the off ring; green while active. */
  private _paintLamp(): void {
    let lamp: 'ready' | 'off' | 'active' | 'fault';
    if (this._sink === 'missing' && !this._blinkDone) {
      lamp = 'fault';
    } else if (this._sink === 'missing' || this._sink === 'off') {
      lamp = 'off';
    } else if (this._model.state === 'streaming' || this._mode === 'playing') {
      lamp = 'active';
    } else {
      lamp = 'ready';
    }
    this._lamp.dataset.vcLamp = lamp;
  }

  /** A shutdown and a settled fault disable both player controls; otherwise the mode decides. */
  private _applyControls(): void {
    const dead = this._sink === 'off' || this._blinkDone;
    this._play.disabled = dead || this._mode === 'idle';
    this._pause.disabled = dead || this._mode !== 'playing';
  }

  /** Ends the current broken-sink episode; a later break starts a new blink. */
  private _stopBlink(): void {
    if (this._blinkTimer !== null) {
      window.clearTimeout(this._blinkTimer);
      this._blinkTimer = null;
    }
    this._blinkDone = false;
  }

  private async _request(action: string): Promise<void> {
    try {
      const response = await ServerConnection.makeRequest(
        URLExt.join(
          this._settings.baseUrl,
          'jupyterlab-voice-capture-extension',
          'player'
        ),
        { method: 'POST', body: JSON.stringify({ action }) },
        this._settings
      );
      if (!response.ok) {
        return; // a failed poll keeps the last state; the next poll retries
      }
      const state = (await response.json()) as IPlayerState;
      this._render(
        state.paused ? 'paused' : state.playing.length > 0 ? 'playing' : 'idle',
        state.sink
      );
    } catch {
      // The route is unreachable: keep the last state; the next poll retries.
    }
  }

  private _onPlay = (): void => {
    void this._request(this._mode === 'paused' ? 'resume' : 'stop');
  };

  private _onPause = (): void => {
    void this._request('pause');
  };

  private _model: VoiceCapture;
  private _settings: ServerConnection.ISettings;
  private _lamp: HTMLSpanElement;
  private _mic: HTMLButtonElement;
  private _play: HTMLButtonElement;
  private _pause: HTMLButtonElement;
  private _mode: PlayerMode = 'idle';
  private _sink: SinkState = 'ready';
  private _timer: number;
  private _blinkTimer: number | null = null;
  private _blinkDone = false;
}
