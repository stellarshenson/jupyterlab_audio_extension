---
name: jupyterlab-audio-extension
description: Play a sound in the user's JupyterLab browser tab and operate the jupyterlab_audio CLI. Use when an agent must speak to the user, play an audio file or a cue, check why the lab is silent, or start or stop the microphone bridge.
---

# Sound in the browser

Container has no sound device. Default PulseAudio sink voiceout plays in every open JupyterLab tab.

- Any file or program: `paplay <file>` (wav, mp3), or anything that plays to the default sink
- Player, one command with an action: `jupyterlab-commands execute audio:player --args '{"action": "play", "path": "<file>"}' --purpose "play a sound" --owner "<agent>"`; the path is relative to the Jupyter root, not the shell directory
  - `play` queues the file and starts it when nothing plays; `"mode": "now"` mixes it with what plays
  - actions: `play`, `pause`, `resume`, `stop`, `clear`, `status`; every call returns the player state
  - palette entry Stop All Audio runs `{"action": "stop"}`
  - a direct `paplay` ends only when its process ends
- Microphone, for programs such as Claude Code /voice: `audio:enable` starts capture and returns once it streams, `audio:disable` stops it; enable names the reason when the browser has no microphone permission or the prompt stays unanswered for 10 s

## Commands CLI

- `jupyterlab-commands list` prints each allowed id with its description; `--json` adds each command's argument schema
- Run it before the first call. An id outside the allowlist exits 4: the saved allowlist of `@stellarshenson/jupyterlab-commands-extension:plugin` may predate the id, and the user adds it in Settings > Commands Executor or with the Add to command executor button. The shipped default holds `audio:player`, `audio:enable` and `audio:disable`
- Every `execute` carries `--purpose` (at most 25 words) and `--owner` (agent or project); `--json` for machine-readable output; `--args-file <file>` instead of `--args` for long JSON
- Token comes from `JUPYTERLAB_COMMANDS_TOKEN` or the server record; never print it, never pass `--token`

## Rules

- Sound plays as soon as it arrives; only a tab with no click or key press since load stays silent until the first one
- No sound: `jupyterlab_audio validate`; flags: `jupyterlab_audio --help`, `jupyterlab_audio <command> --help`
- Ask the user before `jupyterlab_audio stop`: it kills the PulseAudio daemon and the microphone and speaker go silent
<!-- improved 2026-11-09 | body 371W -> 314W / 21L -> 25L | benchmark n/a (not-requested) | via improve-skill -->
