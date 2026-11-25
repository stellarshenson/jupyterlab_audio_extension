import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import {
  ICommandPalette,
  IToolbarWidgetRegistry,
  createToolbarFactory,
  setToolbar
} from '@jupyterlab/apputils';

import { URLExt } from '@jupyterlab/coreutils';

import { ServerConnection } from '@jupyterlab/services';

import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { IStatusBar } from '@jupyterlab/statusbar';

import { nullTranslator } from '@jupyterlab/translation';

import { Toolbar } from '@jupyterlab/ui-components';

// eslint-disable-next-line jupyter/prefer-lazy-imports -- activate() creates the model at once; AudioCapture is needed for the status item
import { CONNECT_TIMEOUT_MS, AudioCapture } from './audio-capture';

import { createCards } from './cards';

// eslint-disable-next-line jupyter/prefer-lazy-imports -- activate() registers the status item at once
import { AudioSettings } from './settings';

// eslint-disable-next-line jupyter/prefer-lazy-imports -- activate() registers the status item at once
import { VoiceStatus, gearIcon } from './status';

const PLUGIN_ID = '@stellarshenson/jupyterlab-audio-extension:plugin';
const TOGGLE_COMMAND = 'audio:toggle';
const PLAYER_COMMAND = 'audio:player';
const ENABLE_COMMAND = 'audio:enable';
const DISABLE_COMMAND = 'audio:disable';
const NO_ARGS = { args: { type: 'object', properties: {} } };

