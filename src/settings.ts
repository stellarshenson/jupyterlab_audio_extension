/* eslint-disable jupyter/no-untranslated-string -- no translator, as in index.ts */

import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { Panel, PanelLayout, Widget } from '@lumino/widgets';

import type { VoiceStatus } from './status';

/** The settings plugin that holds autoConnect and the pill's toolbar items. */
const PLUGIN_ID = '@stellarshenson/jupyterlab-audio-extension:plugin';

/** The audio card's rows: what each value states. */
const ROWS = {
  audioSystem: 'Audio system',
  microphone: 'Microphone',
  playback: 'Playback',
  delivery: 'Captured audio goes to'
} as const;

/** The audio extension's state: one row per card row, with its phrase and health colour. */
export type AudioSummary = Record<
  keyof typeof ROWS,
  { text: string; health: 'ok' | 'bad' | '' }
>;

/**
 * The Audio Settings tab (ACC-CTRL-99): a page on the main-area background with the
 * extension's settings laid out as a board of cards. The Audio system card follows the
 * status pill through VoiceStatus.summaryChanged (ACC-CTRL-100); the Capture card holds
 * the auto-connect switch; the Status bar card lists the pill's toolbar items; the Panel
 * cards card is the empty state of the AudioSettings extension point, whose cards are
 * tiles of the board in rank order (ACC-CTRL-101). The tab goes away with the pill.
 */
export class AudioSettings extends Widget {
  constructor(
    status: VoiceStatus,
    settingRegistry: ISettingRegistry | null,
    cards?: () => Widget
  ) {
    super();
    this.addClass('jp-AudioSettings');
    this._status = status;

    const head = document.createElement('div');
    head.className = 'jp-AudioSettings-pageHead';
    const title = document.createElement('h1');
    title.className = 'jp-AudioSettings-title';
    title.textContent = 'Audio Settings';
    const subtitle = document.createElement('p');
    subtitle.className = 'jp-AudioSettings-subtitle';
    subtitle.textContent =
      'Microphone capture and playback. Changes save immediately.';
    head.append(title, subtitle);

    const body = document.createElement('div');
    body.className = 'jp-AudioSettings-body';

    // The board is a widget so the cards another extension adds are attached with the tab.
    const board = new Panel();
    board.addClass('jp-AudioSettings-board');
    const layout = new PanelLayout();
    this.layout = layout;
    layout.addWidget(board);
    // The page head and the body are the page's only children; the body scrolls under the head.
    this.node.append(head, body);
    body.appendChild(board.node);

    // The extension cards join the board before the plain DOM tiles, so the board layout's
    // single widget index stays correct; the core cards are then inserted before it.
    if (cards) {
      this._cardsWidget = cards();
      this._cardsWidget.addClass('jp-AudioSettings-cards');
      board.addWidget(this._cardsWidget);
      this._observer = new MutationObserver(this._syncEmpty);
      this._observer.observe(this._cardsWidget.node, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class']
      });
    }
    const insert = this._cardsWidget ? this._cardsWidget.node : null;

    const audioCard = this._card('Audio system');
    for (const [key, text] of Object.entries(ROWS)) {
      const row = document.createElement('div');
      row.className = 'jp-AudioSettings-row';
      const label = document.createElement('span');
      label.className = 'jp-AudioSettings-label';
      label.textContent = text;
      const value = document.createElement('span');
      value.className = 'jp-AudioSettings-value';
      value.dataset.vcSummary = key;
      row.append(label, value);
      audioCard.appendChild(row);
    }
    board.node.insertBefore(audioCard, insert);

