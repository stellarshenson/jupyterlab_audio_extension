import { ServerConnection } from '@jupyterlab/services';

import { PlayerStatus } from '../player-status';

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

/** The player route's makeRequest spy; set its resolved value before each request. */
function mockPlayer(): jest.SpyInstance {
  return jest.spyOn(ServerConnection, 'makeRequest');
}

/** Lets the constructor's status request settle. */
const settle = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, 0));

interface IControls {
  root: HTMLElement;
  play: HTMLButtonElement;
  pause: HTMLButtonElement;
}

function controls(widget: PlayerStatus): IControls {
  return {
    root: widget.node,
    play: widget.node.querySelector(
      '[data-vc-control="play"]'
    ) as HTMLButtonElement,
    pause: widget.node.querySelector(
      '[data-vc-control="pause"]'
    ) as HTMLButtonElement
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('PlayerStatus', () => {
  it('ACC-CTRL-66: shows a play and a pause control beside the microphone status', async () => {
    const request = mockPlayer();
    request.mockResolvedValue(response(IDLE));
    const widget = new PlayerStatus(SETTINGS);
    await settle();

    expect(widget.node.classList.contains('jp-VoiceCapture-status')).toBe(true);
    expect(widget.node.classList.contains('jp-VoiceCapture-playback')).toBe(
      true
    );
    expect(
      widget.node.querySelectorAll('button.jp-VoiceCapture-control')
    ).toHaveLength(2);
    const { play, pause } = controls(widget);
    expect(play.dataset.vcControl).toBe('play');
    expect(pause.dataset.vcControl).toBe('pause');
    expect(play.querySelector('svg')).not.toBeNull();
    expect(pause.querySelector('svg')).not.toBeNull();

    widget.dispose();
  });

  it('ACC-CTRL-67: the play control shows stop while a file plays and play otherwise', async () => {
    const request = mockPlayer();
    request.mockResolvedValue(response(PLAYING));
    const playing = new PlayerStatus(SETTINGS);
    await settle();
    expect(controls(playing).play.dataset.vcFace).toBe('stop');
    expect(controls(playing).root.dataset.vcPlayer).toBe('playing');
    playing.dispose();

    request.mockResolvedValue(response(IDLE));
    const idle = new PlayerStatus(SETTINGS);
    await settle();
    expect(controls(idle).play.dataset.vcFace).toBe('play');
    expect(controls(idle).root.dataset.vcPlayer).toBe('idle');
    idle.dispose();
  });

  it('ACC-CTRL-68: while a file plays both controls are enabled and run the matching player action', async () => {
    const request = mockPlayer();
    request.mockResolvedValue(response(PLAYING));
    const widget = new PlayerStatus(SETTINGS);
    await settle();
    const { play, pause } = controls(widget);
    expect(play.disabled).toBe(false);
    expect(pause.disabled).toBe(false);

    request.mockResolvedValue(response(PAUSED));
    pause.click();
    await settle();
    let [url, init] = request.mock.calls[request.mock.calls.length - 1];
    expect(url).toBe(ROUTE);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ action: 'pause' });
    expect(play.dataset.vcFace).toBe('play');
    expect(play.disabled).toBe(false);
    expect(pause.disabled).toBe(true);

    request.mockResolvedValue(response(PLAYING));
    play.click();
    await settle();
    [, init] = request.mock.calls[request.mock.calls.length - 1];
    expect(JSON.parse(init.body as string)).toEqual({ action: 'resume' });
    widget.dispose();

    request.mockResolvedValue(response(PLAYING));
    const fresh = new PlayerStatus(SETTINGS);
    await settle();
    controls(fresh).play.click();
    await settle();
    [, init] = request.mock.calls[request.mock.calls.length - 1];
    expect(JSON.parse(init.body as string)).toEqual({ action: 'stop' });
    fresh.dispose();
  });

  it('ACC-CTRL-69: both controls are disabled when the player plays nothing', async () => {
    const request = mockPlayer();
    request.mockResolvedValue(response(IDLE));
    const widget = new PlayerStatus(SETTINGS);
    await settle();
    const { play, pause } = controls(widget);
    expect(play.disabled).toBe(true);
    expect(pause.disabled).toBe(true);
    expect(play.dataset.vcFace).toBe('play');

    widget.dispose();
  });

  it('ACC-PLAYER-71/72: a broken sink marks the play control with the error class and the reason in its tooltip', async () => {
    const request = mockPlayer();
    request.mockResolvedValue(response({ ...IDLE, sink: SINK_BROKEN }));
    const widget = new PlayerStatus(SETTINGS);
    await settle();
    const { root, play, pause } = controls(widget);

    expect(play.classList.contains('jp-mod-error')).toBe(true);
    expect(play.title).toBe(`Play - ${SINK_BROKEN.reason}`);
    expect(play.getAttribute('aria-label')).toBe(
      `Play - ${SINK_BROKEN.reason}`
    );
    expect(pause.classList.contains('jp-mod-error')).toBe(false);
    expect(play.dataset.vcFace).toBe('play');
    expect(root.dataset.vcPlayer).toBe('idle');

    widget.dispose();
  });

  it('ACC-CTRL-72: the controls keep reporting the player state while the sink is broken', async () => {
    const request = mockPlayer();
    request.mockResolvedValue(response({ ...PLAYING, sink: SINK_BROKEN }));
    const playing = new PlayerStatus(SETTINGS);
    await settle();
    let { play, pause } = controls(playing);
    expect(play.dataset.vcFace).toBe('stop');
    expect(play.disabled).toBe(false);
    expect(pause.disabled).toBe(false);
    expect(play.title).toBe(`Stop - ${SINK_BROKEN.reason}`);
    playing.dispose();

    request.mockResolvedValue(response({ ...PAUSED, sink: SINK_BROKEN }));
    const paused = new PlayerStatus(SETTINGS);
    await settle();
    ({ play, pause } = controls(paused));
    expect(play.dataset.vcFace).toBe('play');
    expect(play.disabled).toBe(false);
    expect(pause.disabled).toBe(true);
    expect(play.title).toBe(`Resume - ${SINK_BROKEN.reason}`);
    paused.dispose();
  });

  it('ACC-CTRL-72: the error class and the reason clear when the sink recovers', async () => {
    const request = mockPlayer();
    request.mockResolvedValue(response({ ...PLAYING, sink: SINK_BROKEN }));
    const widget = new PlayerStatus(SETTINGS);
    await settle();
    const { play } = controls(widget);
    expect(play.classList.contains('jp-mod-error')).toBe(true);

    request.mockResolvedValue(response(IDLE));
    play.click(); // stop
    await settle();
    expect(play.classList.contains('jp-mod-error')).toBe(false);
    expect(play.title).toBe('Play');

    widget.dispose();
  });
});

describe('PlayerStatus polling', () => {
  it('asks the player for its status every 2 s and stops on dispose', () => {
    jest.useFakeTimers();
    try {
      const request = mockPlayer();
      request.mockResolvedValue(response(IDLE));
      const widget = new PlayerStatus(SETTINGS);
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
