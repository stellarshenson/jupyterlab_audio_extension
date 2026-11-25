import { expect, galata, test } from '@jupyterlab/galata';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ACC-CTRL-96: the AudioStatus toolbar slot in the status pill. A user "toolbar" setting puts
 * two items in it: one on this extension's audio:toggle command, and one on a command no
 * extension registers, as when the extension that contributes it is disabled.
 *
 * ACC-CTRL-99 to 101: the gear that ends the pill and the settings panel it opens. A user
 * "toolbar" setting of the card list names one card no extension makes.
 *
 * ACC-STATUS-37 (jupyterlab_dictation_extension): the pill without these user settings, in a
 * lab where no extension fills the slot.
 */

const PLUGIN = '@stellarshenson/jupyterlab-audio-extension:plugin';
const CARDS = '@stellarshenson/jupyterlab-audio-extension:cards';
const PILL = '.jp-Audio-pill';
const GEAR = `${PILL} [data-vc-control="gear"]`;
const PANEL = '.jp-AudioSettings';

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

test('ACC-CTRL-99-GEAR: the gear ends the pill and opens a panel above it that a second click, Escape or a click outside closes', async ({
  page
}) => {
  const pill = page.locator(PILL);
  const gear = page.locator(GEAR);
  const panel = page.locator(PANEL);
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

  await expect(panel).toHaveCount(0);
  await gear.click();
  await expect(panel).toBeVisible();
  await expect(gear).toHaveAttribute('aria-expanded', 'true');
  // Galata swaps the code font for a web font, which the browser fetches when the panel first
  // shows text in it. The font arrives after the popup placed the panel and wraps the delivery
  // row; the popup places the taller panel again in the next frame, before that frame is
  // painted. A box read in between is of a layout that no frame shows.
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
  });
  // Above the gear and the status bar, starting at the gear's left edge, inside the window.
  const panelBox = (await panel.boundingBox())!;
  const barBox = (await page.locator('#jp-main-statusbar').boundingBox())!;
  expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(gearBox.y);
  expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(barBox.y);
  expect(panelBox.y).toBeGreaterThanOrEqual(0);
  expect(Math.abs(panelBox.x - gearBox.x)).toBeLessThanOrEqual(1);
  // Flat while open: the status bar paints a clicked item in the brand colour.
  expect(
    await gear.evaluate(node => getComputedStyle(node).backgroundColor)
  ).toBe('rgba(0, 0, 0, 0)');

  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(gear).toBeFocused();
  await expect(gear).toHaveAttribute('aria-expanded', 'false');

  await gear.click();
  await expect(panel).toBeVisible();
  await panel.locator('.jp-AudioSettings-cardHeader').first().click();
  await expect(panel).toBeVisible();
  // The logo: outside the panel and the gear, and a click on it does nothing else.
  await page.locator('#jp-MainLogo').click();
  await expect(panel).toHaveCount(0);

  await gear.click();
  await expect(panel).toBeVisible();
  await gear.click();
  await expect(panel).toHaveCount(0);
});

test('ACC-CTRL-100-SUMMARY: the audio card states capture off and on, playback and where captured audio goes', async ({
  page
}) => {
  const panel = page.locator(PANEL);
  const row = (name: string) => panel.locator(`[data-vc-summary="${name}"]`);
  await page.locator(GEAR).click();
  await expect(
    panel.locator('.jp-AudioSettings-cardHeader').first()
  ).toHaveText('Audio');
  await expect(row('microphone')).toHaveText('Not capturing');
  // The runner holds no speaker FIFO, as CI holds none: the open card follows the sink.
  const speaker = path.join(
    path.dirname(process.env.VOICE_TEST_SINK!),
    'speaker.fifo'
  );
  await expect(row('playback')).toHaveText('Audio output is unavailable');
  expect(spawnSync('mkfifo', [speaker]).status).toBe(0);
  try {
    await expect(row('playback')).toHaveText('Nothing playing', {
      timeout: 10000
    });
  } finally {
    fs.unlinkSync(speaker);
  }
  await expect(row('delivery')).toHaveText(process.env.VOICE_TEST_SINK!);
  // A summary only: the audio card holds no control.
  await expect(
    panel
      .locator('.jp-AudioSettings-card')
      .first()
      .locator('input, select, button, a')
  ).toHaveCount(0);

  // The command, not the microphone button: a click outside the panel closes it.
  const toggle = () =>
    page.evaluate(() =>
      (window as any).jupyterapp.commands.execute('audio:toggle')
    );
  await toggle();
  await expect(row('microphone')).toHaveText('Capturing', { timeout: 15000 });
  await toggle();
  await expect(row('microphone')).toHaveText('Not capturing');
});

test('ACC-CTRL-101-CARDS: with no extension that adds a card, the panel holds the audio card alone', async ({
  page
}) => {
  const panel = page.locator(PANEL);
  await page.locator(GEAR).click();
  await expect(panel).toBeVisible();
  // The audio-only runner: dictation, which adds the Transcription card, is not installed.
  await expect(panel.locator('.jp-AudioSettings-card')).toHaveCount(1);
  // "card-missing" names a card no extension makes, as after its extension is disabled.
  const absent = panel.locator(
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
