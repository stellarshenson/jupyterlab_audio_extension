# Defects - jupyterlab_voice_capture_extension

Defects found in the voice-capture extension, its operator CLI and its tests. The criteria they break are in `acc-crit-voice-capture.md`.

- log: 2026-11-06T16:30:02Z @kj coded 8 item(s) from def-codes.map

## Authors

- `@kj` Konrad Jelen

## Test suite `TEST`

Automated tests and the state they leave behind

- [x] `DEF-TEST-1-LEFTOVER-TONE` **Round-trip test leaves tone in the FIFO** - MAJOR; test_round_trip_fifo_to_recorder writes 3 s of tone but rec reads 1 s; the rest stays in /run/voice/pulseaudio.fifo, builds up over runs until the 64 KB pipe is full, then the sox writer blocks and the test fails; the leftover tone plays at the start of the next /voice recording
  - evidence: round-trip test passed 3 runs in a row on 1.0.11 with 0 bytes left in the FIFO after each (FIONREAD); make test 21 pytest green
  - related: ACC-BRIDGE-10-VERBATIM - the round trip this test proves
  - repro: run test_round_trip_fifo_to_recorder repeatedly against the live daemon; FIONREAD on the FIFO grows per pass (9984 bytes after one); at 65536 the test raises TimeoutExpired
  - test-tags: INTEGRATION
  - root-cause: 2026-09-28T08:55:28Z @kj PulseAudio 16.1 module-pipe-source did not read the pipe while voicein was IDLE (observed: sox blocked 38 s, 65536 bytes buffered); sox blocked in write() did not exit on SIGTERM within 5 s
  - log: 2026-09-28T08:55:28Z @kj added
  - log: 2026-09-28T09:16:28Z @kj closed: fixed: test drains the FIFO before and after, stops sox with SIGKILL
  - log: 2026-11-06T16:30:02Z @kj coded LEFTOVER-TONE
- [x] `DEF-TEST-9-TONE-LEAK` **Galata test tone can play in the live lab tab** - MEDIUM; a local Galata run without PULSE_SERVER would play the speaker specs' 440 Hz tone in the open lab tab once the live daemon has voiceout as default sink; cause: Chromium follows /etc/pulse/client.conf to unix:/tmp/pulse-lab/native; not yet observed; `ui-tests/playwright.config.js`
  - evidence: whole Galata suite 32 passed, 2 skipped, 0 failed with --repeat-each 2, PULSE_SERVER at a daemon whose default sink is voiceout: no Chromium client in 188 polls, voiceout SUSPENDED in all; G1/G2 green 2 of 2: context running, analyser peak above 0.25; real-chain spec 1 passed; headed Chromium with the flag: no stream, analyser 0.5
  - root-cause: 2026-11-06T17:24:33Z @kj Chromium opens a PulseAudio stream on the daemon client.conf names; Playwright 1.64.1 adds --mute-audio only to headless launches, so a headed run (--headed, --debug, --ui) plays the tone; --mute-audio still opens a silent stream
  - test-tags: MANUAL
  - repro: after start -d on the live daemon, run the speaker specs in ui-tests without PULSE_SERVER; listen in the lab tab
  - log: 2026-11-06T16:30:50Z @kj added
  - log: 2026-11-06T16:30:50Z @kj reported by the e2e stage of workflow wf_6630f963-0d6: Chromium joined the daemon named by PULSE_SERVER (sink-input float32le 2ch 44100Hz); its run.sh refuses to run without PULSE_SERVER, the repo suite does not
  - log: 2026-11-06T16:30:54Z @kj edited test-tags added "MANUAL"
  - log: 2026-11-06T17:24:33Z @kj reproduced: headed Chromium 1248 without a flag sent the 440 Hz tone to an isolated daemon's null sink, monitor peak 16389
  - log: 2026-11-06T17:24:33Z @kj attempted --mute-audio: Chromium still opened a PulseAudio stream, carrying silence; --disable-audio-output opens none
  - log: 2026-11-06T17:24:37Z @kj closed: fixed: ui-tests/playwright.config.js launches Chromium with --disable-audio-output, workflow wf_0257093c-14b; reason: names three runs with their counts
