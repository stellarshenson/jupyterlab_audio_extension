import { expect, galata, test } from '@jupyterlab/galata';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ACC-CTRL-96: the AudioStatus toolbar slot in the status pill. A user "toolbar" setting puts
 * two items in it: one on this extension's audio:toggle command, and one on a command no
 * extension registers, as when the extension that contributes it is disabled.
 *
 * ACC-CTRL-99 to 101: the gear that ends the pill and the Audio Settings tab it opens. A user
 * "toolbar" setting of the card list names one card no extension makes.
 *
 * ACC-STATUS-37 (jupyterlab_dictation_extension): the pill without these user settings, in a
 * lab where no extension fills the slot.
 */

const PLUGIN = '@stellarshenson/jupyterlab-audio-extension:plugin';
const CARDS = '@stellarshenson/jupyterlab-audio-extension:cards';
const PILL = '.jp-Audio-pill';
const GEAR = `${PILL} [data-vc-control="gear"]`;
const SETTINGS_TAB = '.jp-AudioSettings';
const BOARD = `${SETTINGS_TAB} .jp-AudioSettings-board`;
const EMPTY_CARD = `${SETTINGS_TAB} .jp-AudioSettings-emptyCard`;

test.use({
  mockSettings: {
    ...galata.DEFAULT_SETTINGS,
    [PLUGIN]: {
      toolbar: [
        { name: 'slot-item', command: 'audio:toggle', icon: 'audio:mic' },
        {
          name: 'slot-missing',
          command: 'test:not-registered',
          icon: 'audio:mic'
        }
      ]
    },
    [CARDS]: {
      toolbar: [{ name: 'card-missing' }]
    }
  }
});

test('ACC-CTRL-96: an AudioStatus item renders in the pill right of the microphone at its size', async ({
  page
}) => {
  const pill = page.locator(PILL);
  const mic = pill.locator('[data-vc-control="mic"]');
  const play = pill.locator('[data-vc-control="play"]');
  const item = pill.locator(
    '.jp-Audio-slot [data-jp-item-name="slot-item"] .jp-ToolbarButtonComponent'
  );
  await expect(item).toBeVisible();
  await expect(
    pill.locator('.jp-Audio-slot [data-jp-item-name="slot-missing"]')
  ).toBeHidden();

  // One more divider than the bare pill's four: the slot's own, left of the item.
  await expect(pill.locator('.jp-Audio-divider')).toHaveCount(5);

  const micBox = (await mic.boundingBox())!;
  const itemBox = (await item.boundingBox())!;
  const playBox = (await play.boundingBox())!;
  expect(itemBox.x).toBeGreaterThan(micBox.x + micBox.width);
  expect(itemBox.x + itemBox.width).toBeLessThan(playBox.x);
  expect(itemBox.width).toBeCloseTo(micBox.width, 0);
  expect(itemBox.height).toBeCloseTo(micBox.height, 0);
  expect(itemBox.y).toBeCloseTo(micBox.y, 0);
});

test('ACC-CTRL-97-SLOTFLAT: a slot item hovered, pressed or toggled keeps a transparent background', async ({
  page
}) => {
  const item = page.locator(
    `${PILL} .jp-Audio-slot [data-jp-item-name="slot-item"] .jp-ToolbarButtonComponent`
  );
  await expect(item).toBeVisible();
  const paint = () =>
    item.evaluate(node => {
      const style = getComputedStyle(node);
      return [style.backgroundColor, style.boxShadow];
    });
  const flat = ['rgba(0, 0, 0, 0)', 'none'];
  expect(await paint()).toEqual(flat);

  await item.hover();
  expect(await paint()).toEqual(flat);
  await page.mouse.down();
  expect(await paint()).toEqual(flat);
  // Released away from the item: no click, so capture stays off.
  await page.mouse.move(0, 0);
  await page.mouse.up();

  // A toggled command marks its button aria-pressed, which the button paints as an inset shadow.
  await item.evaluate(node => node.setAttribute('aria-pressed', 'true'));
  expect(await paint()).toEqual(flat);
});

