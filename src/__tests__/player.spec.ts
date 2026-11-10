import { ServerConnection } from '@jupyterlab/services';

import plugin from '../index';

// The plugin without the speaker, the status widget and the modules Jest cannot load,
// which the plugin imports only for their tokens, as in voice-capture.spec.ts.
jest.mock('@jupyterlab/apputils', () => ({}));
jest.mock('@jupyterlab/statusbar', () => ({}));
jest.mock('../speaker', () => ({
  Speaker: class {
    async start(): Promise<void> {}
  }
}));
jest.mock('../status', () => ({}));

/** jsdom has no BroadcastChannel: records every channel the plugin opens. */
class FakeBroadcastChannel {
  static names: string[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly name: string) {
    FakeBroadcastChannel.names.push(name);
  }
  postMessage(): void {}
}

const SETTINGS = {
  wsUrl: 'ws://localhost/',
  baseUrl: 'http://localhost/',
  token: 'secret-token'
} as any;

const PLAYER = 'voice-capture:player';
const STATE = {
  paused: false,
  stopped: false,
  playing: [{ id: 1, path: '/root/media/a.wav', position_s: 1.5 }],
  queue: [{ id: 2, path: '/root/media/b.wav' }]
};

/** Activates the plugin and returns its command table and palette. */
function activate(): { commands: Map<string, any>; palette: any } {
  const commands = new Map<string, any>();
  const palette = { addItem: jest.fn() };
  plugin.activate(
    {
      commands: {
        addCommand: (id: string, options: any) => commands.set(id, options)
      },
      serviceManager: { serverSettings: SETTINGS }
    } as any,
    palette as any,
    null,
    null
  );
  return { commands, palette };
}

beforeEach(() => {
  FakeBroadcastChannel.names = [];
  (globalThis as any).BroadcastChannel = FakeBroadcastChannel as any;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('voice-capture:player', () => {
  it('posts the action to the player route and returns the state', async () => {
    const request = jest
      .spyOn(ServerConnection, 'makeRequest')
      .mockResolvedValue(
        new Response(JSON.stringify(STATE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );
    const { commands } = activate();
    const args = { action: 'play', mode: 'now', path: 'media/a.wav' };

    const state = await commands.get(PLAYER).execute(args);

    expect(state).toEqual(STATE);
    expect(request).toHaveBeenCalledTimes(1);
    const [[url, init]] = request.mock.calls;
    expect(url).toBe(
      'http://localhost/jupyterlab-voice-capture-extension/player'
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(args);
  });

  it('documents every action and mode in describedBy', () => {
    const { commands } = activate();
    const described = commands.get(PLAYER).describedBy;
    expect(described.args.required).toEqual(['action']);
    expect(described.args.properties.action.enum).toEqual([
      'play',
      'pause',
      'resume',
      'stop',
      'clear',
      'status'
    ]);
    expect(described.args.properties.mode.enum).toEqual(['queue', 'now']);
  });

  it('a refused action rejects with the message the route named', async () => {
    jest
      .spyOn(ServerConnection, 'makeRequest')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ message: 'Cannot play missing.wav: no such file' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      );
    const { commands } = activate();

    await expect(
      commands.get(PLAYER).execute({ action: 'play', path: 'missing.wav' })
    ).rejects.toThrow('Cannot play missing.wav');
  });
});

describe('Stop All Audio', () => {
  it('is a palette entry that runs the player with action stop', () => {
    const { commands, palette } = activate();
    const item = palette.addItem.mock.calls
      .map((call: any[]) => call[0])
      .find((options: any) => options.command === PLAYER);

    expect(item).toBeDefined();
    expect(item.args).toEqual({ action: 'stop' });
    expect(item.category).toBe('Voice Capture');
    const label = commands.get(PLAYER).label;
    expect(label({ action: 'stop' })).toBe('Stop All Audio');
    expect(label()).toBe('Audio Player'); // the relay reads the label with no args
  });
});

describe('retired commands', () => {
  it('registers the player and neither play-file nor stop-playback', () => {
    const { commands } = activate();
    expect(commands.has(PLAYER)).toBe(true);
    expect(commands.has('voice-capture:play-file')).toBe(false);
    expect(commands.has('voice-capture:stop-playback')).toBe(false);
    expect(
      FakeBroadcastChannel.names.some(name => name.includes('stop-playback'))
    ).toBe(false);
  });
});
