---
name: jupyterlab-audio-extension
description: Play audio in the user's JupyterLab browser tab with CLI playback - jupyterlab_audio player play (queue or --now mixed), status, pause, resume, stop and clear. Use when an agent must speak to the user, play a sound or a cue, check why the lab is silent, or start or stop the microphone bridge.
---

# Sound in the browser

Container has no sound device. The server player plays to the default sink voiceout. Sound is heard only while a JupyterLab tab holds the speaker stream; every player command works without one.

- `jupyterlab_audio player play <file>` queues the file; when nothing is playing or paused, the earliest queued file starts, then the queue advances as each file ends
  - Example: A plays; `player play B` queues B, which starts when A ends; `player play C --now` mixes C with A
- `jupyterlab_audio player play <file> --now` starts the file at once beside every playing file, and PulseAudio mixes them
- `jupyterlab_audio player status` prints the playing and queue counts, the paused and stopped flags and the sink state; `--json` prints the state verbatim
- `jupyterlab_audio player pause` freezes every playing file; `resume` continues them and starts the queue when idle; `stop` ends playing and paused files and keeps the queue for the next play or resume; `clear` drops only the queue
- Path: relative to the Jupyter root, or absolute inside it; the server refuses a path outside the root, a missing file and a non-file with its message
- `paplay <file>` or any program playing to the sink sits outside the player: it is not queued, absent from status, cannot be paused or resumed, and `player stop` and `clear` do not end it
- `jupyterlab_audio stop` kills the PulseAudio daemon, so the microphone and speaker go silent; `jupyterlab_audio player stop` ends playback only and leaves the daemon
- Help: `jupyterlab_audio player --help` and `jupyterlab_audio --help`

## Commands CLI

- The commands relay is only for the microphone: `jupyterlab-commands execute audio:enable` starts capture for a program such as Claude Code /voice and `audio:disable` stops it; both need a registered browser tab and an allowlist entry
- `jupyterlab-commands list --json` prints each allowed id and its argument schema; an id outside the saved allowlist exits 4, and the user adds it in Settings > Commands Executor
- Every `execute` carries `--purpose` (at most 25 words) and `--owner`; the token comes from `JUPYTERLAB_COMMANDS_TOKEN` or the server record; never print it

## Rules

- No sound: `jupyterlab_audio player status` shows the sink state, and `jupyterlab_audio validate` checks the audio chain; ask the user before `jupyterlab_audio stop`