- [x] `DEF-TEST-13-SERVER-START` **Galata test server misses its start limit on a loaded host** - MINOR; the Galata run ends 'Timed out waiting 120000ms from config.webServer' before any test; cause: nb_conda_kernels runs 'conda info --json' while the test server loads, 18-58 s at load average 77-84; `ui-tests/playwright.config.js`
  - evidence: Galata whole suite with the repo config, no --config, --repeat-each 2, at load average 103: 38 passed, 2 skipped, 0 failed, 3.3 min; before the fix 4 runs in a row ended 'Timed out waiting 120000ms from config.webServer'
  - repro: at load average near 80, run the Galata suite with the repo config
  - test-tags: MANUAL
  - log: 2026-11-06T21:09:55Z @kj added
  - log: 2026-11-06T21:09:55Z @kj reported by the build-autoplay stage of workflow tmp/workflows/autoplay: 4 runs in a row timed out; a copy of the config with webServer.timeout 360 s ran the suite; not fixed: outside the orders
  - log: 2026-11-06T21:42:48Z @kj closed: fixed: F5 of workflow tmp/workflows/fixes, webServer.timeout 360 * 1000 in ui-tests/playwright.config.js

## Server bridge `BRIDGE`

Server websocket handler and the FIFO sink

- [x] `DEF-BRIDGE-2-READER-GONE` **Sink stops writing after the FIFO reader goes away once** - MAJOR; after the FIFO reader closes once (PulseAudio restart, jupyterlab_voice_capture stop/start), no audio reaches the FIFO again until Jupyter restarts, while the control still shows Connected; `jupyterlab_voice_capture_extension/sink.py`
  - evidence: test_new_reader_gets_audio_after_the_old_one_left green; functional suite 8/8 on 1.0.11, each spec with a new FIFO reader
  - related: ACC-BRIDGE-11-NO-READER - a later reader must get live audio
  - repro: stream into the FIFO, stop and restart the reader, stream again; the new reader gets 0 bytes and the server log shows BrokenPipeError: [Errno 32] Broken pipe
  - test-tags: INTEGRATION, FUNCTIONAL
  - root-cause: 2026-09-28T09:06:06Z @kj \_write_frame re-raises BrokenPipeError and \_run has try/finally with no except, so the error ends the voice-capture-fifo-writer thread; nothing drains the queue after that
  - log: 2026-09-28T09:06:06Z @kj added
  - log: 2026-09-28T09:16:29Z @kj closed: fixed: \_run catches BrokenPipeError and other OSError and reopens the FIFO
  - log: 2026-11-06T16:30:02Z @kj coded READER-GONE
- [x] `DEF-BRIDGE-4-REGULAR-FILE` **Audio written into a regular file at the sink path** - MAJOR; a regular file that appears at the sink path after the server started receives the microphone audio, growing without limit; `jupyterlab_voice_capture_extension/sink.py`
  - evidence: test_regular_file_at_sink_path_is_never_written green: file stays 0 bytes (6400 before the fix)
  - related: ACC-BRIDGE-13-NO-DISK - audio never written to a regular file
  - repro: start the server with no FIFO, create a regular file at the sink path, stream; the file grows (6400 bytes after 10 frames)
  - test-tags: INTEGRATION
  - root-cause: 2026-09-28T09:08:33Z @kj \_guard_path runs only in start(); \_open_fifo opens whatever is at the path with O_WRONLY and never checks that it is a FIFO
  - log: 2026-09-28T09:08:33Z @kj added
  - log: 2026-09-28T09:16:29Z @kj closed: fixed: \_open_fifo fstats the opened path and refuses a non-FIFO
  - log: 2026-11-06T16:30:02Z @kj coded REGULAR-FILE
