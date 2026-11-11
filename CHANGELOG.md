# Changelog

<!-- <START NEW CHANGELOG ENTRY> -->

## [1.1.8] - 2026-11-11

### Changed

- The status bar pill is 20 px high with a 4 px radius, its controls 22 px wide with 15 px icons and 11 px dividers, and the hollow lamp ring 1 px; a 1 px pill gap keeps adjacent control target centres 25 px apart

### Fixed

- The lamp tooltip reported the voice-capture state; it now states the audio-system state - ready, in use, shut down or unavailable - in plain words, with no path, FIFO or command

## [1.1.7] - 2026-11-11

### Added

- The player status reports `sink.state` as `ready`, `off` or `missing`; `jupyterlab_voice_capture stop` records the deliberate shutdown beside the FIFO and `start` clears it only after the daemon, source and sink load

### Changed

- The status bar pill leads with one 6 px audio-system lamp before the microphone, replacing the amber dot on the play control: a hollow ring after a deliberate shutdown, filled grey when initialised and idle, muted green while the microphone streams or a file plays, and an amber blink for 30 seconds on a broken sink that then settles to the hollow ring with both player controls disabled
- The play tooltip keeps `Audio output is unavailable` and adds `Audio output is shut down`, in plain words with no path, FIFO or command
- README and the player design document describe the lamp and the three-state sink contract

### Fixed

- `stop` records the audio as shut down when the daemon is already down and after a successful kill, while a failed kill records nothing; the foreground start's Ctrl-C records it too
- The light-theme lamp colours clear 3:1 non-text contrast on the shipped light status bars

## [1.1.6] - 2026-11-11

### Changed

- The broken audio sink shows as a 6 px amber dot at the top-right of the play control, blinking for 30 seconds and then disappearing with both controls disabled; the pill keeps its border and the play glyph keeps its normal colour
- The play tooltip says `Audio output is unavailable` in plain words, with no file path, FIFO or command
- The streaming microphone shows the enabled colour alone, with no glow or pulse animation

## [1.1.5] - 2026-11-11

### Added

- The microphone, the play/stop control and the pause control share one status bar pill with 7 px corners and hairline dividers between the segments
- The sink error blink ends after 30 seconds: the play control stops blinking and reads disabled, with the reason left in its tooltip; a healthy status ends the episode, so a later break blinks again

### Changed

- No background tint in any state: an enabled control is shown by its glyph colour alone, and the microphone lights in the same colour as the player controls

## [1.1.4] - 2026-11-11

### Added

- Status bar playback controls beside the microphone icon: a play/stop control and a pause control, enabled while a file plays, where the first shows stop and stops, the second pauses, and while paused the first shows play and resumes; with nothing playing both are disabled and greyed, each with a 24x24 hit box
- The player status reports whether the audio sink is functional (`sink` with `ok` and `reason`), and the play control blinks in the warning colour with the reason in its tooltip when the speaker FIFO is missing

### Changed

- The microphone status control shows no text; its state word appears only in the tooltip

### Fixed

- The player state reports `paused` only when a record is paused and none is playing, so the controls no longer show Resume with Pause disabled during playback

## [1.1.3] - 2026-11-10

### Added

- `voice-capture:player` drives a server-side player from one command: `play` with a path relative to the Jupyter root queues a file and starts it when nothing plays, `mode: "now"` starts it at once mixed with what plays, `pause`, `resume`, `stop`, `clear` and `status` control and report it, and a path outside the root, a missing file or an unknown action is refused with the reason
- The speaker path: a server thread reads `speaker.fifo` (48 kHz stereo s16le) and every open JupyterLab tab plays it through an AudioWorklet, so a program that plays to the default PulseAudio sink is heard in the browser
- Agent skill at `.agents/skills/jupyterlab-voice-capture-extension`, installed by `pip` to `share/jupyter/agents/skills/`
- Palette entry **Stop All Audio** in category **Voice Capture** runs the player with `{"action": "stop"}`

### Changed

- The player replaces `voice-capture:play-file` and `voice-capture:stop-playback`
- The README documents the speaker chain, the player and the two commands

### Fixed

- `voice-capture:enable` rejects after the 10 s connect bound when the microphone permission prompt stays unanswered, so the commands relay is not blocked by a pending request

## [1.0.18] - 2026-10-31

### Changed

- Require Python 3.12

## [1.0.17] - 2026-10-31

### Changed

- Apply the template files and packages the upgrade left out