test('ACC-CTRL-98-SPACING: 8 px or more of space between the pill and the status bar items on each side', async ({
  page
}) => {
  const pill = page.locator(PILL);
  await expect(pill).toBeVisible();
  const gaps = await pill.evaluate(node => {
    // The pill is the last left item by default; a plain status bar item stands in for one of
    // higher rank from another extension.
    const right = document.createElement('div');
    right.className = 'jp-StatusBar-Item';
    right.textContent = 'right';
    node.after(right);
    const shown = Array.from(node.parentElement!.children).filter(
      item => item.getBoundingClientRect().width > 0
    );
    const at = shown.indexOf(node);
    const box = node.getBoundingClientRect();
    return [
      box.left - shown[at - 1].getBoundingClientRect().right,
      shown[at + 1].getBoundingClientRect().left - box.right
    ];
  });
  expect(gaps[0]).toBeGreaterThanOrEqual(8);
  expect(gaps[1]).toBeGreaterThanOrEqual(8);
});

test('ACC-CTRL-99-GEAR: the gear opens one Audio Settings tab in the main area and a second click focuses it', async ({
  page
}) => {
  const pill = page.locator(PILL);
  const gear = page.locator(GEAR);
  const tab = page
    .getByRole('main')
    .getByRole('tab', { name: 'Audio Settings' });
  const content = page.locator(SETTINGS_TAB);
  await expect(gear).toBeVisible();
  await expect(
    pill.locator('.jp-Audio-slot [data-jp-item-name="slot-item"]')
  ).toBeVisible();

  // Rightmost: right of the pause control and of the slot item, at the pill's right edge.
  const gearBox = (await gear.boundingBox())!;
  const pillBox = (await pill.boundingBox())!;
  for (const other of [
    '[data-vc-control="mic"]',
    '[data-vc-control="play"]',
    '[data-vc-control="pause"]',
    '.jp-Audio-slot [data-jp-item-name="slot-item"]'
  ]) {
    const box = (await pill.locator(other).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(gearBox.x);
  }
  expect(gearBox.x + gearBox.width).toBeGreaterThan(
    pillBox.x + pillBox.width - 2
  );
  // No audio control: a shut-down audio system marks the microphone, not the gear. One
  // evaluate, because the next status poll repaints the lamp.
  const marks = await pill.evaluate(node => {
    node.dataset.vcLamp = 'off';
    return ['mic', 'gear'].map(
      name =>
        getComputedStyle(
          node.querySelector(`[data-vc-control="${name}"]`)!,
          '::after'
        ).content
    );
  });
  expect(marks[0]).not.toBe('none');
  expect(marks[1]).toBe('none');

  // Nothing is open before the click, and the gear keeps no expanded state.
  await expect(tab).toHaveCount(0);
  await expect(content).toHaveCount(0);
  expect(await gear.getAttribute('aria-haspopup')).toBeNull();
  expect(await gear.getAttribute('aria-expanded')).toBeNull();

  await gear.click();
  await expect(tab).toHaveCount(1);
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(content).toBeVisible();

  // ACC-CTRL-110-PAGE-CHROME: the head starts at the tab's top edge and the body scrolls
  // under it, holding the board.
  const head = page.locator(`${SETTINGS_TAB} .jp-AudioSettings-pageHead`);
  const body = page.locator(`${SETTINGS_TAB} .jp-AudioSettings-body`);
  await expect(head).toBeVisible();
  const headBox = (await head.boundingBox())!;
  const contentBox = (await content.boundingBox())!;
  expect(Math.abs(headBox.y - contentBox.y)).toBeLessThanOrEqual(1);
  await expect(body.locator('.jp-AudioSettings-board')).toBeVisible();
  expect(await body.evaluate(node => getComputedStyle(node).overflowY)).toBe(
    'auto'
  );

  // The Capture card holds the standard jp-switch: a click saves, a second click restores.
  const autoConnect = page.locator(`${SETTINGS_TAB} .jp-switch`);
  await expect(autoConnect).toBeVisible();
  await expect(autoConnect).toHaveAttribute('role', 'switch');
  const initial = await autoConnect.getAttribute('aria-checked');
  await autoConnect.click();
  await expect(autoConnect).toHaveAttribute(
    'aria-checked',
    initial === 'true' ? 'false' : 'true'
  );
  await autoConnect.click();
  await expect(autoConnect).toHaveAttribute('aria-checked', initial!);

  // A second click focuses the same tab: switch away, then click the gear again.
  await page.evaluate(async () => {
    await (window as any).jupyterapp.commands.execute('launcher:create');
  });
  await expect(tab).toHaveAttribute('aria-selected', 'false');
  await gear.click();
  await expect(tab).toHaveCount(1);
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(content).toBeVisible();

  // Closing the tab ends it.
  await tab.locator('.lm-TabBar-tabCloseIcon').click();
  await expect(tab).toHaveCount(0);
  await expect(content).toHaveCount(0);

  // A later click opens a fresh tab.
  await gear.click();
  await expect(tab).toHaveCount(1);
  await expect(content).toBeVisible();
});

test('ACC-CTRL-106-BOARD: the board shows two columns wide and one column narrow', async ({
  page
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.locator(GEAR).click();
  const board = page.locator(BOARD);
  await expect(board).toBeVisible();
  const columns = () =>
    board.evaluate(
      node => getComputedStyle(node).gridTemplateColumns.split(' ').length
    );
  await expect.poll(columns).toBe(2);

  await page.setViewportSize({ width: 700, height: 900 });
  await expect.poll(columns).toBe(1);
});

test('ACC-CTRL-100-SUMMARY: the Audio system card states capture off and on, playback and where captured audio goes', async ({
  page
}) => {
  const content = page.locator(SETTINGS_TAB);
  const row = (name: string) => content.locator(`[data-vc-summary="${name}"]`);
  await page.locator(GEAR).click();
  await expect(
    content.locator('.jp-AudioSettings-cardHeader').first()
  ).toHaveText('Audio system');
  await expect(row('microphone')).toHaveText('Not capturing');
  // The runner holds no speaker FIFO, as CI holds none: the open card follows the sink.
  await expect(row('audioSystem')).toHaveText('Unavailable');
  await expect(row('audioSystem')).toHaveClass(/jp-AudioSettings-value-bad/);
  const speaker = path.join(
    path.dirname(process.env.VOICE_TEST_SINK!),
    'speaker.fifo'
  );
  await expect(row('playback')).toHaveText('Audio output is unavailable');
  expect(spawnSync('mkfifo', [speaker]).status).toBe(0);
  const toggle = () =>
    page.evaluate(() =>
      (window as any).jupyterapp.commands.execute('audio:toggle')
    );
  try {
    await expect(row('playback')).toHaveText('Nothing playing', {
      timeout: 10000
    });
    await expect(row('audioSystem')).toHaveText('Ready');
    await expect(row('audioSystem')).toHaveClass(/jp-AudioSettings-value-ok/);

    await toggle();
    await expect(row('microphone')).toHaveText('Capturing', {
      timeout: 15000
    });
    await expect(row('audioSystem')).toHaveText('In use');
    await toggle();
    await expect(row('microphone')).toHaveText('Not capturing');
    await expect(row('audioSystem')).toHaveText('Ready');
  } finally {
    fs.unlinkSync(speaker);
  }
  await expect(row('delivery')).toHaveText(process.env.VOICE_TEST_SINK!);
  // The Audio system card is a summary only: it holds no control.
  await expect(
    content
      .locator('.jp-AudioSettings-card')
      .first()
      .locator('input, select, button, a')
  ).toHaveCount(0);
});

test('ACC-CTRL-101-CARDS: with no extension that adds a card, the board shows the Panel cards empty card', async ({
  page
}) => {
  const content = page.locator(SETTINGS_TAB);
  await page.locator(GEAR).click();
  const empty = page.locator(EMPTY_CARD);
  await expect(empty).toBeVisible();
  await expect(empty.locator('.jp-AudioSettings-empty')).toHaveText(
    'No cards from other extensions.'
  );
  // "card-missing" names a card no extension makes, as after its extension is disabled.
  const absent = content.locator(
    '.jp-AudioSettings-cards > :not(.jp-AudioSettings-card)'
  );
  await expect(absent).toHaveCount(1);
  await expect(absent).toBeHidden();
});

test('ACC-CTRL-102-LIVECOLOR: the streaming microphone and the active lamp take --jp-Audio-live-color in the light and the dark theme', async ({
  page
}) => {
  const pill = page.locator(PILL);
  const toggle = () =>
    page.evaluate(() =>
      (window as any).jupyterapp.commands.execute('audio:toggle')
    );
  // The property as written, its computed colour, the microphone's and the active lamp's.
  // The lamp follows the sink, which this runner lacks, so it is read with the active state set.
  const colours = async () => {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
    });
    return pill.evaluate(node => {
      const probe = document.body.appendChild(document.createElement('span'));
      probe.style.color = 'var(--jp-Audio-live-color)';
      const live = getComputedStyle(probe).color;
      probe.remove();
      const lamp = node.querySelector('.jp-Audio-lamp') as HTMLElement;
      const was = lamp.dataset.vcLamp!;
      lamp.dataset.vcLamp = 'active';
      const active = getComputedStyle(lamp).backgroundColor;
      lamp.dataset.vcLamp = was;
      return {
        defined: getComputedStyle(document.documentElement)
          .getPropertyValue('--jp-Audio-live-color')
          .trim(),
        live,
        mic: getComputedStyle(node.querySelector('[data-vc-control="mic"]')!)
          .color,
        lamp: active
      };
    });
  };
  await toggle();
  await expect(pill).toHaveAttribute('data-vc-state', 'streaming', {
    timeout: 15000
  });

  await page.theme.setLightTheme();
  expect(await colours()).toEqual({
    defined: '#347443',
    live: 'rgb(52, 116, 67)',
    mic: 'rgb(52, 116, 67)',
    lamp: 'rgb(52, 116, 67)'
  });
  await page.theme.setDarkTheme();
  expect(await colours()).toEqual({
    defined: '#6dbd81',
    live: 'rgb(109, 189, 129)',
    mic: 'rgb(109, 189, 129)',
    lamp: 'rgb(109, 189, 129)'
  });
  // The microphone and lamp rules read the property: another value on :root repaints both,
  // in the dark and the light theme.
  await page.evaluate(() =>
    document.documentElement.style.setProperty(
      '--jp-Audio-live-color',
      'rgb(1, 2, 3)'
    )
  );
  expect(await colours()).toMatchObject({
    mic: 'rgb(1, 2, 3)',
    lamp: 'rgb(1, 2, 3)'
  });
  await page.theme.setLightTheme();
  expect(await colours()).toMatchObject({
    mic: 'rgb(1, 2, 3)',
    lamp: 'rgb(1, 2, 3)'
  });
  await toggle();
});