/**
 * Initialization data for the @stellarshenson/jupyterlab-audio-extension extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    "JupyterLab extension that captures microphone audio in the browser and streams it to a server-side bridge, exposing it as a virtual audio source so terminal applications running in the container (such as Claude Code voice mode) can record from the user's microphone",
  autoStart: true,
  optional: [
    ICommandPalette,
    IStatusBar,
    ISettingRegistry,
    IToolbarWidgetRegistry
  ],
  activate: (
    app: JupyterFrontEnd,
    palette: ICommandPalette | null,
    statusBar: IStatusBar | null,
    settingRegistry: ISettingRegistry | null,
    toolbarRegistry: IToolbarWidgetRegistry | null
  ) => {
    console.log(
      'JupyterLab extension @stellarshenson/jupyterlab-audio-extension is activated!'
    );

    // Playback is always on: this tab plays the container's default PulseAudio sink.
    const speaker = import('./speaker').then(async ({ Speaker }) => {
      const started = new Speaker(app.serviceManager.serverSettings);
      await started.start();
      return started;
    });
    speaker.catch(reason => {
      console.error(
        'Failed to start jupyterlab_audio_extension speaker playback.',
        reason
      );
    });

    // The palette runs this command with {action: 'stop'}; the relay reads the label
    // with no args, so the label must not require args either.
    const playerLabel = (args?: { action?: string }): string =>
      args && args.action === 'stop' ? 'Stop All Audio' : 'Audio Player';

    app.commands.addCommand(PLAYER_COMMAND, {
      label: playerLabel,
      // eslint-disable-next-line jupyter/no-untranslated-string -- no translator, as for TOGGLE_COMMAND
      caption: 'Play, pause, resume, stop, clear or report audio files',
      describedBy: {
        args: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['play', 'pause', 'resume', 'stop', 'clear', 'status'],
              description: 'Player action'
            },
            mode: {
              type: 'string',
              enum: ['queue', 'now'],
              description:
                'For play: append to the queue (default) or start at once, mixed'
            },
            path: {
              type: 'string',
              description:
                'For play: audio file (mp3 or wav), relative to the Jupyter root'
            }
          },
          required: ['action']
        }
      },
      execute: async args => {
        const settings = app.serviceManager.serverSettings;
        const response = await ServerConnection.makeRequest(
          URLExt.join(settings.baseUrl, 'jupyterlab-audio-extension', 'player'),
          { method: 'POST', body: JSON.stringify(args) },
          settings
        );
        // An error from outside the route (extension disabled, a proxy) has no JSON body.
        const state = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            state.message || `audio:player failed: HTTP ${response.status}`
          );
        }
        return state;
      }
    });

    const model = new AudioCapture(app.serviceManager.serverSettings);
    // The relay runs a command in one tab only, while each tab owns its own capture.
    const disableChannel = new BroadcastChannel(
      'jupyterlab-audio-extension:disable'
    );
    disableChannel.onmessage = () => model.disable();

    app.commands.addCommand(TOGGLE_COMMAND, {
      // eslint-disable-next-line jupyter/no-untranslated-string -- no translator
      label: 'Toggle Audio Capture',
      describedBy: NO_ARGS,
      isToggled: () => model.enabled,
      execute: () => model.toggle()
    });

    // For agents (jupyterlab-commands execute); not in the palette, which has the toggle.
    app.commands.addCommand(ENABLE_COMMAND, {
      // eslint-disable-next-line jupyter/no-untranslated-string -- no translator, as for TOGGLE_COMMAND
      label: 'Enable Audio Capture',
      describedBy: NO_ARGS,
      // Settles when the state leaves connecting: the model's connect deadline bounds the wait.
      // An open permission prompt changes no state and would hold the relay, which runs one
      // command at a time, so the first change must also come within that deadline.
      execute: async () => {
        void model.enable();
        if (model.state === 'connecting') {
          await new Promise<void>((resolve, reject) => {
            const prompt = window.setTimeout(() => {
              model.stateChanged.disconnect(settled);
              reject(
                new Error(
                  'Answer the microphone permission prompt in the JupyterLab tab, then run audio:enable again.'
                )
              );
            }, CONNECT_TIMEOUT_MS);
            const settled = (): void => {
              window.clearTimeout(prompt);
              if (model.state !== 'connecting') {
                model.stateChanged.disconnect(settled);
                resolve();
              }
            };
            model.stateChanged.connect(settled);
          });
        }
        if (model.state !== 'streaming') {
          throw new Error(
            model.message || 'Audio capture was turned off before it connected.'
          );
        }
      }
    });

    app.commands.addCommand(DISABLE_COMMAND, {
      // eslint-disable-next-line jupyter/no-untranslated-string -- no translator, as for TOGGLE_COMMAND
      label: 'Disable Audio Capture',
      describedBy: NO_ARGS,
      execute: () => {
        disableChannel.postMessage(null);
        model.disable();
      }
    });

    if (palette) {
      // eslint-disable-next-line jupyter/no-untranslated-string -- no translator, as for TOGGLE_COMMAND
      palette.addItem({ command: TOGGLE_COMMAND, category: 'Audio' });
      palette.addItem({
        command: PLAYER_COMMAND,
        args: { action: 'stop' },
        // eslint-disable-next-line jupyter/no-untranslated-string -- no translator, as for TOGGLE_COMMAND
        category: 'Audio'
      });
    }

    // Other extensions fill the pill's slot through "jupyter.lab.toolbars" -> "AudioStatus".
    // The factory registers the settings transform without which the load below fails.
    const slotFactory =
      toolbarRegistry && settingRegistry
        ? createToolbarFactory(
            toolbarRegistry,
            settingRegistry,
            'AudioStatus',
            PLUGIN_ID,
            nullTranslator
          )
        : null;

    if (statusBar) {
      const slot = slotFactory ? new Toolbar() : undefined;
      // Other extensions add cards to the settings tab through "AudioSettings".
      const cardSource =
        toolbarRegistry && settingRegistry
          ? createCards(toolbarRegistry, settingRegistry)
          : undefined;
      let settingsTab: AudioSettings | null = null;
      // One Audio Settings tab: the gear opens it, or focuses it when it is already open.
      const openSettings = (): void => {
        if (settingsTab && !settingsTab.isDisposed) {
          app.shell.activateById(settingsTab.id);
          return;
        }
        const tab = new AudioSettings(status, settingRegistry, cardSource);
        tab.id = 'jupyterlab-audio-extension:settings';
        // eslint-disable-next-line jupyter/no-untranslated-string -- no translator, as for TOGGLE_COMMAND
        tab.title.label = 'Audio Settings';
        tab.title.icon = gearIcon;
        tab.title.closable = true;
        app.shell.add(tab, 'main', { mode: 'tab-after' });
        app.shell.activateById(tab.id);
        tab.disposed.connect(() => {
          if (settingsTab === tab) {
            settingsTab = null;
          }
        });
        settingsTab = tab;
      };
      const status = new VoiceStatus(
        model,
        app.serviceManager.serverSettings,
        openSettings,
        slot
      );
      if (slotFactory) {
        setToolbar(status, slotFactory, slot);
      }
      statusBar.registerStatusItem('jupyterlab_audio_extension:status', {
        item: status,
        align: 'left',
        rank: 100
      });
    }

    if (settingRegistry) {
      settingRegistry
        .load(PLUGIN_ID)
        .then(settings => {
          // Auto-connect on startup only when the user has opted in (default off).
          if (settings.get('autoConnect').composite === true) {
            void model.enable();
          }
        })
        .catch(reason => {
          console.error(
            'Failed to load jupyterlab_audio_extension settings.',
            reason
          );
        });
    }
  }
};

export default plugin;
