import {
  ToolbarWidgetRegistry,
  createDefaultFactory
} from '@jupyterlab/apputils';

import { ServerConnection } from '@jupyterlab/services';

import { SettingRegistry } from '@jupyterlab/settingregistry';

import { CommandRegistry } from '@lumino/commands';

import { Signal } from '@lumino/signaling';

import { Widget } from '@lumino/widgets';

import cardsSchema from '../../schema/cards.json';

import type { AudioCapture, AudioCaptureState } from '../audio-capture';

import { createCards } from '../cards';

import { AudioSettings } from '../settings';

import { VoiceStatus } from '../status';

/** jsdom has no server: the player route answers from these fixtures. */
const SETTINGS = {
  wsUrl: 'ws://localhost/',
  baseUrl: 'http://localhost/',
  token: 'secret-token'
} as any;

const FIFO = '/run/voice/pulseaudio.fifo';
const IDLE = {
  paused: false,
  playing: [] as object[],
  sink: { state: 'ready' },
  capture: FIFO
};
const PLAYING = { ...IDLE, playing: [{ id: 1 }] };

/** The settings plugin of the tab and the card list. */
const PLUGIN_ID = '@stellarshenson/jupyterlab-audio-extension:plugin';
const CARDS_ID = '@stellarshenson/jupyterlab-audio-extension:cards';

/** The plugin schema the tab binds, with the fields of schema/plugin.json. */
const PLUGIN_SCHEMA = {
  type: 'object',
  properties: {
    autoConnect: {
      type: 'boolean',
      title: 'Auto-connect on startup',
      description:
        'Start microphone capture automatically when JupyterLab loads. Off by default - capture normally begins only when you click the status-bar microphone.',
      default: false
    },
    toolbar: {
      type: 'array',
      items: { type: 'object' },
      default: []
    }
  }
};

/** Lets the status request settle. */
const settle = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, 0));

/** Waits, for one second at most, until done() holds. */
async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !done(); tries++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** The model surface VoiceStatus reads. */
class Model {
  state: AudioCaptureState = 'idle';
  message = '';
  readonly stateChanged = new Signal<this, AudioCaptureState>(this);
  readonly toggle = jest.fn();
  readonly enable = jest.fn();
}

let model: Model;
let status: VoiceStatus;
let tab: AudioSettings | null = null;
let opened: jest.Mock;

