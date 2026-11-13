import { ServerConnection } from '@jupyterlab/services';

import { Signal } from '@lumino/signaling';

import type { AudioCapture, AudioCaptureState } from '../audio-capture';

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

const ROUTE = 'http://localhost/jupyterlab-audio-extension/player';

const SINK_READY = { state: 'ready' };
const SINK_OFF = { state: 'off' };
const SINK_MISSING = { state: 'missing' };

const IDLE = {
  paused: false,
  stopped: false,
  playing: [],
  queue: [],
  sink: SINK_READY
};
const PLAYING = {
  paused: false,
  stopped: false,
  playing: [{ id: 1, path: '/root/media/a.wav', position_s: 1 }],
  queue: [],
  sink: SINK_READY
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
  state: AudioCaptureState = 'idle';
  message = '';
  readonly stateChanged = new Signal<this, AudioCaptureState>(this);
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

/** The leading audio-system lamp's state, read from data-vc-lamp. */
function lamp(widget: VoiceStatus): string | undefined {
  return widget.node.querySelector<HTMLElement>('.jp-Audio-lamp')?.dataset
    .vcLamp;
}

/** The lamp's plain audio-system tooltip; its title and aria-label must agree. */
function lampTitle(widget: VoiceStatus): string {
  const element = widget.node.querySelector<HTMLElement>('.jp-Audio-lamp')!;
  const title = element.title;
  expect(element.getAttribute('aria-label')).toBe(title);
  return title;
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
  state: AudioCaptureState = 'idle',
  message = ''
): { widget: VoiceStatus; model: Model } {
  const model = new Model();
  model.state = state;
  model.message = message;
  return {
    widget: new VoiceStatus(model as unknown as AudioCapture, SETTINGS),
    model
  };
}

describe('VoiceStatus pill', () => {
  it('ACC-CTRL-66: one pill holds the lamp, the microphone, play/stop and pause between dividers', async () => {
    const { widget } = create();
    await settle();

    expect(widget.node.classList.contains('jp-Audio-status')).toBe(true);
    expect(widget.node.classList.contains('jp-Audio-pill')).toBe(true);
    const order = Array.from(widget.node.children).map(el =>
      el.classList.contains('jp-Audio-lamp')
        ? 'lamp'
        : ((el as HTMLElement).dataset.vcControl ?? 'divider')
    );
    expect(order).toEqual([
      'lamp',
      'divider',
      'mic',
      'divider',
      'play',
      'divider',
      'pause'
    ]);
    const lampElement = widget.node.querySelector('.jp-Audio-lamp');
    expect(lampElement).not.toBeNull();
    expect(lampElement!.getAttribute('role')).toBe('img');
    expect(lampElement!.getAttribute('aria-label')).toBe('Audio system ready');
    expect((lampElement as HTMLElement).title).toBe('Audio system ready');
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

  const CASES: ReadonlyArray<[AudioCaptureState, string]> = [
    ['idle', 'Disconnected - Audio capture off - click to start'],
    ['connecting', 'Connecting - Audio capture connecting...'],
    ['streaming', 'Connected - Audio capture on - streaming to server'],
    ['error', 'Error - Audio capture error']
  ];

  it.each(CASES)(
    'ACC-MIC-70-NO-LABEL: %s shows no visible text and the state word in the tooltip',
    async (state, title) => {
      const { widget } = create(state);
      await settle();

      expect(widget.node.textContent).toBe('');
      expect(widget.node.querySelector('.jp-Audio-label')).toBeNull();
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
    expect(mic.className).toBe('jp-Audio-control jp-Audio-mic');
    expect(play.className).toBe('jp-Audio-control');
    expect(pause.className).toBe('jp-Audio-control');
    for (const button of [mic, play, pause]) {
      expect(button.getAttribute('style')).toBeNull();
    }

    model.state = 'streaming';
    model.stateChanged.emit('streaming');
    expect(mic.className).toBe('jp-Audio-control jp-Audio-mic');

    widget.dispose();
  });

  it('ACC-CTRL-75: the microphone segment is a control and shares the player classes', async () => {
    const { widget, model } = create();
    await settle();

    const { root, mic, pause } = controls(widget);
    expect(mic.classList.contains('jp-Audio-control')).toBe(true);
    expect(pause.classList.contains('jp-Audio-control')).toBe(true);
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
    expect(lamp(widget)).toBe('ready');

    widget.dispose();
  });

  it('ACC-CTRL-72/77: a missing sink blinks the amber lamp and a plain tooltip', async () => {
    request.mockImplementation(async () =>
      response({ ...IDLE, sink: SINK_MISSING })
    );
    const widget = create().widget;
    await settle();
    const { root, mic, play, pause } = controls(widget);

    expect(lamp(widget)).toBe('fault');
    expect(lampTitle(widget)).toBe('Audio system unavailable');
    expect(mic.disabled).toBe(false);
    expect(play.classList.contains('jp-mod-error')).toBe(false);
    expect(pause.classList.contains('jp-mod-error')).toBe(false);
    expect(root.classList.contains('jp-mod-sink-error')).toBe(false);
    expect(play.title).toBe('Play - Audio output is unavailable');
    expect(play.getAttribute('aria-label')).toBe(
      'Play - Audio output is unavailable'
    );
    for (const tip of [play.title, play.getAttribute('aria-label') ?? '']) {
      expect(tip).not.toMatch(/fifo|\/|start -d|jupyterlab_audio/i);
    }
    expect(play.dataset.vcFace).toBe('play');
    expect(root.dataset.vcPlayer).toBe('idle');

    widget.dispose();
  });

  it('ACC-CTRL-72: the controls keep reporting the player state while the sink is missing', async () => {
    request.mockImplementation(async () =>
      response({ ...PLAYING, sink: SINK_MISSING })
    );
    const playing = create().widget;
    await settle();
    let { play, pause } = controls(playing);
    expect(play.dataset.vcFace).toBe('stop');
    expect(play.disabled).toBe(false);
    expect(pause.disabled).toBe(false);
    expect(play.title).toBe('Stop - Audio output is unavailable');
    expect(lamp(playing)).toBe('fault');
    playing.dispose();

    request.mockImplementation(async () =>
      response({ ...PAUSED, sink: SINK_MISSING })
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

  it('ACC-CTRL-72: the fault lamp and the plain tooltip clear when the sink recovers', async () => {
    request.mockImplementation(async () =>
      response({ ...PLAYING, sink: SINK_MISSING })
    );
    const widget = create().widget;
    await settle();
    const { play } = controls(widget);
    expect(lamp(widget)).toBe('fault');

    request.mockImplementation(async () => response(IDLE));
    play.click(); // stop
    await settle();
    expect(lamp(widget)).toBe('ready');
    expect(play.title).toBe('Play');

    widget.dispose();
  });
});

describe('VoiceStatus lamp', () => {
  it('ACC-CTRL-78: the ready lamp is filled and both controls are disabled while the player is idle', async () => {
    const { widget } = create();
    await settle();
    const { play, pause } = controls(widget);

    expect(lamp(widget)).toBe('ready');
    expect(lampTitle(widget)).toBe('Audio system ready');
    expect(play.disabled).toBe(true);
    expect(pause.disabled).toBe(true);

    widget.dispose();
  });

  it('ACC-CTRL-78: a file playing turns the lamp active and a pause returns it to ready', async () => {
    request.mockImplementation(async () => response(PLAYING));
    const widget = create().widget;
    await settle();
    const { play, pause } = controls(widget);
    expect(lamp(widget)).toBe('active');
    expect(lampTitle(widget)).toBe('Audio system in use');
    expect(play.disabled).toBe(false);

    request.mockImplementation(async () => response(PAUSED));
    pause.click();
    await settle();
    expect(lamp(widget)).toBe('ready');
    expect(lampTitle(widget)).toBe('Audio system ready');
    expect(play.disabled).toBe(false);
    expect(pause.disabled).toBe(true);

    widget.dispose();
  });

  it('ACC-CTRL-78: a streaming microphone turns the lamp active and connecting does not', async () => {
    const { widget, model } = create();
    await settle();
    expect(lamp(widget)).toBe('ready');
    expect(lampTitle(widget)).toBe('Audio system ready');

    model.state = 'connecting';
    model.stateChanged.emit('connecting');
    expect(lamp(widget)).toBe('ready');
    expect(lampTitle(widget)).toBe('Audio system ready');

    model.state = 'streaming';
    model.stateChanged.emit('streaming');
    expect(lamp(widget)).toBe('active');
    expect(lampTitle(widget)).toBe('Audio system in use');

    // A capture error does not change the lamp.
    model.state = 'error';
    model.stateChanged.emit('error');
    expect(lamp(widget)).toBe('ready');
    expect(lampTitle(widget)).toBe('Audio system ready');

    widget.dispose();
  });

  it('ACC-CTRL-79: a deliberate shutdown is the hollow ring with both controls disabled and the plain shut-down tooltip', async () => {
    request.mockImplementation(async () =>
      response({ ...PLAYING, sink: SINK_OFF })
    );
    const widget = create().widget;
    await settle();
    const { mic, play, pause } = controls(widget);

    expect(lamp(widget)).toBe('off');
    expect(lampTitle(widget)).toBe('Audio system shut down');
    expect(play.disabled).toBe(true);
    expect(pause.disabled).toBe(true);
    expect(mic.disabled).toBe(false);
    expect(play.dataset.vcFace).toBe('stop');
    expect(play.title).toBe('Stop - Audio output is shut down');
    expect(play.getAttribute('aria-label')).toBe(
      'Stop - Audio output is shut down'
    );
    for (const tip of [play.title, play.getAttribute('aria-label') ?? '']) {
      expect(tip).not.toMatch(/fifo|\/|start -d|jupyterlab_audio/i);
    }

    widget.dispose();
  });

  it('ACC-CTRL-95-CROSSED: the pill root mirrors the lamp state and the lamp keeps its own', async () => {
    const { widget, model } = create();
    await settle();
    const lampElement =
      widget.node.querySelector<HTMLElement>('.jp-Audio-lamp')!;

    expect(widget.node.dataset.vcLamp).toBe('ready');
    expect(lampElement.dataset.vcLamp).toBe('ready');

    model.state = 'streaming';
    model.stateChanged.emit('streaming');
    expect(widget.node.dataset.vcLamp).toBe('active');
    expect(lampElement.dataset.vcLamp).toBe('active');
    widget.dispose();

    request.mockImplementation(async () =>
      response({ ...IDLE, sink: SINK_MISSING })
    );
    const missing = create().widget;
    await settle();
    expect(missing.node.dataset.vcLamp).toBe('fault');
    expect(lamp(missing)).toBe('fault');
    expect(
      missing.node.querySelector('.jp-Audio-lamp')!.getAttribute('data-vc-lamp')
    ).toBe('fault');
    missing.dispose();

    request.mockImplementation(async () =>
      response({ ...IDLE, sink: SINK_OFF })
    );
    const off = create().widget;
    await settle();
    expect(off.node.dataset.vcLamp).toBe('off');
    expect(lamp(off)).toBe('off');
    off.dispose();
  });
});

describe('VoiceStatus blink limit', () => {
  it('ACC-CTRL-73: the lamp blinks 30 s, settles to the off ring, and a later break blinks again', async () => {
    jest.useFakeTimers();
    let state: object = { ...PLAYING, sink: SINK_MISSING };
    request.mockImplementation(async () => response(state));

    const widget = create().widget;
    await jest.advanceTimersByTimeAsync(0);
    const { play, pause } = controls(widget);
    expect(lamp(widget)).toBe('fault');
    expect(lampTitle(widget)).toBe('Audio system unavailable');
    expect(play.disabled).toBe(false);
    expect(pause.disabled).toBe(false);

    await jest.advanceTimersByTimeAsync(29999);
    expect(lamp(widget)).toBe('fault');
    expect(lampTitle(widget)).toBe('Audio system unavailable');
    expect(play.disabled).toBe(false);
    expect(pause.disabled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(lamp(widget)).toBe('off');
    expect(lampTitle(widget)).toBe('Audio system unavailable');
    expect(play.disabled).toBe(true);
    expect(pause.disabled).toBe(true);
    expect(play.title).toBe('Stop - Audio output is unavailable');

    // A healthy status ends the episode; a file playing makes the lamp active.
    state = { ...PLAYING, sink: SINK_READY };
    await jest.advanceTimersByTimeAsync(2000);
    expect(lamp(widget)).toBe('active');
    expect(lampTitle(widget)).toBe('Audio system in use');
    expect(play.disabled).toBe(false);
    expect(play.title).toBe('Stop');

    // A break after the recovery starts a new blink.
    state = { ...PLAYING, sink: SINK_MISSING };
    await jest.advanceTimersByTimeAsync(2000);
    expect(lamp(widget)).toBe('fault');
    expect(lampTitle(widget)).toBe('Audio system unavailable');
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
      // DEF-LIFE-19: a poll must not count as activity for the server's idle shutdown.
      for (const [url] of request.mock.calls) {
        expect(url).toBe(`${ROUTE}?no_track_activity=1`);
      }

      widget.dispose();
      jest.advanceTimersByTime(4000);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
