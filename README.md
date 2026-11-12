# jupyterlab_audio_extension

[![GitHub Actions](https://github.com/stellarshenson/jupyterlab_audio_extension/actions/workflows/build.yml/badge.svg)](https://github.com/stellarshenson/jupyterlab_audio_extension/actions/workflows/build.yml)
[![npm version](https://img.shields.io/npm/v/@stellarshenson/jupyterlab-audio-extension.svg)](https://www.npmjs.com/package/@stellarshenson/jupyterlab-audio-extension)
[![PyPI version](https://img.shields.io/pypi/v/jupyterlab-audio-extension.svg)](https://pypi.org/project/jupyterlab-audio-extension/)
[![Total PyPI downloads](https://static.pepy.tech/badge/jupyterlab-audio-extension)](https://pepy.tech/project/jupyterlab-audio-extension)
[![JupyterLab 4](https://img.shields.io/badge/JupyterLab-4-orange.svg)](https://jupyterlab.readthedocs.io/en/stable/)
[![Brought To You By KOLOMOLO](https://img.shields.io/badge/Brought%20To%20You%20By-KOLOMOLO-00ffff?style=flat)](https://kolomolo.com)
[![Donate PayPal](https://img.shields.io/badge/Donate-PayPal-blue?style=flat)](https://www.paypal.com/donate/?hosted_button_id=B4KPBJDLLXTSA)

Capture microphone audio in the JupyterLab browser tab and stream it to a server-side FIFO, so terminal applications running inside the container - notably Claude Code voice mode - can record from a microphone the container itself has no access to.

The container has no capture device; the browser does. This extension bridges that gap: the browser captures the mic, ships the audio over an authenticated websocket to a Jupyter server handler, and the handler writes raw PCM to a named pipe. A separate, out-of-scope plumbing layer (PulseAudio `module-pipe-source` + SoX) turns that pipe into the system default audio source.

## How it works

- **Capture** - a microphone toggle in the status bar calls `getUserMedia`; the AudioContext resamples to 16 kHz; an AudioWorklet downmixes to mono and encodes signed 16-bit little-endian PCM off the UI thread
- **Transport** - 20 ms PCM frames (640 bytes) are sent as binary websocket messages to `…/jupyterlab-audio-extension/stream`, which lives under the Jupyter base URL and inherits Jupyter token auth - no new port is opened
- **Sink** - the server handler writes each frame, in order, to a FIFO (default `/run/voice/pulseaudio.fifo`); the PulseAudio reader creates the pipe (`module-pipe-source` refuses a pre-existing one), so the handler attaches as writer, waits for the pipe to appear, and tolerates a not-yet-attached reader without blocking the server
- **Speaker** - a program in the container that plays to the default PulseAudio sink (`voiceout`, a `module-pipe-sink`) writes s16le, 48 kHz, stereo PCM to `speaker.fifo` in the directory of the sink FIFO (default `/run/voice/speaker.fifo`); a server thread reads it and sends it as binary websocket messages to `…/jupyterlab-audio-extension/speaker`, under the same token auth; an AudioWorklet in each open JupyterLab tab plays it. While no tab listens, the server discards what it reads, so a tab hears live audio only

Chain: browser mic → AudioWorklet (16 kHz mono s16le) → websocket → server handler → FIFO → (PulseAudio + SoX, out of scope) → terminal app.

Speaker chain: program in the container → (PulseAudio `voiceout`, out of scope) → `speaker.fifo` (48 kHz stereo s16le) → server reader → websocket → AudioWorklet → tab audio output.

> [!IMPORTANT]
> Out of scope - the extension does not manage PulseAudio, invoke SoX or any recorder, or perform speech-to-text; its responsibility ends at delivering correct PCM to the FIFO, and for playback it begins at reading `speaker.fifo` or playing the file that `audio:player` names.

## Requirements

- JupyterLab >= 4.6.0
- A secure context (https or `localhost`) - browsers only expose the microphone over a secure origin

## Install

```bash
pip install jupyterlab-audio-extension
```

## Upgrade from 1.1.8

1.1.8 shipped as `jupyterlab-voice-capture-extension`. Installing the renamed package leaves the old distribution installed, and two status pills and two enabled server extensions then write to the same FIFO.

```bash
pip uninstall jupyterlab-voice-capture-extension
pip install jupyterlab-audio-extension
```

Restart the Jupyter server, then hard-reload every open tab.

- **Auto-connect on startup** resets to off; re-enable it in Settings → **Audio Capture**
- The Commands Executor allowlist (`allowedCommands` of `@stellarshenson/jupyterlab-commands-extension:plugin`) must replace `voice-capture:enable`, `voice-capture:disable` and `voice-capture:player` with `audio:enable`, `audio:disable` and `audio:player`

## Dependencies

- **Python**: `jupyter_server` and `traitlets`, installed automatically with the package
- **System** (only for the full voice chain into a terminal app and for the speaker): PulseAudio + SoX for the voice chain; the speaker needs only PulseAudio (`paplay` comes from `pulseaudio-utils`). Provision and verify them with the bundled CLI:

```bash
jupyterlab_audio install    # apt packages + /run/voice dir + client.conf + Jupyter config line (does NOT start the daemon)
jupyterlab_audio start -d   # start the PulseAudio daemon + pipe-source + voicedrain loopback that keeps it reading + voiceout pipe-sink as the default sink (run after install and each restart)
jupyterlab_audio validate   # check every component, print what to fix (--json for machine output)
jupyterlab_audio stop       # kill the PulseAudio daemon
```

See [docs/jupyterlab-enable-claude-voice.md](docs/jupyterlab-enable-claude-voice.md) for the full setup and troubleshooting.

## Usage

- Click the microphone icon in the status bar (or run **Toggle Audio Capture** from the command palette) to start capture
- On the first start the browser asks for microphone permission; the state shows through the icon and its tooltip (Disconnected → Connecting → Connected), and the browser shows its active-microphone indicator
- Click again to stop - capture tracks are released and the browser indicator clears
- In the Error state (blinking icon) a click disconnects and returns the control to Disconnected, shown in the tooltip; click once more to start capture again
- Only one tab streams at a time: starting capture in a second tab takes over and stops the first
- Playback is always on, with no on/off control and no setting: every tab starts it when JupyterLab loads, and sound that a program in the container plays to the default PulseAudio sink (for example `paplay <file>`) is heard in the tab
- Sound plays as soon as it arrives in a browser that allows sound without a gesture (Chrome with the autoplay policy no-user-gesture-required), and in any browser after any click or key press anywhere in the tab, panels and frames included. In a browser that blocks autoplay, a tab nobody has clicked or typed in since it loaded may stay silent; sound sent more than 0.5 s before the first click or key press is dropped
- Every open JupyterLab browser tab plays the sound; opening another tab stops none of them
- The status bar pill leads with a small audio lamp, then the microphone toggle, a play/stop control and a pause control: the lamp is a filled grey disc when the audio output is ready, green while the microphone streams or a file plays, and a hollow grey ring when the audio output is deliberately shut down; a paused file leaves the lamp grey; hovering the lamp states whether the audio system is ready, in use, shut down or unavailable; while a file plays both controls are enabled and the first shows stop; while paused the first shows play and resumes; with nothing playing both are disabled and greyed
- When the audio output is unavailable, the lamp blinks amber for 30 seconds and the player tooltip says audio output is unavailable; the controls follow the player mode during the blink, and after 30 seconds the lamp settles to the hollow grey ring and both player controls read as disabled with the same message left in the tooltip; a deliberate shutdown shows the hollow grey ring at once, disables both player controls and leaves the tooltip saying audio output is shut down; the microphone toggle stays enabled whatever the lamp shows
- The command `audio:player` drives the container player and returns its state: `play` with a `path` relative to the Jupyter root queues an mp3 or wav file and starts it when nothing plays, `mode: "now"` starts it at once, mixed with every file already playing, `pause` and `resume` stop and continue every playing file at its position, `stop` ends every playing file and keeps the queue, `clear` removes the queue, and `status` reports `paused`, `stopped`, `playing` with ids and positions, and `queue`. A missing or undecodable file, a path outside the root or an unknown action is refused with the reason and changes nothing. The palette entry **Stop All Audio** in category **Audio** runs the command with `{"action": "stop"}`. From a terminal: `jupyterlab-commands execute audio:player --args '{"action": "play", "path": "<file>"}'`, which runs only after `audio:player` is added to the `allowedCommands` setting of `@stellarshenson/jupyterlab-commands-extension:plugin`
- The commands `audio:enable` (label **Enable Audio Capture**) and `audio:disable` (label **Disable Audio Capture**) start capture in the tab that runs `audio:enable` and stop capture in every open tab, for terminal programs such as Claude Code `/voice`. `audio:enable` returns once capture streams, fails with the error message (for example `Microphone permission denied.`) when capture turns to Error, and does nothing when capture already streams; `audio:disable` does nothing when capture is already off. From a terminal: `jupyterlab-commands execute audio:enable`, which, like `audio:player`, runs only after the command is added to the `allowedCommands` setting

## Agent skill

The skill in `.agents/skills/jupyterlab-audio-extension` tells an AI agent how to play a sound in the JupyterLab browser tab and where the help of `jupyterlab_audio` is. `pip install` puts a copy in `<sys.prefix>/share/jupyter/agents/skills/jupyterlab-audio-extension`.

## Configuration

The sink FIFO path defaults to `/run/voice/pulseaudio.fifo` and is overridable via Jupyter server config:

```python
c.AudioCapture.sink_path = "/run/voice/pulseaudio.fifo"
```

Settings → **Audio Capture** has one option, **Auto-connect on startup** (`autoConnect`, default off): when enabled, capture starts automatically as JupyterLab loads instead of waiting for a click.

## Uninstall

```bash
pip uninstall jupyterlab-audio-extension
```

## Troubleshoot

If you see the frontend extension but it is not working, check that the server extension is enabled:

```bash
jupyter server extension list
```

If the server extension is installed and enabled but you do not see the frontend extension, check the frontend extension is installed:

```bash
jupyter labextension list
```

## Contributing

If you would like to contribute to this extension, please refer to the [Contributing Guide](CONTRIBUTING.md).
