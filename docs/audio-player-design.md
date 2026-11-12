# Stellars JupyterLab Audio Capture - Virtual Player v1

Status: built, 2026-11-09.

## Contents

- [1. Overview](#1.-Overview)
- [2. Command contract](#2.-Command-contract)
  - [2.1 Arguments](#2.1-Arguments)
  - [2.2 Response](#2.2-Response)
  - [2.3 Route and palette entry](#2.3-Route-and-palette-entry)
- [3. Player state](#3.-Player-state)
- [4. Playback engine](#4.-Playback-engine)
- [5. Lifecycle and reset](#5.-Lifecycle-and-reset)
- [6. Boundary](#6.-Boundary)
- [7. Open decisions](#7.-Open-decisions)

## 1. Overview

The server holds one player in memory, and one JupyterLab command drives it. The command `audio:player` takes an `action` argument and covers every operation: play, play now, pause, resume, stop, clear and status. The player replaces the two earlier commands `play-file` and `stop-playback`.

Playback keeps its current path to the browser. Each playing file is one `paplay` process on the container audio; PulseAudio mixes concurrent processes; the speaker chain carries that audio to every open JupyterLab tab. The player adds ordering, mixing and control on top of a path the lab already proves.

The player is a build of these registered criteria: `ACC-PLAYER-50` to `ACC-PLAYER-65`.

## 2. Command contract

The command has one id and one object argument. The agent path is `jupyterlab-commands execute audio:player --args '<json>'`; the palette runs the same command.

### 2.1 Arguments

| `action` | `mode`            | `path`   | Effect                                                                                                    |
| -------- | ----------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `play`   | `queue` (default) | required | Appends the file to the queue. The file starts when the last playing file ends, in the order added        |
| `play`   | `now`             | required | Starts the file at once, mixed with every file already playing                                            |
| `pause`  | none              | none     | Stops every playing file at its current position and remembers it                                         |
| `resume` | none              | none     | Continues every paused file from the remembered position                                                  |
| `stop`   | none              | none     | Ends every playing file. The queue keeps its files, and it does not advance until the next play or resume |
| `clear`  | none              | none     | Removes every queued file that has not started. Playing files continue                                    |
| `status` | none              | none     | Returns the state and changes nothing                                                                     |

`path` is resolved against the Jupyter root, and a path outside it is refused. These calls are valid:

```json
{"action": "play", "mode": "now", "path": "media/announcement.mp3"}
{"action": "play", "path": "media/next.wav"}
{"action": "pause"}
{"action": "status"}
```

An unknown action, a missing `path` on `play`, a path outside the Jupyter root, and a file that does not decode are refused with a message that names the problem. A refused request leaves no record of the requested file and does not change the stopped gate; a play clears the gate only when its start succeeds. `play` waits 0.2 s on the new `paplay`, so a process that exits in that time is a refusal rather than a failed record.

### 2.2 Response

`status` and every action return the player state as one object:

```json
{
  "paused": false,
  "stopped": false,
  "playing": [{ "id": 1, "path": "media/a.mp3", "position_s": 12.4 }],
  "queue": [{ "id": 2, "path": "media/b.wav" }],
  "sink": { "state": "ready" }
}
```

`playing` lists the files that are playing or paused, in start order; a paused record stays in it with its position frozen. `queue` lists the files that wait, in play order. `position_s` is the seconds played since the file started, minus the time spent paused. `paused` is true while a record is paused and none is playing, and `stopped` is the gate that `stop` sets. `sink` is `{"state": "ready" | "off" | "missing"}`: `ready` when the speaker FIFO exists and is a FIFO, `off` when a `.stopped` marker sits beside it (`jupyterlab_audio stop` writes it), and `missing` when the path is absent or not a FIFO.

### 2.3 Route and palette entry

The command posts `{action, mode?, path?}` to `…/jupyterlab-audio-extension/player` with `ServerConnection.makeRequest`, and returns the JSON state. The handler is authenticated with the Jupyter token and answers 400 with `{"message": …}` that names the problem for a refused request. It is registered beside the two websocket routes.

One palette entry, **Stop All Audio** in category **Audio**, adds the command with `{action: "stop"}`. The command's `label` function returns `Stop All Audio` for that action and `Audio Player` otherwise. The palette resolves a label function with the item's args (`@lumino/widgets` `CommandPalette` calls `commands.label(command, args)`), so no alias command is registered; the relay reads the label with no args and gets `Audio Player`.

## 3. Player state

The player keeps one record per file, in server memory, and writes nothing to disk.

| Field        | Meaning                                                          |
| ------------ | ---------------------------------------------------------------- |
| `id`         | Integer, assigned on entry, unique for the life of the process   |
| `path`       | Absolute path resolved from the Jupyter root                     |
| `state`      | `queued`, `playing`, `paused`, `ended` or `failed`               |
| `position_s` | Seconds played, from the process start time and the paused spans |
| `process`    | The `paplay` process handle while the file plays or is paused    |

State transitions:

- `play` with `mode` `queue` adds a record in state `queued`; a play clears the stopped gate only when its start succeeds
- The player starts the first `queued` record when no record is `playing` or `paused` and the gate is clear
- `pause` moves every `playing` record to `paused` and records the pause start time
- `resume` moves every `paused` record to `playing`, adds the pause span to the record and clears the gate
- A process that exits with code 0 moves its record to `ended`; any other exit moves it to `failed` with the exit code and the last stderr line
- `stop` moves every `playing` and `paused` record to `ended` and sets the stopped gate, so the queue does not advance until the next play or resume
- `clear` deletes every `queued` record

The player starts the next queued record when the last playing record ends or fails and the stopped gate is clear. Ended and failed records are kept for the life of the process; `status` lists playing and queued records only.

## 4. Playback engine

One `paplay` process per playing file. The engine holds the processes and their control signals.

| Operation      | Mechanism                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Start          | `paplay --client-name=audio-player --latency-msec=200 <absolute path>`, stderr captured for the failure record      |
| Mix            | PulseAudio sums every concurrent client; no mixing code exists in the extension                                     |
| Pause          | `SIGSTOP` to every playing process                                                                                  |
| Resume         | `SIGCONT` to every paused process                                                                                   |
| Stop           | `SIGCONT` to a paused process, then `SIGTERM`, then `SIGKILL` after 2 s if the process is still alive               |
| Position       | Wall clock since start, minus the summed paused spans; `paplay` offers no seek, so position is reported and not set |
| Decode failure | A nonzero exit names the file and the last stderr line in the response and in the server log                        |

Transport to the tabs is unchanged: `module-pipe-sink voiceout` → `/run/voice/speaker.fifo` → `SpeakerReader` → `/jupyterlab-audio-extension/speaker` → AudioWorklet in every tab. No new websocket and no new audio path.

The server process starts the player processes. The extension therefore starts a playback client, and the boundary in section 6 is amended to say so.

## 5. Lifecycle and reset

The player belongs to the server process. Its lifetime and its reset points are fixed.

| Event                                            | Effect on the player                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| Server start                                     | Empty player: no playing file, empty queue                                |
| Soft reload (`/galaxalab/bin/reload-jupyterlab`) | The old player and its processes are stopped; the new player starts empty |
| Tab reload or tab close                          | No effect. The tab reconnects and joins the live stream                   |
| Player process exits                             | The record moves to `ended` or `failed`; the next queued file starts      |
| Server stop                                      | Every process is killed; nothing is written                               |

Nothing about the player survives the server process, by design. A queue is a request for the next minutes, and stale audio must never play after a restart.

The soft-reload cleanup that already closes the FIFO writer, the speaker reader and the open sockets gains one more step: it stops every player process before the module is unloaded.

## 6. Boundary

The boundary criterion `ACC-SCOPE-25` says the extension never starts or configures PulseAudio, invokes SoX or a recorder, or does speech-to-text. The player starts `paplay`, which is a playback client on an already running daemon.

The amended criterion keeps every exclusion and adds the permission: the extension may play audio files through PulseAudio; it still never starts, stops or configures the daemon, never records, and never transcribes.

Consequences to carry in the same change:

- the earlier `play-file` and `stop-playback` commands are removed from the command table, the agent skill, the README and the guide
- the commands extension default allowlist carries `audio:player` in place of those two ids, and its `list` output carries the command's caption as the description
- the commands extension is released after the change

## 7. Open decisions

These are not settled by the order and do not block the first build.

- Seek. `paplay` cannot seek, so resume returns to the position where pause stopped, and a jump to an arbitrary second needs a server decoder. Out of scope for v1.
- Queue persistence. The player resets on a server start by order. A user who wants a queue to survive a reload needs a file, which this design rejects.
- Volume. The player has no volume; the tab and the system mixer set the level. A per-file gain needs a mixer that `paplay` does not offer.
