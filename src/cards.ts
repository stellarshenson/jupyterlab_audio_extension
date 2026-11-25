import {
  IToolbarWidgetRegistry,
  createToolbarFactory
} from '@jupyterlab/apputils';

import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { nullTranslator } from '@jupyterlab/translation';

import { Panel, Widget } from '@lumino/widgets';

/** The settings schema that holds the list of cards (schema/cards.json). */
const CARDS_PLUGIN_ID = '@stellarshenson/jupyterlab-audio-extension:cards';

/**
 * The extension point of the settings panel (ACC-CTRL-101). Another extension adds a card
 * with "jupyter.lab.toolbars" -> "AudioSettings": [{ "name": <name>, "rank": <rank> }] in its
 * own settings schema and IToolbarWidgetRegistry.addFactory('AudioSettings', <name>, factory),
 * where the factory returns a new card widget. A disabled or uninstalled extension has no
 * schema entry, so its card is absent. The returned function makes the cards anew, in rank
 * order, for one opening of the panel.
 */
export function createCards(
  toolbarRegistry: IToolbarWidgetRegistry,
  settingRegistry: ISettingRegistry
): () => Widget {
  const factory = createToolbarFactory(
    toolbarRegistry,
    settingRegistry,
    'AudioSettings',
    CARDS_PLUGIN_ID,
    nullTranslator
  );
  return () => {
    // A plain panel, not a Toolbar: the toolbar element takes the arrow keys and the tab
    // stops of the controls inside it.
    const cards = new Panel();
    const items = factory(cards);
    const fill = (): void => {
      for (const item of items) {
        cards.addWidget(item.widget);
      }
    };
    // The list changes when the settings load after the panel opened.
    items.changed.connect((_, change) => {
      change.oldValues.forEach(item => (item.widget.parent = null));
      fill();
    });
    fill();
    return cards;
  };
}