/** The pill on the page; the player route answers state. */
async function createStatus(state: object = IDLE): Promise<void> {
  jest.spyOn(ServerConnection, 'makeRequest').mockImplementation(
    async () =>
      new Response(JSON.stringify(state), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
  );
  model = new Model();
  opened = jest.fn();
  status = new VoiceStatus(model as unknown as AudioCapture, SETTINGS, opened);
  Widget.attach(status, document.body);
  await settle();
}

/** The Audio Settings tab, built on the pill's status. */
async function createTab(
  options: { registry?: SettingRegistry | null; cards?: () => Widget } = {}
): Promise<void> {
  tab = new AudioSettings(status, options.registry ?? null, options.cards);
  Widget.attach(tab, document.body);
}

async function create(
  state: object = IDLE,
  options: { registry?: SettingRegistry | null; cards?: () => Widget } = {}
): Promise<void> {
  await createStatus(state);
  await createTab(options);
}

afterEach(() => {
  tab?.dispose();
  tab = null;
  status.dispose();
  jest.restoreAllMocks();
});

function gear(): HTMLButtonElement {
  return status.node.querySelector('[data-vc-control="gear"]')!;
}

function root(): HTMLElement {
  return tab!.node;
}

function board(): HTMLElement {
  return root().querySelector('.jp-AudioSettings-board')!;
}

/** The value the Audio system card shows in one row. */
function row(name: string): string | null {
  return (
    root().querySelector(`[data-vc-summary="${name}"]`)?.textContent ?? null
  );
}

function switchInput(): HTMLInputElement {
  return root().querySelector('.jp-AudioSettings-switchInput')!;
}

function settingDescription(): HTMLElement {
  return root().querySelector('.jp-AudioSettings-settingDescription')!;
}

function toolbarList(): HTMLElement {
  return root().querySelector('.jp-AudioSettings-toolbar')!;
}

function emptyCard(): HTMLElement {
  return root().querySelector('.jp-AudioSettings-emptyCard')!;
}

/** The cards the board shows, top to bottom, in DOM order. */
function cards(): HTMLElement[] {
  return Array.from(
    root().querySelectorAll<HTMLElement>('.jp-AudioSettings-card')
  ).filter(node => !node.hidden && !node.classList.contains('lm-mod-hidden'));
}

function titles(): string[] {
  return cards().map(
    node =>
      node.querySelector('.jp-AudioSettings-cardHeader')?.textContent ??
      node.textContent!
  );
}

const CORE = ['Audio system', 'Capture', 'Status bar'];

describe('VoiceStatus gear', () => {
  it('ACC-CTRL-99-GEAR: the gear ends the pill and calls the open-settings callback', async () => {
    await createStatus();
    const children = Array.from(status.node.children);

    expect(children[children.length - 1]).toBe(gear());
    expect(
      children[children.length - 2].classList.contains('jp-Audio-divider')
    ).toBe(true);
    expect(gear().getAttribute('aria-label')).toBe('Audio settings');
    expect(gear().hasAttribute('aria-haspopup')).toBe(false);
    expect(gear().hasAttribute('aria-expanded')).toBe(false);
    expect(status.node.querySelector('.jp-AudioSettings')).toBeNull();

    gear().click();
    expect(opened).toHaveBeenCalledTimes(1);
    // A second click never closes anything: the callback is asked again and the tab stays.
    gear().click();
    expect(opened).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.jp-AudioSettings')).toBeNull();
  });
});

describe('AudioSettings tab board', () => {
  it('ACC-CTRL-106-BOARD: the tab holds the page heading, the four core cards and the footer', async () => {
    await create();

    expect(root().querySelector('h1')!.textContent).toBe('Audio Settings');
    expect(
      root().querySelector('.jp-AudioSettings-subtitle')!.textContent
    ).toBe('Microphone capture and playback. Changes save immediately.');
    const sections = Array.from(board().children).filter(node =>
      node.classList.contains('jp-AudioSettings-card')
    );
    expect(sections.map(card => cardToken(card as HTMLElement))).toEqual([
      ...CORE,
      'Panel cards'
    ]);
    expect(titles()).toEqual([...CORE, 'Panel cards']);
    expect(
      root().querySelector('.jp-AudioSettings-footer')!.textContent
    ).toContain(
      'Raw values: Settings Editor > Audio Capture and Audio Settings Panel.'
    );
  });

  it('ACC-CTRL-99-TAB: the tab disposes with the status widget and stops following it', async () => {
    await create();
    const microphone = root().querySelector('[data-vc-summary="microphone"]')!;
    expect(microphone.textContent).toBe('Not capturing');

    status.dispose();
    expect(tab!.isDisposed).toBe(true);
    model.state = 'streaming';
    model.stateChanged.emit('streaming');
    await settle();
    expect(microphone.textContent).toBe('Not capturing');
  });

  it('ACC-CTRL-99-TAB: closing the tab disposes it', async () => {
    await create();

    tab!.close();
    expect(tab!.isDisposed).toBe(true);
  });
});

/** The header text of a card, or its text for another extension's headerless card. */
function cardToken(card: HTMLElement): string {
  return (
    card.querySelector('.jp-AudioSettings-cardHeader')?.textContent ??
    card.textContent!
  );
}

describe('AudioSettings Audio system card', () => {
  it('ACC-CTRL-100-SUMMARY: the card states the audio system, microphone, playback and destination', async () => {
    await create();

    expect(row('audioSystem')).toBe('Ready');
    expect(row('microphone')).toBe('Not capturing');
    expect(row('playback')).toBe('Nothing playing');
    expect(row('delivery')).toBe(FIFO);
  });

  it('ACC-CTRL-100-SUMMARY: the card follows the microphone and the audio system', async () => {
    await create();
    const turn = (state: AudioCaptureState, message = ''): void => {
      model.state = state;
      model.message = message;
      model.stateChanged.emit(state);
    };

    turn('connecting');
    expect(row('microphone')).toBe('Connecting');
    expect(row('audioSystem')).toBe('Ready');
    turn('streaming');
    expect(row('microphone')).toBe('Capturing');
    expect(row('audioSystem')).toBe('In use');
    turn('error', 'Microphone permission denied.');
    expect(row('microphone')).toBe('Microphone permission denied.');
    expect(row('audioSystem')).toBe('Ready');
    turn('error');
    expect(row('microphone')).toBe('Error');
    turn('idle');
    expect(row('microphone')).toBe('Not capturing');
  });

  it('ACC-CTRL-100-SUMMARY: a playing file puts the audio system in use', async () => {
    await create(PLAYING);

    expect(row('audioSystem')).toBe('In use');
    expect(row('playback')).toBe('Playing');
  });

  it.each([
    [
      'a missing speaker sink',
      { ...IDLE, sink: { state: 'missing' } },
      'Unavailable',
      'Audio output is unavailable'
    ],
    [
      'a shut-down speaker sink',
      { ...PLAYING, sink: { state: 'off' } },
      'Shut down',
      'Audio output is shut down'
    ]
  ])(
    'ACC-CTRL-100-SUMMARY: the card states the audio system and playback for %s',
    async (_, state, audioSystem, playback) => {
      await create(state);

      expect(row('audioSystem')).toBe(audioSystem);
      expect(row('playback')).toBe(playback);
    }
  );

  it('ACC-CTRL-100-SUMMARY: the card follows the player', async () => {
    await create(PLAYING);
    expect(row('playback')).toBe('Playing');

    jest.spyOn(ServerConnection, 'makeRequest').mockImplementation(
      async () =>
        new Response(JSON.stringify(IDLE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    );
    // The stop button asks the player and paints its answer, as the 2 s poll does.
    status.node
      .querySelector<HTMLButtonElement>('[data-vc-control="play"]')!
      .dispatchEvent(new MouseEvent('click'));
    await settle();
    expect(row('playback')).toBe('Nothing playing');
    expect(row('audioSystem')).toBe('Ready');
  });

  it('ACC-CTRL-100-SUMMARY: a server that does not report the capture FIFO leaves the target unknown', async () => {
    const { capture, ...old } = IDLE;
    await create(old);

    expect(capture).toBe(FIFO);
    expect(row('delivery')).toBe('Unknown');
  });
});

describe('AudioSettings Capture card', () => {
  let settingRegistry: SettingRegistry;
  let toolbarRegistry: ToolbarWidgetRegistry;

  function plugin(id: string, schema: object): any {
    return {
      id,
      schema,
      raw: '{}',
      data: { composite: {}, user: {} },
      version: '1.0.0'
    };
  }

  /** Another extension's settings schema that adds cards through "AudioSettings". */
  function contributor(id: string, cards: object[]): any {
    return plugin(id, {
      type: 'object',
      properties: {},
      'jupyter.lab.toolbars': { AudioSettings: cards }
    });
  }

  /** A card widget as another extension's factory returns it. */
  function card(title: string): Widget {
    const widget = new Widget();
    widget.addClass('jp-AudioSettings-card');
    widget.node.textContent = title;
    return widget;
  }

  /** The registries of a JupyterLab that holds the given extensions' schemas. */
  function registries(contributors: any[], holdCards = false): void {
    const raws = new Map<string, string>();
    let release = (): void => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    releaseCards = release;
    const plugins = [plugin(PLUGIN_ID, PLUGIN_SCHEMA), ...contributors];
    settingRegistry = new SettingRegistry({
      connector: {
        fetch: async (id: string) => {
          if (id === CARDS_ID && holdCards) {
            await gate;
          }
          const item =
            id === CARDS_ID
              ? plugin(CARDS_ID, cardsSchema)
              : plugins.find(value => value.id === id);
          return item && { ...item, raw: raws.get(id) ?? item.raw };
        },
        list: async () => ({ ids: [], values: [] }),
        save: async (id: string, raw: string) => {
          raws.set(id, raw);
        },
        remove: async () => undefined
      } as any,
      plugins
    });
    toolbarRegistry = new ToolbarWidgetRegistry({
      defaultFactory: createDefaultFactory(new CommandRegistry())
    });
  }

  let releaseCards: () => void = () => undefined;

  it('ACC-CTRL-107-AUTOCONNECT: the switch reads the setting, saves it and follows a later change', async () => {
    registries([]);
    await create(IDLE, { registry: settingRegistry });
    const settings = await settingRegistry.load(PLUGIN_ID);
    await until(() =>
      settingDescription().textContent!.includes(
        'Start microphone capture automatically'
      )
    );

    expect(switchInput().disabled).toBe(false);
    expect(switchInput().checked).toBe(false);
    switchInput().checked = true;
    switchInput().dispatchEvent(new Event('change'));
    await until(() => settings.get('autoConnect').composite === true);
    expect(settings.get('autoConnect').composite).toBe(true);

    // A later change, as the Settings Editor makes it, updates the switch.
    await settings.set('autoConnect', false);
    await until(() => switchInput().checked === false);
    expect(switchInput().checked).toBe(false);

    // The switch starts no capture now.
    expect(model.enable).not.toHaveBeenCalled();
    expect(model.toggle).not.toHaveBeenCalled();
  });

  it('ACC-CTRL-106-BOARD: the Status bar card lists each pill item or No items', async () => {
    registries([]);
    await create(IDLE, { registry: settingRegistry });
    const settings = await settingRegistry.load(PLUGIN_ID);
    await until(() => toolbarList().textContent === 'No items');
    expect(
      toolbarList().querySelector('.jp-AudioSettings-empty')!.textContent
    ).toBe('No items');
    expect(
      root().querySelector('.jp-AudioSettings-hint')!.textContent
    ).toContain('Settings Editor > Audio Capture');

    await settings.set('toolbar', [
      { name: 'slot-item', command: 'audio:toggle' }
    ]);
    await until(
      () => toolbarList().querySelectorAll('.jp-AudioSettings-row').length === 1
    );
    const item = toolbarList().querySelector('.jp-AudioSettings-row')!;
    expect(item.querySelector('.jp-AudioSettings-label')!.textContent).toBe(
      'slot-item'
    );
    expect(item.querySelector('.jp-AudioSettings-value')!.textContent).toBe(
      'audio:toggle'
    );
    expect(toolbarList().querySelector('.jp-AudioSettings-empty')).toBeNull();
  });

  it('ACC-CTRL-101-CARDS: extension cards are tiles of the board in rank order', async () => {
    registries([
      contributor('late:plugin', [{ name: 'late', rank: 30 }]),
      contributor('early:plugin', [{ name: 'early', rank: 10 }])
    ]);
    toolbarRegistry.addFactory('AudioSettings', 'late', () => card('Late'));
    toolbarRegistry.addFactory('AudioSettings', 'early', () => card('Early'));
    await create(IDLE, {
      registry: settingRegistry,
      cards: createCards(toolbarRegistry, settingRegistry)
    });
    await settingRegistry.load(CARDS_ID);
    await until(() => titles().includes('Early'));

    expect(titles()).toEqual([...CORE, 'Early', 'Late']);
    // The empty Panel cards card hides while an extension card shows.
    expect(emptyCard().hidden).toBe(true);
  });

  it('ACC-CTRL-101-CARDS: cards whose list loads after the tab opened appear in it', async () => {
    registries(
      [contributor('early:plugin', [{ name: 'early', rank: 10 }])],
      true
    );
    toolbarRegistry.addFactory('AudioSettings', 'early', () => card('Early'));
    await create(IDLE, {
      registry: settingRegistry,
      cards: createCards(toolbarRegistry, settingRegistry)
    });

    expect(titles()).toEqual([...CORE, 'Panel cards']);
    expect(emptyCard().hidden).toBe(false);

    releaseCards();
    await settingRegistry.load(CARDS_ID);
    await until(() => titles().includes('Early'));
    expect(titles()).toEqual([...CORE, 'Early']);
    expect(emptyCard().hidden).toBe(true);
  });

  it('ACC-CTRL-101-CARDS: a disposed card leaves the board and the empty card returns', async () => {
    registries([contributor('early:plugin', [{ name: 'early', rank: 10 }])]);
    const made: Widget[] = [];
    toolbarRegistry.addFactory('AudioSettings', 'early', () => {
      made.push(card('Early'));
      return made[made.length - 1];
    });
    await create(IDLE, {
      registry: settingRegistry,
      cards: createCards(toolbarRegistry, settingRegistry)
    });
    await settingRegistry.load(CARDS_ID);
    await until(() => titles().includes('Early'));
    expect(titles()).toEqual([...CORE, 'Early']);

    made[0].dispose();
    await until(() => !titles().includes('Early'));
    expect(titles()).toEqual([...CORE, 'Panel cards']);
    expect(emptyCard().hidden).toBe(false);
  });

  it('ACC-CTRL-101-CARDS: an extension that is absent or registered no card adds nothing', async () => {
    // "gone" names a card whose extension registered no factory, as a disabled one does not.
    registries([contributor('gone:plugin', [{ name: 'gone', rank: 10 }])]);
    await create(IDLE, {
      registry: settingRegistry,
      cards: createCards(toolbarRegistry, settingRegistry)
    });
    await settingRegistry.load(CARDS_ID);
    await settle();

    expect(titles()).toEqual([...CORE, 'Panel cards']);
    expect(emptyCard().hidden).toBe(false);
    const absent = root().querySelector('.jp-AudioSettings-cards')!;
    expect(absent.children).toHaveLength(1);
    expect(absent.children[0].classList.contains('lm-mod-hidden')).toBe(true);

    // The extension registers its card while the tab is open: the card takes the place.
    toolbarRegistry.addFactory('AudioSettings', 'gone', () => card('Back'));
    await until(() => titles().includes('Back'));
    expect(titles()).toEqual([...CORE, 'Back']);
    expect(emptyCard().hidden).toBe(true);
  });

  it('ACC-CTRL-101-CARDS: without the registries the board holds the core cards alone', async () => {
    await create();

    expect(switchInput().disabled).toBe(true);
    expect(
      toolbarList().querySelector('.jp-AudioSettings-empty')!.textContent
    ).toBe('No items');
    expect(titles()).toEqual([...CORE, 'Panel cards']);
    expect(root().querySelector('.jp-AudioSettings-cards')).toBeNull();
    expect(emptyCard().hidden).toBe(false);
  });
});