test.describe('no extension fills the slot', () => {
  // The pill of a lab without dictation: no user "toolbar" setting, and the runner holds no
  // enabled extension that lists an item under "AudioStatus".
  test.use({ mockSettings: { ...galata.DEFAULT_SETTINGS } });

  test('ACC-STATUS-37-UNINSTALLED: without the dictation frontend the pill holds lamp, microphone, play, pause and gear, no dictation button and no divider for it', async ({
    page
  }) => {
    const pill = page.locator(PILL);
    await expect(page.locator(GEAR)).toBeVisible();
    await expect(
      pill.locator('[data-jp-item-name="dictation-toggle"]')
    ).toHaveCount(0);
    await expect(pill.locator('.jp-Audio-slot')).toBeHidden();
    // What the pill shows, left to right: one divider between two neighbours, none for the slot.
    const shown = await pill.evaluate(node =>
      Array.from(node.children)
        .filter(child => child.getBoundingClientRect().width > 0)
        .map(
          child =>
            (child as HTMLElement).dataset.vcControl ??
            child.className.split(' ')[0]
        )
    );
    expect(shown).toEqual([
      'jp-Audio-lamp',
      'jp-Audio-divider',
      'mic',
      'jp-Audio-divider',
      'play',
      'jp-Audio-divider',
      'pause',
      'jp-Audio-divider',
      'gear'
    ]);
  });
});
