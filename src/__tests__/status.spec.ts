import { ServerConnection } from '@jupyterlab/services';

import { Signal } from '@lumino/signaling';

import type { VoiceCapture, VoiceCaptureState } from '../voice-capture';

import { VoiceStatus } from '../status';

// ui-components pulls ESM-only @jupyter/react-components, which Jest cannot load.
jest.mock('@jupyterlab/ui-components', () => ({
  LabIcon: class {
    element({ container }: { container: HTMLElement }): HTMLElement {
      container.appendChild(
        document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      );
      return container;
    }
  }
}));

/** jsdom has no server: the player route answers from these fixtures. */
const SETTINGS = {
  wsUrl: 'ws://localhost/',
  baseUrl: 'http://localhost/',
  token: 'secret-token'
} as any;

const ROUTE = 'http://localhost/jupyterlab-voice-capture-extension/player';

const SINK_OK = { ok: true, reason: '' };
const SINK_BROKEN = {
  ok: false,
  reason:
    'Speaker FIFO /run/voice/speaker.fifo is missing; run: jupyterlab_voice_capture start -d'
};

const IDLE = {
  paused: false,
  stopped: false,
  playing: [],
  queue: [],
  sink: SINK_OK
};
const PLAYING = {
  paused: false,
  stopped: false,
  playing: [{ id: 1, path: '/root/media/a.wav', position_s: 1 }],
  queue: [],
  sink: SINK_OK
};
const PAUSED = { ...PLAYING, paused: true };

function response(state: object): Response {
  return new Response(JSON.stringify(state), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

/** Lets the constructor's status request settle. */
const settle = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, 0));

/** The model surface VoiceStatus reads; state and message are set per case. */
class Model {
  state: VoiceCaptureState = 'idle';
  message = '';
  readonly stateChanged = new Signal<this, VoiceCaptureState>(this);
  readonly toggle = jest.fn();
}

interface IControls {
  root: HTMLElement;
  mic: HTMLButtonElement;
  play: HTMLButtonElement;
  pause: HTMLButtonElement;
}

function controls(widget: VoiceStatus): IControls {
  return {
    root: widget.node,
    mic: widget.node.querySelector(
      '[data-vc-control="mic"]'
    ) as HTMLButtonElement,
    play: widget.node.querySelector(
      '[data-vc-control="play"]'
    ) as HTMLButtonElement,
    pause: widget.node.querySelector(
      '[data-vc-control="pause"]'
    ) as HTMLButtonElement
  };
}

/** The sink warning dot inside the play control. */
function dot(play: HTMLButtonElement): HTMLSpanElement {
  return play.querySelector('.jp-VoiceCapture-dot') as HTMLSpanElement;
}

let request: jest.SpyInstance;