- [x] `DEF-BRIDGE-7-STALE-SPEECH` **Old speech plays at the start of the next /voice recording** - MAJOR; while capture is on and nothing records, the FIFO fills with up to 64 KB (2 s) of audio that PulseAudio reads first when /voice starts recording, so the recording opens with stale speech; `jupyterlab_voice_capture_extension/cli.py`
  - evidence: isolated PulseAudio 16.1 with the drain: 0 bytes waiting after 250 idle frames, a recorder attached at frame 250 first got frame 251, 0 of 250 frames dropped over ten 500 ms stalls, 0.4% CPU; test_start_keeps_voicein_reading_through_a_drain green
  - repro: turn capture on, speak, wait a minute, start /voice; the first 2 s carry the earlier speech
  - test-tags: UNIT
  - root-cause: 2026-09-28T09:55:14Z @kj module-pipe-source does not read the FIFO while voicein is IDLE; the default 64 KB pipe capacity bounds how much old audio waits in it
  - log: 2026-09-28T09:55:14Z @kj added
  - log: 2026-09-28T10:21:11Z @kj closed: fixed: start sets the FIFO capacity to 8192 bytes (256 ms) with F_SETPIPE_SZ
  - log: 2026-09-28T11:03:17Z @kj attempted: 8192-byte pipe cap with F_SETPIPE_SZ - reverted in review round 2; it dropped 95-100 of 250 frames after a 500 ms stall while recording (isolated PulseAudio 16.1)
  - log: 2026-09-28T11:03:17Z @kj fixed: start loads a voicedrain null sink and a loopback from voicein, so the pipe-source keeps reading while nothing records
  - log: 2026-09-28T11:03:17Z @kj edited evidence "test_start_shrinks_the_fifo_buffer green: a pipe held open read-write accepts at most 8192 bytes after start (65536 before); scratch FIFO measured 7680 bytes accepted" -> "isolated PulseAudio 16.1 with the drain: 0 bytes waiting after 250 idle frames, a recorder attached at frame 250 first got frame 251, 0 of 250 frames dropped over ten 500 ms stalls, 0.4% CPU; test_start_keeps_voicein_reading_through_a_drain green"
  - log: 2026-11-06T16:30:02Z @kj coded STALE-SPEECH
- [x] `DEF-BRIDGE-8-OLD-AUDIO` **Reader gets audio from before it attached** - MEDIUM; frames that arrive while no reader holds the FIFO stay in the sink queue (up to 256 frames, 5 s) and are written to the next reader however much later it attaches; found by Galata A1 after D4 in a --repeat-each run; `jupyterlab_voice_capture_extension/sink.py`
  - evidence: test_reader_never_gets_audio_from_before_it_attached red before the fix, green after; pytest 22/22 three runs; Galata --repeat-each 2 18/18 incl. A1 after D4
  - repro: stream with no FIFO, create the FIFO 0.6 s later and read: the old frames arrive before the live ones
  - test-tags: INTEGRATION, FUNCTIONAL
  - root-cause: 2026-09-28T11:59:26Z @kj FifoSink.\_open_fifo waits for a reader without touching the queue, so \_drain first writes every frame queued during the wait
  - log: 2026-09-28T11:59:26Z @kj added
  - log: 2026-09-28T12:05:43Z @kj closed: fixed: \_open_fifo discards the queue on every poll while no reader is attached
  - log: 2026-11-06T16:30:02Z @kj coded OLD-AUDIO

## Lifecycle `LIFE`

Reconnect, teardown and concurrent tabs

- [x] `DEF-LIFE-3-TAKE-BACK` **First tab takes the stream back after a second tab takes over** - MAJOR; with capture on in two tabs, the first tab stays or returns to Connected after the second takes over, so both tabs keep taking the stream from each other and their audio alternates in the FIFO; `src/voice-capture.ts`
  - evidence: functional D3 green on 1.0.11: first tab idle, second tab 1 socket over 3 s; jest 'stops without reconnecting when another tab takes over (D3)' green
  - related: ACC-LIFE-16-ONE-PRODUCER - single producer
  - repro: turn capture on in tab 1, then in tab 2; 5 s later tab 1 still shows Connected
  - test-tags: FUNCTIONAL
  - root-cause: 2026-09-28T09:06:07Z @kj the server closes the old producer with code 1000; the frontend onclose does not check the close code, treats it as a dropped connection and reconnects, which takes the stream back
  - log: 2026-09-28T09:06:07Z @kj added
  - log: 2026-09-28T09:16:29Z @kj closed: fixed: server closes a replaced producer with code 4001, the tab disables capture on it
  - log: 2026-11-06T16:30:02Z @kj coded TAKE-BACK
