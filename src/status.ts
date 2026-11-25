import { URLExt } from '@jupyterlab/coreutils';

import { ServerConnection } from '@jupyterlab/services';

import { Popup, showPopup } from '@jupyterlab/statusbar';

import { LabIcon } from '@jupyterlab/ui-components';

import { PanelLayout, Widget } from '@lumino/widgets';

import { AudioCapture, AudioCaptureState } from './audio-capture';

import { AudioSettings } from './settings';

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

const GEAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
</svg>`;

export const micIcon = new LabIcon({
  name: 'audio:mic',
  svgstr: MIC_SVG
});

export const playIcon = new LabIcon({
  name: 'audio:play',
  svgstr: PLAY_SVG
});

export const pauseIcon = new LabIcon({
  name: 'audio:pause',
  svgstr: PAUSE_SVG
});

export const stopIcon = new LabIcon({
  name: 'audio:stop',
  svgstr: STOP_SVG
});

export const gearIcon = new LabIcon({
  name: 'audio:gear',
  svgstr: GEAR_SVG
});

type SinkState = 'ready' | 'off' | 'missing';

/** The part of the player route's state the controls read. */
interface IPlayerState {
  paused: boolean;
  playing: unknown[];
  sink: { state: SinkState };
  /** The FIFO that receives captured audio; absent from a server older than this page. */
  capture?: string;
}

type PlayerMode = 'playing' | 'paused' | 'idle';

const LABELS: Record<AudioCaptureState, string> = {
  idle: 'Disconnected',
  connecting: 'Connecting',
  streaming: 'Connected',
  error: 'Error'
};

const TITLES: Record<AudioCaptureState, string> = {
  idle: 'Audio capture off - click to start',
  connecting: 'Audio capture connecting...',
  streaming: 'Audio capture on - streaming to server',
  error: 'Audio capture error'
};

const PLAY_LABELS: Record<PlayerMode, string> = {
  playing: 'Stop',
  paused: 'Resume',
  idle: 'Play'
};

const PAUSE_LABEL = 'Pause';
const GEAR_LABEL = 'Audio settings';

/** The audio card's words for the microphone and for playback (ACC-CTRL-100). */
const CAPTURE_WORDS: Record<AudioCaptureState, string> = {
  idle: 'Not capturing',
  connecting: 'Connecting',
  streaming: 'Capturing',
  error: 'Error'
};

const PLAYER_WORDS: Record<PlayerMode, string> = {
  playing: 'Playing',
  paused: 'Paused',
  idle: 'Nothing playing'
};

/**
 * Status-bar pill: an audio-system lamp, the microphone toggle, a play/stop control and a
 * pause control between hairline dividers. The lamp is the leading child and reports the
 * speaker sink: ready, off, active or fault. The microphone reflects exactly one of idle /
 * connecting / streaming / error (A4), animates per state and carries the state word and
 * guide in its tooltip. The player state is polled every 2 s; a click applies the response
 * at once so the faces change without waiting. A missing sink blinks the lamp amber for
 * 30 s, then settles it to the off ring with both controls disabled and the plain message
 * left in the play tooltip; a deliberate shutdown shows the ring at once. An optional slot,
 * the AudioStatus toolbar that other extensions fill, sits right of the microphone. The gear
 * is the last control: it opens the settings panel above itself, and a second click, Escape
 * or a click outside the panel closes it (ACC-CTRL-99).
 */
export class VoiceStatus extends Widget {
  constructor(
    model: AudioCapture,
    settings: ServerConnection.ISettings,
    slot?: Widget,
    cards?: () => Widget
  ) {
    super();
    this._model = model;
    this._settings = settings;
    this._cards = cards;
    this.addClass('jp-Audio-status');
    this.addClass('jp-Audio-pill');

    this._lamp = document.createElement('span');
    this._lamp.className = 'jp-Audio-lamp';
    this._lamp.setAttribute('role', 'img');
    this._mic = this._createMic();
    this._play = this._createControl('play');
    this._pause = this._createControl('pause');
    this._gear = this._createGear();
    this.node.appendChild(this._lamp);
    this.node.appendChild(this._divider());
    this.node.appendChild(this._mic);
    this.node.appendChild(this._divider());
    this.node.appendChild(this._play);
    this.node.appendChild(this._divider());
    this.node.appendChild(this._pause);
    this.node.appendChild(this._divider());
    this.node.appendChild(this._gear.node);
    if (slot) {
      this._addSlot(slot);
    }

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
    this._popup?.dispose();
    this._slotObserver?.disconnect();
    this._stopBlink();
    this._model.stateChanged.disconnect(this._refresh, this);
    super.dispose();
  }

  private _createMic(): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jp-Audio-control jp-Audio-mic';
    button.dataset.vcControl = 'mic';
    const icon = document.createElement('span');
    icon.className = 'jp-Audio-icon';
    button.appendChild(icon);
    micIcon.element({ container: icon });
    button.addEventListener('click', this._onMic);
    return button;
  }

  private _createControl(control: 'play' | 'pause'): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jp-Audio-control';
    button.dataset.vcControl = control;
    const icon = document.createElement('span');
    icon.className = 'jp-Audio-icon';
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

  /** The gear is a widget because the status bar popup anchors to one. */
  private _createGear(): Widget {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jp-Audio-control jp-Audio-gear';
    button.dataset.vcControl = 'gear';
    button.title = GEAR_LABEL;
    button.setAttribute('aria-label', GEAR_LABEL);
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    const icon = document.createElement('span');
    icon.className = 'jp-Audio-icon';
    button.appendChild(icon);
    gearIcon.element({ container: icon });
    button.addEventListener('click', this._onGear);
    return new Widget({ node: button });
  }

  private _divider(): HTMLSpanElement {
    const divider = document.createElement('span');
    divider.className = 'jp-Audio-divider';
    return divider;
  }

  /**
   * Puts the slot right of the microphone (ACC-CTRL-96). The slot and its divider show only
   * while an item shows: an item with an unregistered command is hidden by the platform.
   */
  private _addSlot(slot: Widget): void {
    const divider = this._divider();
    slot.addClass('jp-Audio-slot');
    // The layout delivers the attach messages on which toolbar buttons render.
    const layout = new PanelLayout();
    this.layout = layout;
    layout.addWidget(slot);
    this._mic.after(slot.node);
    const sync = (): void => {
      const shown = Array.from(slot.children()).some(
        item => !item.isHidden && !item.hasClass('lm-mod-hidden')
      );
      if (shown) {
        this._mic.after(divider);
      } else {
        divider.remove();
      }
      slot.setHidden(!shown);
    };
    this._slotObserver = new MutationObserver(sync);
    this._slotObserver.observe(slot.node, {
      childList: true,
      subtree: true,
      attributeFilter: ['class']
    });
    sync();
  }

  private _onMic = (): void => {
    this._model.toggle();
  };

  /** Opens the settings panel above the gear, or closes the open one (ACC-CTRL-99). */
  private _onGear = (): void => {
    if (this._popup) {
      this._popup.dispose();
      return;
    }
    const gear = this._gear.node;
    const panel = new AudioSettings(this._cards?.());
    this._panel = panel;
    this._summarise();
    // The popup closes itself on Escape and on a click outside the panel and the gear.
    const popup = showPopup({
      body: panel,
      anchor: this._gear,
      align: 'left',
      // A card that loads its content after the panel opened makes the panel taller.
      hasDynamicSize: true
    });
    this._popup = popup;
    gear.setAttribute('aria-expanded', 'true');
    popup.disposed.connect(() => {
      // Escape closes the panel that holds the focus: the gear takes the focus back.
      if (popup.node.contains(document.activeElement)) {
        gear.focus();
      }
      gear.setAttribute('aria-expanded', 'false');
      this._popup = null;
      this._panel = null;
    });
    panel.node.focus();
  };

  /** Writes the audio extension's state into the open panel's audio card (ACC-CTRL-100). */
  private _summarise(): void {
    const state = this._model.state;
    this._panel?.summarise({
      microphone:
        state === 'error'
          ? this._model.message || CAPTURE_WORDS.error
          : CAPTURE_WORDS[state],
      playback:
        this._sink === 'missing'
          ? SINK_UNAVAILABLE
          : this._sink === 'off'
            ? SINK_SHUT_DOWN
            : PLAYER_WORDS[this._mode],
      delivery: this._capture || 'Unknown'
    });
  }

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
    this._summarise();
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
    this._summarise();
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
    // Mirrored on the root for the shut-down control marking in style/base.css.
    this.node.dataset.vcLamp = lamp;
    // The lamp names the whole audio system, not the audio-capture state.
    const title =
      this._sink === 'missing'
        ? 'Audio system unavailable'
        : this._sink === 'off'
          ? 'Audio system shut down'
          : lamp === 'active'
            ? 'Audio system in use'
            : 'Audio system ready';
    this._lamp.title = title;
    this._lamp.setAttribute('aria-label', title);
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
          'jupyterlab-audio-extension',
          'player'
          // A poll is not user activity: it must not hold off the server's idle shutdown.
        ) + (action === 'status' ? '?no_track_activity=1' : ''),
        { method: 'POST', body: JSON.stringify({ action }) },
        this._settings
      );
      if (!response.ok) {
        return; // a failed poll keeps the last state; the next poll retries
      }
      const state = (await response.json()) as IPlayerState;
      this._capture = state.capture;
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

  private _model: AudioCapture;
  private _settings: ServerConnection.ISettings;
  private _lamp: HTMLSpanElement;
  private _mic: HTMLButtonElement;
  private _play: HTMLButtonElement;
  private _pause: HTMLButtonElement;
  private _gear: Widget;
  private _cards?: () => Widget;
  private _popup: Popup | null = null;
  private _panel: AudioSettings | null = null;
  private _capture?: string;
  private _slotObserver: MutationObserver | null = null;
  private _mode: PlayerMode = 'idle';
  private _sink: SinkState = 'ready';
  private _timer: number;
  private _blinkTimer: number | null = null;
  private _blinkDone = false;
}