    const captureCard = this._card('Capture');
    const captureBody = document.createElement('div');
    captureBody.className = 'jp-AudioSettings-cardBody';
    const setting = document.createElement('div');
    setting.className = 'jp-AudioSettings-setting';
    const settingText = document.createElement('div');
    this._settingTitle = document.createElement('div');
    this._settingTitle.className = 'jp-AudioSettings-settingTitle';
    this._settingTitle.textContent = 'Auto-connect on startup';
    this._settingDescription = document.createElement('p');
    this._settingDescription.className = 'jp-AudioSettings-settingDescription';
    settingText.append(this._settingTitle, this._settingDescription);
    // The standard JupyterLab switch (jp-switch); the shipped theme CSS draws the track.
    this._switch = document.createElement('button');
    this._switch.className = 'jp-switch';
    this._switch.setAttribute('role', 'switch');
    this._switch.setAttribute('aria-checked', 'false');
    this._switch.setAttribute('aria-label', 'Auto-connect on startup');
    this._switch.disabled = true;
    this._switch.addEventListener('click', this._onToggle);
    const track = document.createElement('div');
    track.className = 'jp-switch-track';
    track.setAttribute('aria-hidden', 'true');
    this._switch.appendChild(track);
    setting.append(settingText, this._switch);
    captureBody.appendChild(setting);
    captureCard.appendChild(captureBody);
    board.node.insertBefore(captureCard, insert);

    const statusCard = this._card('Status bar');
    const statusBody = document.createElement('div');
    statusBody.className = 'jp-AudioSettings-cardBody';
    const statusNote = document.createElement('p');
    statusNote.className = 'jp-AudioSettings-note';
    statusNote.textContent =
      'Items in the audio pill, right of the microphone. Other extensions add them through their own settings.';
    this._toolbarList = document.createElement('div');
    this._toolbarList.className = 'jp-AudioSettings-toolbar';
    const statusHint = document.createElement('p');
    statusHint.className = 'jp-AudioSettings-hint';
    statusHint.textContent = 'Edit these in Settings Editor > Audio Capture.';
    statusBody.append(statusNote, this._toolbarList, statusHint);
    statusCard.appendChild(statusBody);
    board.node.insertBefore(statusCard, insert);

    this._emptyCard = this._card('Panel cards');
    this._emptyCard.classList.add('jp-AudioSettings-emptyCard');
    const emptyBody = document.createElement('div');
    emptyBody.className = 'jp-AudioSettings-cardBody';
    const emptyNote = document.createElement('p');
    emptyNote.className = 'jp-AudioSettings-note';
    emptyNote.textContent = 'Cards from other extensions, in rank order.';
    const empty = document.createElement('div');
    empty.className = 'jp-AudioSettings-empty';
    empty.textContent = 'No cards from other extensions.';
    emptyBody.append(emptyNote, empty);
    this._emptyCard.appendChild(emptyBody);
    board.node.appendChild(this._emptyCard);
    this._syncEmpty();

    const footer = document.createElement('p');
    footer.className = 'jp-AudioSettings-footer';
    footer.textContent =
      'Raw values: Settings Editor > Audio Capture and Audio Settings Panel.';
    body.appendChild(footer);

    this._status.summaryChanged.connect(this._onSummary);
    this._status.disposed.connect(this._onStatusDisposed);
    this._writeSummary(this._status.summary());