- [x] `DEF-LIFE-5-DOUBLE-CLICK` **A second click during Connecting leaves the microphone running** - MAJOR; clicking again while the permission prompt or audio start is pending shows Disconnected, but when getUserMedia resolves the capture pipeline starts anyway and the stream is never released; `src/voice-capture.ts`
  - evidence: jest 'a second click during the permission prompt releases the late stream' green on 1.0.12, red without the fix; jest 19/19; functional 9/9 twice
  - repro: click the mic, click again before granting the permission prompt, grant it; the mic indicator stays on with the control Disconnected
  - test-tags: UNIT
  - root-cause: 2026-09-28T09:55:14Z @kj disable() cannot cancel a pending getUserMedia or \_startAudioGraph, and enable() does not check after its awaits that it still owns the capture
  - log: 2026-09-28T09:55:14Z @kj added
  - log: 2026-09-28T10:21:11Z @kj closed: fixed: enable() takes an epoch token that disable() advances; a stale call stops its late stream and returns
  - log: 2026-11-06T16:30:02Z @kj coded DOUBLE-CLICK
- [x] `DEF-LIFE-10-FIRST-RELOAD` **Streaming tab stays on 1.0.18 after the first soft reload** - MEDIUM; after the first soft reload from 1.0.18, a streaming tab stays on the 1.0.18 /stream handler, whose sink is closed, so its audio does not reach voicein until the tab reconnects; workaround: reload the tab, which the new speaker frontend needs anyway, or turn capture off and on; `jupyterlab_voice_capture_extension/__init__.py`
  - evidence: pytest test_a_load_after_1_0_18_closes_its_producer_so_the_tab_reconnects green, test_routes 24 passed, full pytest 47 passed; red without the close (TimeoutError) and with code 4001; soft_reload simulated from installed 1.0.18: its /stream socket closed with 1001, a new /stream reaches the FIFO
  - test-tags: INTEGRATION
  - related: ACC-LIFE-42-RECONNECT - holds only for previous loads of this version or later
  - related: ACC-LIFE-44-LIVERELOAD - the live reload is the first one from 1.0.18
  - repro: 1.0.18 loaded, capture on in a tab; soft reload to this version; the tab's frames do not reach the FIFO until it reconnects
  - root-cause: 2026-11-06T18:03:46Z @kj 1.0.18 records its open sockets nowhere in web_app.settings, so _close_load of the new load closes only the 1.0.18 sink
  - log: 2026-11-06T18:03:46Z @kj added
  - log: 2026-11-06T18:03:52Z @kj reported by the build stage of workflow tmp/workflows/reload: soft_reload simulated from installed 1.0.18, the 1.0.18 /stream socket stayed open and its frames did not reach the FIFO; a new connection worked; not fixed: the order limits the 1.0.18 case to closing the sink
  - log: 2026-11-06T18:04:05Z @kj edited test-tags added "MANUAL"
  - log: 2026-11-06T21:09:54Z @kj edited test-tags "MANUAL" -> "INTEGRATION"
  - log: 2026-11-06T21:09:54Z @kj closed: fixed: setup_route_handlers closes the producer a previous handler class keeps in `_active` with code 1001 before it removes that class's rules, workflow tmp/workflows/autoplay; `routes.py`
