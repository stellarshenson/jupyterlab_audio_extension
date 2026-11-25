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

// jsdom has no ResizeObserver; the status bar popup makes one for a panel of changing size.
(window as any).ResizeObserver = class {
  observe(): void {
    // jsdom lays nothing out
  }
  disconnect(): void {
    // nothing observed
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
}

let model: Model;
let widget: VoiceStatus;

/** Makes the pill on the page; the player route answers state. */
async function create(
  state: object = IDLE,
  cards?: () => Widget
): Promise<void> {
  jest.spyOn(ServerConnection, 'makeRequest').mockImplementation(
    async () =>
      new Response(JSON.stringify(state), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
  );
  model = new Model();
  widget = new VoiceStatus(
    model as unknown as AudioCapture,
    SETTINGS,
    undefined,
    cards
  );
  Widget.attach(widget, document.body);
  await settle();
}

afterEach(() => {
  widget.dispose();
  jest.restoreAllMocks();
});

function gear(): HTMLButtonElement {
  return widget.node.querySelector('[data-vc-control="gear"]')!;
}

function panel(): HTMLElement | null {
  return document.querySelector('.jp-AudioSettings');
}

/** The value the open audio card shows in one row. */
function row(name: string): string | null {
  return panel()!.querySelector(`[data-vc-summary="${name}"]`)!.textContent;
}

describe('VoiceStatus gear and settings panel', () => {
  it('ACC-CTRL-99: the gear is the last control of the pill, after a divider', async () => {
    await create();
    const children = Array.from(widget.node.children);

    expect(children[children.length - 1]).toBe(gear());
    expect(
      children[children.length - 2].classList.contains('jp-Audio-divider')
    ).toBe(true);
    expect(gear().getAttribute('aria-label')).toBe('Audio settings');
    expect(gear().getAttribute('aria-expanded')).toBe('false');
    expect(gear().querySelector('svg')).not.toBeNull();
    expect(panel()).toBeNull();
  });

  it('ACC-CTRL-99: a click on the gear opens the panel and a second click closes it', async () => {
    await create();
    gear().click();

    expect(panel()!.getAttribute('role')).toBe('dialog');
    expect(document.body.contains(panel())).toBe(true);
    expect(widget.node.contains(panel())).toBe(false);
    expect(gear().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(panel());

    gear().click();
    expect(panel()).toBeNull();
    expect(gear().getAttribute('aria-expanded')).toBe('false');

    gear().click();
    expect(panel()).not.toBeNull();
  });

  it('ACC-CTRL-99: Escape closes the panel and the gear takes the focus back', async () => {
    await create();
    gear().click();
    panel()!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );

    expect(panel()).toBeNull();
    expect(gear().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(gear());
  });

  it('ACC-CTRL-99: a click outside the panel closes it and a click inside does not', async () => {
    await create();
    gear().click();
    panel()!.querySelector<HTMLElement>('.jp-AudioSettings-row')!.click();
    expect(panel()).not.toBeNull();

    // A real click outside moves the focus before it closes the panel: the gear leaves it there.
    panel()!.blur();
    document.body.click();
    expect(panel()).toBeNull();
    expect(document.activeElement).not.toBe(gear());
  });

  it('ACC-CTRL-99: the open panel goes away with the pill', async () => {
    await create();
    gear().click();
    widget.dispose();

    expect(panel()).toBeNull();
  });

  it('ACC-CTRL-100: the audio card states the microphone, playback and where captured audio goes', async () => {
    await create();
    gear().click();

    expect(row('microphone')).toBe('Not capturing');
    expect(row('playback')).toBe('Nothing playing');
    expect(row('delivery')).toBe(FIFO);
    // A summary: the audio card holds no setting.
    expect(panel()!.querySelector('input, select, button, a')).toBeNull();
  });

  it('ACC-CTRL-100: the open audio card follows the microphone', async () => {
    await create();
    gear().click();
    const turn = (state: AudioCaptureState, message = ''): void => {
      model.state = state;
      model.message = message;
      model.stateChanged.emit(state);
    };

    turn('connecting');
    expect(row('microphone')).toBe('Connecting');
    turn('streaming');
    expect(row('microphone')).toBe('Capturing');
    turn('error', 'Microphone permission denied.');
    expect(row('microphone')).toBe('Microphone permission denied.');
    turn('error');
    expect(row('microphone')).toBe('Error');
    turn('idle');
    expect(row('microphone')).toBe('Not capturing');
  });

  it.each([
    ['a playing file', PLAYING, 'Playing'],
    ['a paused file', { ...PLAYING, paused: true }, 'Paused'],
    [
      'a missing speaker sink',
      { ...IDLE, sink: { state: 'missing' } },
      'Audio output is unavailable'
    ],
    [
      'a shut-down speaker sink',
      { ...PLAYING, sink: { state: 'off' } },
      'Audio output is shut down'
    ]
  ])(
    'ACC-CTRL-100: the audio card states playback for %s',
    async (_, state, words) => {
      await create(state);
      gear().click();

      expect(row('playback')).toBe(words);
    }
  );

  it('ACC-CTRL-100: the open audio card follows the player', async () => {
    await create(PLAYING);
    gear().click();
    expect(row('playback')).toBe('Playing');

    jest.spyOn(ServerConnection, 'makeRequest').mockImplementation(
      async () =>
        new Response(JSON.stringify(IDLE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    );
    // The stop button asks the player and paints its answer, as the 2 s poll does. The click
    // does not bubble: a click that reaches the page is a click outside the panel.
    widget.node
      .querySelector<HTMLButtonElement>('[data-vc-control="play"]')!
      .dispatchEvent(new MouseEvent('click'));
    await settle();
    expect(row('playback')).toBe('Nothing playing');
  });

  it('ACC-CTRL-100: a server that does not report the capture FIFO leaves the target unknown', async () => {
    const { capture, ...old } = IDLE;
    await create(old);
    gear().click();

    expect(capture).toBe(FIFO);
    expect(row('delivery')).toBe('Unknown');
  });
});

/** The settings plugin of the card list, as the server serves schema/cards.json. */
const CARDS_ID = '@stellarshenson/jupyterlab-audio-extension:cards';

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

/** The titles of the cards the open panel shows, top to bottom. */
function titles(): string[] {
  return Array.from(
    panel()!.querySelectorAll<HTMLElement>('.jp-AudioSettings-card')
  )
    .filter(node => !node.classList.contains('lm-mod-hidden'))
    .map(
      node =>
        node.querySelector('.jp-AudioSettings-cardHeader')?.textContent ??
        node.textContent!
    );
}

describe('AudioSettings extension point', () => {
  let toolbarRegistry: ToolbarWidgetRegistry;
  let settingRegistry: SettingRegistry;

  /** The registries of a JupyterLab that holds the given extensions' schemas. */
  function registries(contributors: any[]): void {
    const plugins = [plugin(CARDS_ID, cardsSchema), ...contributors];
    settingRegistry = new SettingRegistry({
      connector: {
        fetch: async (id: string) => plugins.find(item => item.id === id),
        list: async () => ({ ids: [], values: [] }),
        save: async () => undefined,
        remove: async () => undefined
      } as any,
      plugins
    });
    toolbarRegistry = new ToolbarWidgetRegistry({
      defaultFactory: createDefaultFactory(new CommandRegistry())
    });
  }

  it('ACC-CTRL-101: cards follow the audio card in rank order, whatever the order they were added in', async () => {
    registries([
      contributor('late:plugin', [{ name: 'late', rank: 30 }]),
      contributor('early:plugin', [{ name: 'early', rank: 10 }])
    ]);
    toolbarRegistry.addFactory('AudioSettings', 'late', () => card('Late'));
    toolbarRegistry.addFactory('AudioSettings', 'early', () => card('Early'));
    await create(IDLE, createCards(toolbarRegistry, settingRegistry));
    await settingRegistry.load(CARDS_ID);
    await settle();

    gear().click();
    expect(titles()).toEqual(['Audio', 'Early', 'Late']);
  });

  it('ACC-CTRL-101: cards whose list loads after the panel opened appear in it', async () => {
    registries([contributor('early:plugin', [{ name: 'early', rank: 10 }])]);
    toolbarRegistry.addFactory('AudioSettings', 'early', () => card('Early'));
    let cards: () => Widget;
    await create(IDLE, () => cards());

    // The list starts to load here, and the panel opens before the load ends.
    cards = createCards(toolbarRegistry, settingRegistry);
    gear().click();
    expect(titles()).toEqual(['Audio']);
    await until(() => titles().length === 2);
    expect(titles()).toEqual(['Audio', 'Early']);
  });

  it('ACC-CTRL-101: a disposed card leaves the panel and each opening makes the cards anew', async () => {
    registries([contributor('early:plugin', [{ name: 'early', rank: 10 }])]);
    const made: Widget[] = [];
    toolbarRegistry.addFactory('AudioSettings', 'early', () => {
      made.push(card('Early'));
      return made[made.length - 1];
    });
    await create(IDLE, createCards(toolbarRegistry, settingRegistry));
    await settingRegistry.load(CARDS_ID);
    await settle();

    gear().click();
    expect(titles()).toEqual(['Audio', 'Early']);
    made[0].dispose();
    expect(titles()).toEqual(['Audio']);

    gear().click();
    gear().click();
    expect(made).toHaveLength(2);
    expect(titles()).toEqual(['Audio', 'Early']);
    gear().click();
    expect(made[1].isDisposed).toBe(true);
  });

  it('ACC-CTRL-101: an extension that is absent or registered no card adds nothing', async () => {
    // "gone" names a card whose extension registered no factory, as a disabled one does not.
    registries([contributor('gone:plugin', [{ name: 'gone', rank: 10 }])]);
    await create(IDLE, createCards(toolbarRegistry, settingRegistry));
    await settingRegistry.load(CARDS_ID);
    await settle();

    gear().click();
    expect(titles()).toEqual(['Audio']);
    const cards = panel()!.querySelector('.jp-AudioSettings-cards')!;
    expect(cards.children).toHaveLength(1);
    expect(cards.children[0].classList.contains('lm-mod-hidden')).toBe(true);

    // The extension registers its card while the panel is open: the card takes the place.
    toolbarRegistry.addFactory('AudioSettings', 'gone', () => card('Back'));
    expect(titles()).toEqual(['Audio', 'Back']);
    expect(cards.children).toHaveLength(1);
  });

  it('ACC-CTRL-101: without the registries the panel holds the audio card alone', async () => {
    await create();
    gear().click();

    expect(titles()).toEqual(['Audio']);
    expect(panel()!.querySelector('.jp-AudioSettings-cards')).toBeNull();
  });
});