## [1.0.15] - 2026-10-31

### Changed

- Upgrade to extension template v4.6.5 and Makefile 1.46

### Fixed

- Take the scoped @stellarshenson/jupyterlab-voice-capture-extension npm name

## [1.0.13] - 2026-09-28

### Added

- Galata functional test suite (`ui-tests/tests/voice_capture.spec.ts`): a real JupyterLab and Chromium with a fake microphone, with a FIFO reader standing in for PulseAudio, covering capture on and off, the 16 kHz mono s16le wire format, error handling, reconnect, tab close, tab takeover and main-thread cost
- Acceptance-criteria and defect trackers in `docs/` (`acc-crit-voice-capture.md`, `defects-voice-capture.md`)

### Changed

- `jupyterlab_voice_capture start` loads a `voicedrain` null sink and a loopback from `voicein`, so PulseAudio keeps reading the FIFO while nothing records
- `jupyterlab_voice_capture start` removes a leftover FIFO before loading the pipe-source and exits 1 when the `voicein` source did not load
- The endpoint-unreachable error says that capture keeps retrying with the microphone on and that a click stops it

### Fixed

- A recording could start with old audio: up to 2 s left in the pipe while nothing recorded, and up to 5 s queued in the server while no reader was attached
- A second click while the microphone permission prompt was open left the microphone running after the prompt was granted
- A tab replaced by another tab took the stream back; the server now closes the replaced connection with code 4001 and that tab turns capture off
- The server stopped writing to the FIFO for good after its reader went away once
- A regular file placed at the sink path after startup received the audio

## [1.0.10] - 2026-09-28

### Changed

- A click on the status-bar icon in the Error state (blinking) always disconnects and returns the control to Disconnected; previously the permission, microphone and secure-context errors started capture again on click
- Makefile updated to the shared version 1.43: `make test` also runs pytest, `make publish` runs the tests before the version moves, and `make install` installs missing `node_modules`

## [1.0.8] - 2026-06-09

### Changed

- Maintenance re-release of 1.0.7 with no functional changes (version bump only)

## [1.0.7] - 2026-06-09

### Changed

- Default sink path moved to a lab-owned subfolder `/run/voice/pulseaudio.fifo` (was flat `/run/pulseaudio.fifo`); `install` provisions that dir owned by the Jupyter-server user
- FIFO creation flipped to the reader: `module-pipe-source` creates the FIFO (it refuses a pre-existing one), and the server `FifoSink` now only attaches as writer and waits - it never creates the FIFO
- Operator CLI console script renamed `jupyterlab_voice_capture_extension` → `jupyterlab_voice_capture`
- `validate` marks the `voicein` source connected only when its FIFO exists and is a real FIFO

### Fixed

- Claude Code `/voice` could not enable - the flat `/run` sink was uncreatable by the userspace daemon (runs as a non-root user, `/run` is root-owned) and `module-pipe-source` aborted with "Module initialization failed" on the FIFO the server pre-created at boot

## [1.0.6] - 2026-06-09

### Added

- Settings menu icon - the Voice Capture entry in Settings now shows the microphone icon (`jupyter.lab.setting-icon`)
- `install` now writes the `c.VoiceCapture.sink_path` line into `~/.jupyter/jupyter_server_config.py` when it is absent

### Changed

- `install` no longer starts the PulseAudio daemon - it installs, provisions, and writes config, then advises `start -d`; daemon lifecycle is owned by `start`/`stop`
- Default sink path is now a flat `/run/pulseaudio.fifo` everywhere (CLI default and the extension's `c.VoiceCapture.sink_path` default), replacing `/run/voice/voice.fifo` and `/tmp/voice.fifo`
- Runtime-dir provisioning is guarded so the default `/run` parent is never chowned

## [1.0.4] - 2026-06-09

### Added

- Conservative status colour in operator CLI output - green OK, red missing, yellow warning - shown only on a capable interactive terminal (honours `NO_COLOR`, `TERM=dumb`)
- `validate --json` emits a machine-readable component report (no colour), keeping the 0/1 exit code

### Changed

- Operator CLI `install` is now apt-only; conda support removed because the conda-forge `sox` build ships without the pulseaudio I/O driver and would shadow a pulse-capable system sox
- `install` falls back to printing what to install by other means when apt is absent or fails
- `docs/jupyterlab-enable-claude-voice.md` simplified to the apt-only flow with a "What install does" section

<!-- <END NEW CHANGELOG ENTRY> -->