- [x] `DEF-LIFE-11-OLD-ROUTES` **Previous load's routes stay registered after a soft reload** - MINOR; after each soft reload the previous load's /stream and /speaker rules stay in the tornado router behind the new ones; they are unreachable but keep the old handler classes and the closed sink in memory, one set per reload; `jupyterlab_voice_capture_extension/__init__.py`
  - evidence: pytest test_a_second_load_removes_the_previous_routes green: only the new load's 2 handler classes stay, 4 without the removal; test_routes 24 passed, full pytest 47 passed; red without the `_remove_previous_routes` call and without rules.remove(rule)
  - test-tags: INTEGRATION
  - related: ACC-LIFE-41-RELOAD - the new code serves the paths, the old rules remain behind it
  - repro: soft reload twice; web_app.default_router.rules holds one host rule per load of this extension, the newest first
  - root-cause: 2026-11-06T18:03:53Z @kj galaxalab_utils soft_reload moves the new rules in front of the old ones and removes none; _close_load closes the old sink and reader but leaves their rules
  - log: 2026-11-06T18:03:53Z @kj added
  - log: 2026-11-06T18:03:53Z @kj reported by the build stage of workflow tmp/workflows/reload ('moved': 1 per reload in the soft_reload report); not fixed: removing the rules was not in the order
  - log: 2026-11-06T18:04:06Z @kj edited test-tags added "MANUAL"
  - log: 2026-11-06T21:09:54Z @kj edited test-tags "MANUAL" -> "INTEGRATION"
  - log: 2026-11-06T21:09:54Z @kj closed: fixed: on load, setup_route_handlers removes the previous load's rules under <base_url>/jupyterlab-voice-capture-extension/ from default_router and wildcard_router, and a host rule left empty, workflow tmp/workflows/autoplay; `routes.py`

## Operator CLI `CLI`

jupyterlab_voice_capture install, start, stop and validate

- [x] `DEF-CLI-6-LEFTOVER-FIFO` **start fails silently after a container restart** - MAJOR; after a container restart the old FIFO is still at the sink path (/run here is on the overlay root, not tmpfs); start then fails to load voicein because module-pipe-source refuses an existing path, yet exits 0; `jupyterlab_voice_capture_extension/cli.py`
  - evidence: test_start_removes_a_leftover_fifo_before_loading_the_source and test_start_exits_1_when_the_source_did_not_load green, both red without the fix
  - repro: stop the daemon without unloading the source (or restart the container), run jupyterlab_voice_capture start -d; exit 0, pactl shows no voicein
  - test-tags: UNIT
  - root-cause: 2026-09-28T09:55:14Z @kj \_start_pulse_and_source loads module-pipe-source without removing a leftover FIFO, and cmd_start checks only that the daemon runs, not that the source loaded
  - log: 2026-09-28T09:55:14Z @kj added
  - log: 2026-09-28T10:21:11Z @kj closed: fixed: start removes a leftover FIFO before loading module-pipe-source and exits 1 when voicein is not loaded
  - log: 2026-11-06T16:30:02Z @kj coded LEFTOVER-FIFO
- [x] `DEF-CLI-14-FALSE-DONE` **install prints Done after a failed command** - MINOR; after apt-get update, apt-get install, install -d or the client.conf write fails, install still prints 'Done. install does not start the daemon. Next steps:' and the start -d step; it exits 1; `jupyterlab_voice_capture_extension/cli.py`
  - evidence: test_install_prints_done_only_when_no_step_failed red on the old code ('Done.' printed after apt-get update returned 100, failure line missing), green after the fix; test_cli.py 30 passed
  - repro: cli._run patched to return 100 for apt-get update, config and sink dir in a temp dir, run install: 'Done.' and the next steps, rc 1
  - test-tags: UNIT
  - log: 2026-11-06T21:42:48Z @kj added
  - log: 2026-11-06T21:42:48Z @kj reported by the build stage of workflow tmp/workflows/fixes; not fixed: F4 ordered the exit code only
  - log: 2026-11-07T07:33:46Z @kj edited test-tags "MANUAL" -> "UNIT"
  - log: 2026-11-07T07:33:46Z @kj closed: fixed: when a step failed, install prints 'install failed - fix the errors above and run install again.' and returns 1; 'Done.' and the next steps only when no step failed