beforeEach(() => {
  request = jest.spyOn(ServerConnection, 'makeRequest');
  request.mockImplementation(async () => response(IDLE));
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function create(
  state: VoiceCaptureState = 'idle',
  message = ''
): { widget: VoiceStatus; model: Model } {
  const model = new Model();
  model.state = state;
  model.message = message;
  return {
    widget: new VoiceStatus(model as unknown as VoiceCapture, SETTINGS),
    model
  };
}

describe('VoiceStatus pill', () => {
  it('ACC-CTRL-66: one pill holds the microphone, play/stop and pause between dividers', async () => {
    const { widget } = create();
    await settle();

    expect(widget.node.classList.contains('jp-VoiceCapture-status')).toBe(true);
    expect(widget.node.classList.contains('jp-VoiceCapture-pill')).toBe(true);
    const order = Array.from(widget.node.children).map(
      el => (el as HTMLElement).dataset.vcControl ?? 'divider'
    );
    expect(order).toEqual(['mic', 'divider', 'play', 'divider', 'pause']);
    const { mic, play, pause } = controls(widget);
    expect(mic.querySelector('svg')).not.toBeNull();
    expect(play.querySelector('svg')).not.toBeNull();
    expect(pause.querySelector('svg')).not.toBeNull();

    widget.dispose();
  });

  it('ACC-CTRL-66: the microphone segment toggles capture through the model', async () => {
    const { widget, model } = create();
    await settle();

    controls(widget).mic.click();
    expect(model.toggle).toHaveBeenCalledTimes(1);

    widget.dispose();
  });

  const CASES: ReadonlyArray<[VoiceCaptureState, string]> = [
    ['idle', 'Disconnected - Voice capture off - click to start'],
    ['connecting', 'Connecting - Voice capture connecting...'],
    ['streaming', 'Connected - Voice capture on - streaming to server'],
    ['error', 'Error - Voice capture error']
  ];

  it.each(CASES)(
    'ACC-MIC-70-NO-LABEL: %s shows no visible text and the state word in the tooltip',
    async (state, title) => {
      const { widget } = create(state);
      await settle();

      expect(widget.node.textContent).toBe('');
      expect(widget.node.querySelector('.jp-VoiceCapture-label')).toBeNull();
      expect(widget.node.title).toBe(title);
      expect(widget.node.dataset.vcState).toBe(state);
      expect(widget.node.classList.contains(`jp-mod-${state}`)).toBe(true);
      expect(controls(widget).mic.title).toBe(title);

      widget.dispose();
    }
  );

  it('ACC-MIC-70-NO-LABEL: the error tooltip puts the model message after the state word', async () => {
    const { widget } = create('error', 'Microphone permission denied.');
    await settle();

    expect(widget.node.title).toBe('Error - Microphone permission denied.');
    expect(controls(widget).mic.title).toBe(
      'Error - Microphone permission denied.'
    );

    widget.dispose();
  });

  it('ACC-CTRL-74: the controls carry no background tint class', async () => {
    const { widget, model } = create();
    await settle();

    const { mic, play, pause } = controls(widget);
    expect(mic.className).toBe('jp-VoiceCapture-control jp-VoiceCapture-mic');
    expect(play.className).toBe('jp-VoiceCapture-control');
    expect(pause.className).toBe('jp-VoiceCapture-control');
    for (const button of [mic, play, pause]) {
      expect(button.getAttribute('style')).toBeNull();
    }

    model.state = 'streaming';
    model.stateChanged.emit('streaming');
    expect(mic.className).toBe('jp-VoiceCapture-control jp-VoiceCapture-mic');

    widget.dispose();
  });

  it('ACC-CTRL-75: the microphone segment is a control and shares the player classes', async () => {
    const { widget, model } = create();
    await settle();

    const { root, mic, pause } = controls(widget);
    expect(mic.classList.contains('jp-VoiceCapture-control')).toBe(true);
    expect(pause.classList.contains('jp-VoiceCapture-control')).toBe(true);
    // The idle pill paints the microphone in the control grey; the segment itself stays
    // clickable because it is a toggle, not a player control.
    expect(mic.disabled).toBe(false);
    expect(root.classList.contains('jp-mod-idle')).toBe(true);

    model.state = 'streaming';
    model.stateChanged.emit('streaming');
    expect(root.classList.contains('jp-mod-streaming')).toBe(true);
    expect(root.classList.contains('jp-mod-idle')).toBe(false);

    widget.dispose();
  });
});

describe('VoiceStatus player controls', () => {
  it('ACC-CTRL-67: the play control shows stop while a file plays and play otherwise', async () => {
    request.mockImplementation(async () => response(PLAYING));
    const playing = create().widget;
    await settle();
    expect(controls(playing).play.dataset.vcFace).toBe('stop');
    expect(controls(playing).root.dataset.vcPlayer).toBe('playing');
    playing.dispose();

    request.mockImplementation(async () => response(IDLE));
    const idle = create().widget;
    await settle();
    expect(controls(idle).play.dataset.vcFace).toBe('play');
    expect(controls(idle).root.dataset.vcPlayer).toBe('idle');
    idle.dispose();
  });

  it('ACC-CTRL-68: while a file plays both controls are enabled and run the matching player action', async () => {
    request.mockImplementation(async () => response(PLAYING));
    const widget = create().widget;
    await settle();
    const { play, pause } = controls(widget);
    expect(play.disabled).toBe(false);
    expect(pause.disabled).toBe(false);

    request.mockImplementation(async () => response(PAUSED));
    pause.click();
    await settle();
    let [, init] = request.mock.calls[request.mock.calls.length - 1];
    expect(request.mock.calls[request.mock.calls.length - 1][0]).toBe(ROUTE);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ action: 'pause' });
    expect(play.dataset.vcFace).toBe('play');
    expect(play.disabled).toBe(false);
    expect(pause.disabled).toBe(true);

    request.mockImplementation(async () => response(PLAYING));
    play.click();
    await settle();
    [, init] = request.mock.calls[request.mock.calls.length - 1];
    expect(JSON.parse(init.body as string)).toEqual({ action: 'resume' });
    widget.dispose();

    request.mockImplementation(async () => response(PLAYING));
    const fresh = create().widget;
    await settle();
    controls(fresh).play.click();
    await settle();
    [, init] = request.mock.calls[request.mock.calls.length - 1];
    expect(JSON.parse(init.body as string)).toEqual({ action: 'stop' });
    fresh.dispose();
  });

  it('ACC-CTRL-69: both controls are disabled when the player plays nothing', async () => {
    const widget = create().widget;
    await settle();
    const { play, pause } = controls(widget);
    expect(play.disabled).toBe(true);
    expect(pause.disabled).toBe(true);
    expect(play.dataset.vcFace).toBe('play');
    expect(dot(play).hidden).toBe(true);

    widget.dispose();
  });

  it('ACC-CTRL-72/77: a broken sink blinks an amber dot and a plain tooltip', async () => {
    request.mockImplementation(async () =>
      response({ ...IDLE, sink: SINK_BROKEN })
    );
    const widget = create().widget;
    await settle();
    const { root, play, pause } = controls(widget);
    const warning = dot(play);

    expect(warning).not.toBeNull();
    expect(warning.getAttribute('aria-hidden')).toBe('true');
    expect(warning.hidden).toBe(false);
    expect(warning.classList.contains('jp-mod-blink')).toBe(true);
    expect(play.classList.contains('jp-mod-error')).toBe(false);
    expect(pause.classList.contains('jp-mod-error')).toBe(false);
    expect(root.classList.contains('jp-mod-sink-error')).toBe(false);
    expect(pause.classList.contains('jp-mod-blink')).toBe(false);
    expect(play.title).toBe('Play - Audio output is unavailable');
    expect(play.getAttribute('aria-label')).toBe(
      'Play - Audio output is unavailable'
    );
    expect(play.title).not.toMatch(
      /fifo|\/|start -d|jupyterlab_voice_capture/i
    );
    expect(play.dataset.vcFace).toBe('play');
    expect(root.dataset.vcPlayer).toBe('idle');

    widget.dispose();
  });

  it('ACC-CTRL-72: the controls keep reporting the player state while the sink is broken', async () => {
    request.mockImplementation(async () =>
      response({ ...PLAYING, sink: SINK_BROKEN })
    );
    const playing = create().widget;
    await settle();
    let { play, pause } = controls(playing);
    expect(play.dataset.vcFace).toBe('stop');
    expect(play.disabled).toBe(false);
    expect(pause.disabled).toBe(false);
    expect(play.title).toBe('Stop - Audio output is unavailable');
    expect(dot(play).hidden).toBe(false);
    playing.dispose();

    request.mockImplementation(async () =>
      response({ ...PAUSED, sink: SINK_BROKEN })
    );
    const paused = create().widget;
    await settle();
    ({ play, pause } = controls(paused));
    expect(play.dataset.vcFace).toBe('play');
    expect(play.disabled).toBe(false);
    expect(pause.disabled).toBe(true);
    expect(play.title).toBe('Resume - Audio output is unavailable');
    paused.dispose();
  });

  it('ACC-CTRL-72: the dot and the plain tooltip clear when the sink recovers', async () => {
    request.mockImplementation(async () =>
      response({ ...PLAYING, sink: SINK_BROKEN })
    );
    const widget = create().widget;
    await settle();
    const { play } = controls(widget);
    expect(dot(play).hidden).toBe(false);

    request.mockImplementation(async () => response(IDLE));
    play.click(); // stop
    await settle();
    expect(dot(play).hidden).toBe(true);
    expect(dot(play).classList.contains('jp-mod-blink')).toBe(false);
    expect(play.title).toBe('Play');

    widget.dispose();
  });
});

