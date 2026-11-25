import { PanelLayout, Widget } from '@lumino/widgets';

/** The audio card's rows: what each value states. */
const ROWS = {
  microphone: 'Microphone',
  playback: 'Playback',
  delivery: 'Captured audio goes to'
};

/** The audio extension's state, one plain phrase per row of the audio card. */
export type AudioSummary = Record<keyof typeof ROWS, string>;

/**
 * The body of the panel the pill's gear opens (ACC-CTRL-99): the audio card, which states the
 * audio extension's state and holds no settings (ACC-CTRL-100), then the cards other
 * extensions add (ACC-CTRL-101).
 */
export class AudioSettings extends Widget {
  constructor(cards?: Widget) {
    super();
    this.addClass('jp-AudioSettings');
    this.node.setAttribute('role', 'dialog');
    // eslint-disable-next-line jupyter/no-untranslated-string -- no translator, as in index.ts
    this.node.setAttribute('aria-label', 'Audio settings');
    // Takes the focus when the panel opens, so Escape reaches the panel.
    this.node.tabIndex = -1;

    const card = document.createElement('section');
    card.className = 'jp-AudioSettings-card';
    const header = document.createElement('header');
    header.className = 'jp-AudioSettings-cardHeader';
    // eslint-disable-next-line jupyter/no-untranslated-string -- no translator, as in index.ts
    header.textContent = 'Audio';
    card.appendChild(header);
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
      card.appendChild(row);
    }

    if (cards) {
      cards.addClass('jp-AudioSettings-cards');
      // The layout delivers the attach messages the cards render on.
      const layout = new PanelLayout();
      this.layout = layout;
      layout.addWidget(cards);
    }
    // The audio card is the first card: the layout put the others at the start of the node.
    this.node.prepend(card);
  }

  /** Writes the audio card's values. */
  summarise(summary: AudioSummary): void {
    for (const [key, text] of Object.entries(summary)) {
      this.node.querySelector(`[data-vc-summary="${key}"]`)!.textContent = text;
    }
  }
}