- [x] `DEF-CLI-15-APTGET-MISSING` **install exits 0 when apt-get is missing** - MEDIUM; with no apt-get on PATH install installs no package, prints 'apt-get not found - install these with your platform's package manager:' and 'Done.', and exits 0, which the top-level help lists as success; `jupyterlab_voice_capture_extension/cli.py`
  - evidence: test_install_without_apt_get_fails_only_when_a_package_is_missing: [False-1] red on the old code (assert 0 == 1), [True-0] green there too; both green after the fix; test_cli.py 30 passed
  - repro: no apt-get on PATH (shutil.which patched to None), config and sink dir in a temp dir, run install: rc 0
  - test-tags: UNIT
  - log: 2026-11-06T21:42:48Z @kj added
  - log: 2026-11-06T21:42:48Z @kj reported by the build stage of workflow tmp/workflows/fixes; not fixed: F4 covered failed commands only, and install runs no command when apt-get is missing
  - log: 2026-11-07T07:33:46Z @kj edited test-tags "MANUAL" -> "UNIT"
  - log: 2026-11-07T07:33:46Z @kj the Star Colonel ordered the fix on 2026-11-07: install exits with an error when a required package is missing and apt-get is absent
  - log: 2026-11-07T07:33:46Z @kj closed: fixed: with no apt-get on PATH, install returns 1 when a package row of validate fails, 0 when every package is installed

## Speaker output `SPEAK`

Playback of the container's default sink in the browser tab

- log: 2026-11-06T21:09:55Z @kj category created

- [x] `DEF-SPEAK-12-PLAYFILE-DOC` **playFile doc comment says a click is needed** - MINOR; the playFile doc comment says it rejects when the page has had no click or key press yet; after a reload the page starts after a click, the context runs and the file plays with no new gesture; `src/speaker.ts`
  - evidence: src/speaker.ts:49-54 playFile comment: rejects, playing nothing, when the file is missing or undecodable or the browser keeps the tab silent, as a browser that blocks autoplay does until the first click or key press in the tab since it loaded; Galata 'G15: before any click or key press, play-file rejects and plays nothing' green 2 of 2 (38 passed); jlpm build rc 0
  - repro: click in the lab, run location.reload() from the page, execute voice-capture:play-file with no new click: it plays
  - test-tags: MANUAL
  - log: 2026-11-06T21:09:55Z @kj added
  - log: 2026-11-06T21:09:55Z @kj reported by the build stages of workflow tmp/workflows/autoplay; not fixed: outside the orders
  - log: 2026-11-06T21:42:48Z @kj closed: fixed: F3 of workflow tmp/workflows/fixes; reason: quotes the new comment and names the test that measures it

## Mic capture (frontend) `MIC`

Browser microphone capture, the status-bar control and the enable and disable commands

- log: 2026-11-07T13:30:52Z @kj category created

- [x] `DEF-MIC-16-OPEN-PROMPT` **Open permission prompt holds the tab's commands relay** - MINOR; while the browser microphone permission prompt is open and unanswered, voice-capture:enable does not settle, so every later jupyterlab-commands execute to that tab (play-file, disable) fails after the relay's 30 s timeout until the prompt is answered; `src/index.ts`
  - evidence: jest 'enable rejects at the connect deadline while the permission prompt is unanswered, and Allow later still starts capture' red before (received ""), green after; jest 35/35, eslint 0 errors 6 warnings, prettier clean, jlpm build ok
  - repro: run voice-capture:enable while the permission prompt is open, then play-file to the same tab; it fails after 30 s
  - test-tags: UNIT
  - root-cause: 2026-11-07T13:30:52Z @kj the jupyterlab-commands relay awaits each command before it runs the next one; enable awaits getUserMedia with no deadline (src/voice-capture.ts:83)
  - log: 2026-11-07T13:30:52Z @kj added
  - log: 2026-11-07T13:30:58Z @kj the Star Colonel ordered the fix on 2026-11-07; deferred from review round 5 (tmp/workflows/review/state-r6.json)
  - log: 2026-11-07T13:32:06Z @kj closed: fixed: the enable command rejects when no state change comes within CONNECT_TIMEOUT_MS (10 s) while connecting; capture keeps waiting for the answer; patch tmp/workflows/review/fix-r7/c1.patch; `src/index.ts`