    if (settingRegistry) {
      void settingRegistry
        .load(PLUGIN_ID)
        .then(settings => {
          if (this.isDisposed) {
            return;
          }
          this._bindSettings(settings);
        })
        .catch(reason => {
          console.error(
            'Failed to load jupyterlab_audio_extension settings.',
            reason
          );
        });
    } else {
      this._renderToolbar(null);
    }
  }

  dispose(): void {
    this._observer?.disconnect();
    this._status.summaryChanged.disconnect(this._onSummary);
    this._status.disposed.disconnect(this._onStatusDisposed);
    this._settings?.changed.disconnect(this._onSettingsChanged, this);
    super.dispose();
  }

  /** Closing disposes the tab, as MainAreaWidget does; the default handler only detaches. */
  onCloseRequest(): void {
    this.dispose();
  }

  /** A card tile: a section with the header, row and value classes other extensions use. */
  private _card(label: string): HTMLElement {
    const card = document.createElement('section');
    card.className = 'jp-AudioSettings-card';
    const header = document.createElement('header');
    header.className = 'jp-AudioSettings-cardHeader';
    header.textContent = label;
    card.appendChild(header);
    return card;
  }

  /** Binds the Capture switch and the Status bar list to the plugin setting. */
  private _bindSettings(settings: ISettingRegistry.ISettings): void {
    this._settings = settings;
    const autoConnect = settings.schema.properties?.autoConnect as
      { title?: string; description?: string } | undefined;
    if (autoConnect?.title) {
      this._settingTitle.textContent = autoConnect.title;
      this._switch.setAttribute('aria-label', autoConnect.title);
    }
    if (autoConnect?.description) {
      this._settingDescription.textContent = autoConnect.description;
    }
    this._onSettingsChanged();
    settings.changed.connect(this._onSettingsChanged, this);
    this._switch.disabled = false;
  }

  private _onSettingsChanged(): void {
    if (!this._settings) {
      return;
    }
    this._switch.setAttribute(
      'aria-checked',
      String(this._settings.get('autoConnect').composite === true)
    );
    this._renderToolbar(this._settings);
  }

  /** Clicking saves the next value; it starts no capture. */
  private _onToggle = (): void => {
    const next = this._switch.getAttribute('aria-checked') !== 'true';
    this._switch.setAttribute('aria-checked', String(next));
    if (!this._settings) {
      return;
    }
    void this._settings.set('autoConnect', next).catch(reason => {
      console.error(
        'Failed to save jupyterlab_audio_extension settings.',
        reason
      );
      if (this._settings) {
        this._switch.setAttribute(
          'aria-checked',
          String(this._settings.get('autoConnect').composite === true)
        );
      }
    });
  };

  /** One read-only row per pill item, or the empty state. */
  private _renderToolbar(settings: ISettingRegistry.ISettings | null): void {
    const items = (settings?.get('toolbar').composite ?? []) as Array<{
      name?: string;
      command?: string;
    }>;
    this._toolbarList.textContent = '';
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'jp-AudioSettings-empty';
      empty.textContent = 'No items';
      this._toolbarList.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'jp-AudioSettings-row';
      const name = document.createElement('span');
      name.className = 'jp-AudioSettings-label';
      name.textContent = item.name ?? '';
      const command = document.createElement('span');
      command.className = 'jp-AudioSettings-value';
      command.textContent = item.command ?? '';
      row.append(name, command);
      this._toolbarList.appendChild(row);
    }
  }

  /** The Panel cards empty card shows only while no extension card shows. */
  private _syncEmpty = (): void => {
    const shown = this._cardsWidget
      ? Array.from(this._cardsWidget.node.children).some(
          child => !child.classList.contains('lm-mod-hidden')
        )
      : false;
    this._emptyCard.hidden = shown;
  };

  private _writeSummary(summary: AudioSummary): void {
    for (const [key, entry] of Object.entries(summary)) {
      const value = this.node.querySelector(`[data-vc-summary="${key}"]`);
      if (value) {
        if (value.textContent !== entry.text) {
          value.textContent = entry.text;
        }
        value.classList.toggle(
          'jp-AudioSettings-value-ok',
          entry.health === 'ok'
        );
        value.classList.toggle(
          'jp-AudioSettings-value-bad',
          entry.health === 'bad'
        );
      }
    }
  }

  private _onSummary = (_sender: unknown, summary: AudioSummary): void => {
    this._writeSummary(summary);
  };

  private _onStatusDisposed = (): void => {
    this.dispose();
  };

  private _status: VoiceStatus;
  private _settings: ISettingRegistry.ISettings | null = null;
  private _switch: HTMLButtonElement;
  private _settingTitle: HTMLDivElement;
  private _settingDescription: HTMLParagraphElement;
  private _toolbarList: HTMLDivElement;
  private _cardsWidget: Widget | null = null;
  private _observer: MutationObserver | null = null;
  private _emptyCard: HTMLElement;
}
