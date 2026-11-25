import { ServerConnection } from '@jupyterlab/services';

import { CommandToolbarButton, Toolbar } from '@jupyterlab/ui-components';

import { CommandRegistry } from '@lumino/commands';

import { MessageLoop } from '@lumino/messaging';

import { Signal } from '@lumino/signaling';

import { Widget } from '@lumino/widgets';

import type { AudioCapture, AudioCaptureState } from '../audio-capture';

import { VoiceStatus } from '../status';

/** jsdom has no server: the player route answers idle. */
const SETTINGS = {
  wsUrl: 'ws://localhost/',
  baseUrl: 'http://localhost/',
  token: 'secret-token'
} as any;

const IDLE = { paused: false, playing: [], sink: { state: 'ready' } };

/** Lets the status request and the slot's mutation observer settle. */
const settle = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, 0));

/** The model surface VoiceStatus reads. */
class Model {
  state: AudioCaptureState = 'idle';
  message = '';
  readonly stateChanged = new Signal<this, AudioCaptureState>(this);
  readonly toggle = jest.fn();
}

let commands: CommandRegistry;
let slot: Toolbar;
let widget: VoiceStatus;

beforeEach(() => {
  jest.spyOn(ServerConnection, 'makeRequest').mockImplementation(
    async () =>
      new Response(JSON.stringify(IDLE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
  );
  commands = new CommandRegistry();
  slot = new Toolbar();
  widget = new VoiceStatus(
    new Model() as unknown as AudioCapture,
    SETTINGS,
    () => undefined,
    slot
  );
  Widget.attach(widget, document.body);
});

afterEach(() => {
  widget.dispose();
  jest.restoreAllMocks();
});

/** The pill's children in order, named as status.spec.ts names them. */
function order(): string[] {
  return Array.from(widget.node.children).map(el =>
    el === slot.node
      ? 'slot'
      : el.classList.contains('jp-Audio-lamp')
        ? 'lamp'
        : ((el as HTMLElement).dataset.vcControl ?? 'divider')
  );
}

/** The pill with an empty slot (EMPTY) and with a shown item (FILLED). */
const EMPTY = [
  'lamp',
  'divider',
  'mic',
  'slot',
  'divider',
  'play',
  'divider',
  'pause',
  'divider',
  'gear'
];
const FILLED = [
  'lamp',
  'divider',
  'mic',
  'divider',
  'slot',
  'divider',
  'play',
  'divider',
  'pause',
  'divider',
  'gear'
];

function dividers(): number {
  return widget.node.querySelectorAll('.jp-Audio-divider').length;
}

/** Adds a command item as the default toolbar factory builds it, and lets it render. */
async function addItem(
  name: string,
  id: string
): Promise<CommandToolbarButton> {
  const item = new CommandToolbarButton({ commands, id });
  slot.addItem(name, item);
  MessageLoop.flush();
  await item.renderPromise;
  await settle();
  return item;
}

function button(item: Widget): Element | null {
  return item.node.querySelector('.jp-ToolbarButtonComponent');
}

describe('VoiceStatus AudioStatus slot', () => {
  it('ACC-CTRL-96: the slot sits right of the microphone, before play', () => {
    expect(order()).toEqual(EMPTY);
    expect(slot.node.classList.contains('jp-Audio-slot')).toBe(true);
  });

  it('ACC-CTRL-96: an empty slot adds no divider and no width', async () => {
    await settle();
    expect(dividers()).toBe(4);
    expect(slot.isHidden).toBe(true);
  });

  it('ACC-CTRL-96: an item adds one divider, between the microphone and the slot', async () => {
    commands.addCommand('test:item', { label: 'Item', execute: () => null });
    const item = await addItem('item', 'test:item');

    expect(button(item)).not.toBeNull();
    expect(order()).toEqual(FILLED);
    expect(dividers()).toBe(5);
    expect(slot.isHidden).toBe(false);
  });

  it('ACC-CTRL-96: an item whose command is not registered adds no button and no divider', async () => {
    const item = await addItem('missing', 'test:missing');

    expect(button(item)).toBeNull();
    expect(order()).toEqual(EMPTY);
    expect(slot.isHidden).toBe(true);
  });

  it('ACC-CTRL-96: an item that turns hidden takes its divider with it', async () => {
    let visible = true;
    commands.addCommand('test:item', {
      label: 'Item',
      isVisible: () => visible,
      execute: () => null
    });
    const item = await addItem('item', 'test:item');
    expect(order()).toEqual(FILLED);

    visible = false;
    commands.notifyCommandChanged('test:item');
    await settle();
    expect(order()).toEqual(EMPTY);
    expect(slot.isHidden).toBe(true);

    visible = true;
    commands.notifyCommandChanged('test:item');
    await settle();
    expect(order()).toEqual(FILLED);

    item.hide();
    await settle();
    expect(order()).toEqual(EMPTY);
  });
});
