import { URLExt } from '@jupyterlab/coreutils';

import { ServerConnection } from '@jupyterlab/services';

import { LabIcon } from '@jupyterlab/ui-components';

import { Widget } from '@lumino/widgets';

const STATUS_POLL_MS = 2000;

const PLAY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <path d="M8 5v14l11-7z"/>
</svg>`;

const PAUSE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <path d="M6 5h4v14H6zm8 0h4v14h-4z"/>
</svg>`;

const STOP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <path d="M6 6h12v12H6z"/>
</svg>`;

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

/** The part of the player route's state the controls read. */
interface IPlayerState {
  paused: boolean;
  playing: unknown[];
  sink: { ok: boolean; reason: string };
}

type PlayerMode = 'playing' | 'paused' | 'idle';

const PLAY_LABELS: Record<PlayerMode, string> = {
  playing: 'Stop',
  paused: 'Resume',
  idle: 'Play'
};

const PAUSE_LABEL = 'Pause';

/**
 * Status-bar playback controls: play/stop and pause. While a file plays, control A shows
 * stop and control B shows pause; while paused, A shows play (resume) and B is disabled;
 * while idle both are disabled and grey. The state is polled from the player route every
 * 2 s, and each click applies the response at once so the faces change without waiting.
 */
export class PlayerStatus extends Widget {
  constructor(settings: ServerConnection.ISettings) {
    super();
    this._settings = settings;
    this.addClass('jp-VoiceCapture-status');
    this.addClass('jp-VoiceCapture-playback');

    this._play = this._createControl('play');
    this._pause = this._createControl('pause');
    this.node.appendChild(this._play);
    this.node.appendChild(this._pause);
    this._render('idle');

    void this._request('status');
    this._timer = window.setInterval(
      () => void this._request('status'),
      STATUS_POLL_MS
    );
  }

  dispose(): void {
    window.clearInterval(this._timer);
    super.dispose();
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

  private _render(mode: PlayerMode, sink?: IPlayerState['sink']): void {
    this._mode = mode;
    const face = mode === 'playing' ? 'stop' : 'play';
    const icon = this._play.firstElementChild as HTMLSpanElement;
    icon.textContent = '';
    (face === 'stop' ? stopIcon : playIcon).element({ container: icon });
    this._play.dataset.vcFace = face;
    this._play.classList.toggle('jp-mod-error', sink?.ok === false);
    const label =
      sink?.ok === false
        ? `${PLAY_LABELS[mode]} - ${sink.reason}`
        : PLAY_LABELS[mode];
    this._play.title = label;
    this._play.setAttribute('aria-label', label);
    this._play.disabled = mode === 'idle';
    this._pause.disabled = mode !== 'playing';
    this.node.dataset.vcPlayer = mode;
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

  private _play: HTMLButtonElement;
  private _pause: HTMLButtonElement;
  private _settings: ServerConnection.ISettings;
  private _mode: PlayerMode = 'idle';
  private _timer: number;
}