describe('VoiceStatus blink limit', () => {
  it('ACC-CTRL-73: the dot blinks 30 s, disappears, and a later break blinks again', async () => {
    jest.useFakeTimers();
    let state: object = { ...PLAYING, sink: SINK_BROKEN };
    request.mockImplementation(async () => response(state));

    const widget = create().widget;
    await jest.advanceTimersByTimeAsync(0);
    const { play, pause } = controls(widget);
    const warning = dot(play);
    expect(warning.hidden).toBe(false);
    expect(warning.classList.contains('jp-mod-blink')).toBe(true);
    expect(play.disabled).toBe(false);
    expect(pause.disabled).toBe(false);

    await jest.advanceTimersByTimeAsync(29999);
    expect(warning.hidden).toBe(false);
    expect(warning.classList.contains('jp-mod-blink')).toBe(true);
    expect(play.disabled).toBe(false);
    expect(pause.disabled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(warning.hidden).toBe(true);
    expect(warning.classList.contains('jp-mod-blink')).toBe(false);
    expect(play.disabled).toBe(true);
    expect(pause.disabled).toBe(true);
    expect(play.title).toBe('Stop - Audio output is unavailable');

    // A healthy status ends the episode.
    state = { ...PLAYING };
    await jest.advanceTimersByTimeAsync(2000);
    expect(warning.hidden).toBe(true);
    expect(play.disabled).toBe(false);
    expect(play.title).toBe('Stop');

    // A break after the recovery starts a new blink.
    state = { ...PLAYING, sink: SINK_BROKEN };
    await jest.advanceTimersByTimeAsync(2000);
    expect(warning.hidden).toBe(false);
    expect(warning.classList.contains('jp-mod-blink')).toBe(true);
    expect(play.disabled).toBe(false);

    widget.dispose();
  });
});

describe('VoiceStatus polling', () => {
  it('asks the player for its status every 2 s and stops on dispose', () => {
    jest.useFakeTimers();
    try {
      const widget = create().widget;
      expect(request).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(2000);
      expect(request).toHaveBeenCalledTimes(2);

      widget.dispose();
      jest.advanceTimersByTime(4000);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
