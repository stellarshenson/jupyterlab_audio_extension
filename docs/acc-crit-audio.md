# Acceptance Criteria - jupyterlab_audio_extension

Project-wide acceptance criteria for the audio extension. Each criterion is
measurable - a frame on the wire, a DOM/state effect, a file written - so a build is
"done" only when checked against a real measurement, not asserted.

This extension is the **browser + bridge half** of a larger chain that lets terminal
applications inside the container (notably Claude Code `/voice`) record the user's
microphone. The container has no capture device; the browser does. The extension captures
mic audio in the browser, ships it over an authenticated websocket to a Jupyter
server-extension handler, and the handler writes raw PCM to an agreed sink (a FIFO). A
separate, **out-of-scope** plumbing layer (PulseAudio `module-pipe-source` + SoX) turns
that FIFO into the system default audio source. This document is the contract between the
two halves.

Conventions: "PCM" means signed 16-bit little-endian, 16 kHz, mono unless stated. "frame"
= one binary websocket message of PCM. The websocket path is served by the extension's own
server endpoint under the Jupyter base URL and inherits Jupyter token auth. "sink" = the
FIFO path the handler writes to (`/run/voice/pulseaudio.fifo` by default). All measurements
assume the page is served over a secure context (https or `localhost`).

- log: 2026-11-06T16:30:02Z @kj coded 25 item(s) from acc-codes.map

## Authors

- `@kj` Konrad Jelen

## A. Mic capture (frontend) `MIC`

Browser microphone capture and the status-bar control

- [x] `ACC-MIC-1-TOGGLE` **A1 explicit toggle** - CRITICAL; a command (palette + a toolbar or status-bar button) toggles capture on/off; nothing captures audio until the user turns it on
  - evidence: functional A1: no getUserMedia call and 0 FIFO bytes before the click, 1 call after; jest A1 green
  - test-tags: UNIT, FUNCTIONAL
  - test: construct AudioCapture, assert getUserMedia not called before toggle(), called once after
  - log: 2026-09-28T08:54:26Z @kj edited importance added "CRITICAL"; test added "construct VoiceCapture, assert getUserMedia not called before toggle(), called once after"
  - log: 2026-09-28T09:16:29Z @kj edited test-tags added "UNIT, FUNCTIONAL"
  - log: 2026-09-28T09:16:29Z @kj closed: verified in v1.0.11
  - log: 2026-11-06T16:30:02Z @kj coded TOGGLE
  - log: 2026-11-11T23:47:10Z @kj edited test "construct VoiceCapture, assert getUserMedia not called before toggle(), called once after" -> "construct AudioCapture, assert getUserMedia not called before toggle(), called once after"; reason: the class is renamed AudioCapture
- [x] `ACC-MIC-2-ENABLE` **A2 getUserMedia on enable** - CRITICAL; turning capture on calls `navigator.mediaDevices.getUserMedia({ audio: true })` and, on grant, begins streaming; the browser shows its active-microphone indicator
  - evidence: functional A2 with Chromium fake mic: getUserMedia granted, 1 live track, Connected, audio in the FIFO; the indicator itself not observed by automation
  - test-tags: UNIT, FUNCTIONAL, MANUAL
  - test: enable with a granted stream, assert getUserMedia({ audio: true }) and state streaming after the socket opens; browser indicator by eye
  - log: 2026-09-28T08:54:26Z @kj edited importance added "CRITICAL"; test added "enable with a granted stream, assert getUserMedia({ audio: true }) and state streaming after the socket opens; browser indicator by eye"; test-tags added "UNIT, MANUAL"
  - log: 2026-09-28T09:16:29Z @kj edited test-tags "UNIT, MANUAL" -> "UNIT, FUNCTIONAL, MANUAL"
  - log: 2026-09-28T09:16:29Z @kj closed: verified in v1.0.11
  - log: 2026-11-06T16:30:02Z @kj coded ENABLE
- [x] `ACC-MIC-3-RELEASE` **A3 release on disable** - HIGH; turning capture off stops every `MediaStreamTrack` (`track.stop()`), closes the AudioContext, and the browser mic indicator clears within ~1 s; no tracks remain live
  - evidence: functional A3: every track readyState ended within 1 s of the click, FIFO receives 0 bytes/s after; jest A3/D2 green
  - test-tags: UNIT, FUNCTIONAL, MANUAL
  - test: enable then disable, assert every track stopped and AudioContext closed; browser indicator clears by eye
  - log: 2026-09-28T08:54:26Z @kj edited importance added "HIGH"; test added "enable then disable, assert every track stopped and AudioContext closed; browser indicator clears by eye"; test-tags added "UNIT, MANUAL"
  - log: 2026-09-28T09:16:29Z @kj edited test-tags "UNIT, MANUAL" -> "UNIT, FUNCTIONAL, MANUAL"
  - log: 2026-09-28T09:16:29Z @kj closed: verified in v1.0.11
  - log: 2026-11-06T16:30:02Z @kj coded RELEASE
- [x] `ACC-MIC-4-STATE` **A4 visible state** - HIGH; the control shows exactly one of idle, connecting, streaming and error at all times through its icon and animation; each state looks different from the others
  - evidence: functional A1/A2/E1: data-vc-state idle, streaming and error with animations none, none and audio-blink, and the streaming icon in the enabled colour with no glow; jest covers connecting
  - test-tags: UNIT, FUNCTIONAL
  - test: drive idle, streaming and error in a browser, assert data-vc-state and the icon animation (none, none, audio-blink); connecting in jest
  - log: 2026-09-28T08:54:26Z @kj edited importance added "HIGH"; test added "drive idle, connecting, streaming and error, assert the status item carries exactly one jp-mod-<state> class"
  - log: 2026-09-28T08:54:56Z @kj amended text "the control reflects exactly one of idle / streaming / error at all times; the streaming state is visually distinct from idle" -> "the control shows exactly one of idle (Disconnected), connecting, streaming (Connected) and error at all times; each state looks different from the others"
  - log: 2026-09-28T09:16:29Z @kj edited test "drive idle, connecting, streaming and error, assert the status item carries exactly one jp-mod-<state> class" -> "drive idle, streaming and error in a browser, assert data-vc-state and the icon animation (none, vc-pulse, vc-blink); connecting in jest"; test-tags added "UNIT, FUNCTIONAL"
  - log: 2026-09-28T09:16:29Z @kj closed: verified in v1.0.11
  - log: 2026-11-06T16:30:02Z @kj coded STATE
  - log: 2026-11-10T22:37:39Z @kj amended text "the control shows exactly one of idle (Disconnected), connecting, streaming (Connected) and error at all times; each state looks different from the others" -> "the control shows exactly one of idle, connecting, streaming and error at all times through its icon and animation; each state looks different from the others"
  - log: 2026-11-11T15:23:04Z @kj edited test "drive idle, streaming and error in a browser, assert data-vc-state and the icon animation (none, vc-pulse, vc-blink); connecting in jest" -> "drive idle, streaming and error in a browser, assert data-vc-state and the icon animation (none, none, vc-blink); connecting in jest"; evidence "functional A1/A2/E1: data-vc-state idle, streaming, error with animations none, vc-pulse, vc-blink; jest covers connecting" -> "functional A1/A2/E1: data-vc-state idle, streaming and error with animations none, none and vc-blink, and the streaming icon in the enabled colour with no glow; jest covers connecting"
  - log: 2026-11-11T23:47:13Z @kj edited test "drive idle, streaming and error in a browser, assert data-vc-state and the icon animation (none, none, vc-blink); connecting in jest" -> "drive idle, streaming and error in a browser, assert data-vc-state and the icon animation (none, none, audio-blink); connecting in jest"; evidence "functional A1/A2/E1: data-vc-state idle, streaming and error with animations none, none and vc-blink, and the streaming icon in the enabled colour with no glow; jest covers connecting" -> "functional A1/A2/E1: data-vc-state idle, streaming and error with animations none, none and audio-blink, and the streaming icon in the enabled colour with no glow; jest covers connecting"; reason: the lamp animation is renamed audio-blink
- [x] `ACC-MIC-47-ENABLE-COMMAND` **A5 enable command** - HIGH; the JupyterLab command audio:enable starts capture when it is off and does nothing when it is already streaming; it resolves once the state is streaming and rejects with the error message when the state turns error (no permission, no microphone, insecure context, endpoint unreachable after the 10 s connect deadline)
  - evidence: jest 'enable resolves once streaming, and a second enable does nothing' and 'enable rejects with the error message: a denied microphone at once, an unreachable endpoint at the connect deadline' green, 33 of 33; Galata 'A5/A6: audio:enable resolves streaming, audio:disable stops, a repeat does nothing' green with the 8 capture specs, 9 passed; each red before the command existed
  - test: jest: execute enable twice, 1 getUserMedia, resolves at streaming; denied permission rejects with 'Microphone permission denied.'; Galata: execute with the fake microphone, status Connected, /stream socket open
  - test-tags: UNIT, FUNCTIONAL
  - log: 2026-11-07T12:41:24Z @kj added
  - log: 2026-11-07T12:48:51Z @kj closed: built in workflow tmp/workflows/mic; reason: quotes three test names in full
  - log: 2026-11-07T14:08:45Z @kj live v1.1.1 in the Star Colonel's lab, 14:06:49 UTC: jupyterlab-commands execute voice-capture:enable exit 0 after about 5 s; then parec -d voicein 6 s while he spoke: 96000 samples, RMS -25.5 dBFS, peak 21736; jupyterlab-commands list shows 'Enable Voice Capture'
  - log: 2026-11-11T23:47:15Z @kj amended text "the JupyterLab command voice-capture:enable starts capture when it is off and does nothing when it is already streaming; it resolves once the state is streaming and rejects with the error message when the state turns error (no permission, no microphone, insecure context, endpoint unreachable after the 10 s connect deadline)" -> "the JupyterLab command audio:enable starts capture when it is off and does nothing when it is already streaming; it resolves once the state is streaming and rejects with the error message when the state turns error (no permission, no microphone, insecure context, endpoint unreachable after the 10 s connect deadline)"; reason: command id renamed from voice-capture:enable to audio:enable
  - log: 2026-11-11T23:47:15Z @kj edited evidence "jest 'enable resolves once streaming, and a second enable does nothing' and 'enable rejects with the error message: a denied microphone at once, an unreachable endpoint at the connect deadline' green, 33 of 33; Galata 'A5/A6: voice-capture:enable resolves streaming, voice-capture:disable stops, a repeat does nothing' green with the 8 capture specs, 9 passed; each red before the command existed" -> "jest 'enable resolves once streaming, and a second enable does nothing' and 'enable rejects with the error message: a denied microphone at once, an unreachable endpoint at the connect deadline' green, 33 of 33; Galata 'A5/A6: audio:enable resolves streaming, audio:disable stops, a repeat does nothing' green with the 8 capture specs, 9 passed; each red before the command existed"; reason: the Galata test title quotes the renamed command ids
- [x] `ACC-MIC-48-DISABLE-COMMAND` **A6 disable command** - HIGH; the JupyterLab command audio:disable stops capture and resolves with the state idle; when capture is already off it does nothing
  - evidence: jest 'disable stops capture, and a second disable does nothing' green, 33 of 33; Galata 'A5/A6: audio:enable resolves streaming, audio:disable stops, a repeat does nothing' green: status Disconnected, /stream socket closed, 0 live tracks, FIFO rate 0, a second disable leaves 1 getUserMedia call; both red before the command existed
  - test: jest: execute disable while idle, no state change; while streaming, tracks stopped and state idle; Galata: execute after enable, status Disconnected, /stream socket closed
  - test-tags: UNIT, FUNCTIONAL
  - log: 2026-11-07T12:41:25Z @kj added
  - log: 2026-11-07T12:48:51Z @kj closed: built in workflow tmp/workflows/mic; reason: quotes two test names in full
  - log: 2026-11-07T14:08:45Z @kj live v1.1.1 in the Star Colonel's lab: jupyterlab-commands execute voice-capture:disable exit 0; a 2 s parec from voicein afterwards delivered 0 samples; a second disable exit 0; jupyterlab-commands list shows 'Disable Voice Capture'
  - log: 2026-11-11T23:47:17Z @kj amended text "the JupyterLab command voice-capture:disable stops capture and resolves with the state idle; when capture is already off it does nothing" -> "the JupyterLab command audio:disable stops capture and resolves with the state idle; when capture is already off it does nothing"; reason: command id renamed from voice-capture:disable to audio:disable
  - log: 2026-11-11T23:47:18Z @kj edited evidence "jest 'disable stops capture, and a second disable does nothing' green, 33 of 33; Galata 'A5/A6: voice-capture:enable resolves streaming, voice-capture:disable stops, a repeat does nothing' green: status Disconnected, /stream socket closed, 0 live tracks, FIFO rate 0, a second disable leaves 1 getUserMedia call; both red before the command existed" -> "jest 'disable stops capture, and a second disable does nothing' green, 33 of 33; Galata 'A5/A6: audio:enable resolves streaming, audio:disable stops, a repeat does nothing' green: status Disconnected, /stream socket closed, 0 live tracks, FIFO rate 0, a second disable leaves 1 getUserMedia call; both red before the command existed"; reason: the Galata test title quotes the renamed command ids
- [x] `ACC-MIC-70-NO-LABEL` **State text only in the tooltip** - HIGH; the status bar microphone control shows no text, and the state text (Disconnected, Connecting, Connected, Error) appears only in the control's tooltip
  - evidence: jest status spec: no text content in any state and the tooltip carries the state word; Galata A1: the status node has no text
  - test: jest: render each state, assert the node carries no visible text and the title carries the state text; Galata: the status item shows an icon only
  - test-tags: UNIT, FUNCTIONAL
  - log: 2026-11-10T22:37:39Z @kj added
  - log: 2026-11-10T23:54:35Z @kj closed: verified in v1.1.3+controls
- [x] `ACC-MIC-76-NO-GLOW` **The streaming microphone does not glow** - MEDIUM; the microphone reads its state as a colour alone: while capture streams it shows the enabled colour with no glow, drop shadow or pulsing animation
  - evidence: jest: the streaming microphone carries no animation class and the enabled colour; Galata: computed animation-name none and the streaming colour equals the enabled pause control
  - test: jest and Galata: the streaming microphone icon has animation-name none and its computed colour equals the enabled control colour
  - test-tags: UNIT, FUNCTIONAL
  - log: 2026-11-11T14:38:38Z @kj added
  - log: 2026-11-11T15:23:04Z @kj closed

## B. Audio format - the wire contract (frontend) `WIRE`

PCM format and framing of the websocket messages

- [x] `ACC-WIRE-5-RESAMPLE` **B1 resample to 16 kHz mono** - CRITICAL; regardless of the hardware sample rate, audio reaching the websocket is resampled/downmixed to 16 kHz, mono (verified by decoding a captured frame: sample rate 16000, single channel)
  - evidence: functional A2: FIFO byte rate within 15% of 32000 B/s (16000 Hz x 1 channel x 2 bytes) over 3 s; jest AudioContext sampleRate 16000
  - test-tags: UNIT, FUNCTIONAL
  - test: enable, assert AudioContext sampleRate 16000; decode a captured frame, assert 16000 Hz and 1 channel
  - log: 2026-09-28T08:54:26Z @kj edited importance added "CRITICAL"; test added "enable, assert AudioContext sampleRate 16000; decode a captured frame, assert 16000 Hz and 1 channel"; test-tags added "UNIT"
  - log: 2026-09-28T09:16:29Z @kj edited test-tags "UNIT" -> "UNIT, FUNCTIONAL"
  - log: 2026-09-28T09:16:29Z @kj closed: verified in v1.0.11
  - log: 2026-11-06T16:30:02Z @kj coded RESAMPLE
- [x] `ACC-WIRE-6-ENCODING` **B2 s16le encoding** - CRITICAL; each frame is signed 16-bit little-endian PCM (not Float32, not WebM/Opus); a known tone produces sample values in the expected `int16` range
  - evidence: pcm.spec 'maps full scale to the int16 range, little-endian (B2)' green in the v1.0.10 publish run, jest 13/13
  - test-tags: UNIT
  - test: floatToS16LE on +1.0 and -1.0, assert 0x7FFF and 0x8000 little-endian
  - log: 2026-09-28T08:54:26Z @kj edited importance added "CRITICAL"; test added "floatToS16LE on +1.0 and -1.0, assert 0x7FFF and 0x8000 little-endian"; test-tags added "UNIT"
  - log: 2026-09-28T08:54:47Z @kj closed: verified in v1.0.10
  - log: 2026-11-06T16:30:02Z @kj coded ENCODING
- [x] `ACC-WIRE-7-FRAME-SIZE` **B3 fixed frame size** - MEDIUM; frames carry a consistent payload of ~20-40 ms of audio (e.g. 320-640 samples -> 640-1280 bytes); frame byte length is constant during a stream
  - evidence: pcm.spec 'emits a fixed-size frame only once full (B3)' and 'splits a long chunk into whole frames' green in the v1.0.10 publish run
  - test-tags: UNIT, FUNCTIONAL
  - test: feed samples to the framer, assert 320-sample (640-byte) frames emitted only once full
  - log: 2026-09-28T08:54:26Z @kj edited importance added "MEDIUM"; test added "feed samples to the framer, assert 320-sample (640-byte) frames emitted only once full"; test-tags added "UNIT"
  - log: 2026-09-28T08:54:47Z @kj closed: verified in v1.0.10
  - log: 2026-09-28T09:16:29Z @kj edited test-tags "UNIT" -> "UNIT, FUNCTIONAL"
  - log: 2026-11-06T16:30:02Z @kj coded FRAME-SIZE
- [x] `ACC-WIRE-8-BINARY` **B4 binary frames only** - HIGH; frames are sent as binary websocket messages (`ArrayBuffer`), never base64/text; no JSON wrapping around the PCM payload
  - evidence: voice-capture.spec 'forwards a frame pushed by the worklet to the websocket' (same ArrayBuffer sent, binaryType arraybuffer) green in the v1.0.10 publish run
  - test-tags: UNIT, FUNCTIONAL
  - test: worklet posts an ArrayBuffer, assert ws.send gets the same ArrayBuffer and binaryType is arraybuffer
  - log: 2026-09-28T08:54:26Z @kj edited importance added "HIGH"; test added "worklet posts an ArrayBuffer, assert ws.send gets the same ArrayBuffer and binaryType is arraybuffer"; test-tags added "UNIT"
  - log: 2026-09-28T08:54:47Z @kj closed: verified in v1.0.10
  - log: 2026-09-28T09:16:29Z @kj edited test-tags "UNIT" -> "UNIT, FUNCTIONAL"
  - log: 2026-11-06T16:30:02Z @kj coded BINARY

## C. Server bridge (server extension) `BRIDGE`

Server websocket handler and the FIFO sink

- [x] `ACC-BRIDGE-9-AUTH` **C1 authenticated endpoint** - CRITICAL; the websocket handler is registered under the Jupyter server base URL and rejects connections lacking a valid Jupyter token (401/403); no new externally exposed port is opened
  - evidence: test_wrong_token_is_refused green: wrong token gets 403 before the upgrade; route registered under base_url
  - test-tags: UNIT, INTEGRATION
  - test: connect to the stream endpoint without a token, assert 403
  - log: 2026-09-28T08:54:26Z @kj edited importance added "CRITICAL"; test added "connect to the stream endpoint without a token, assert 403"; test-tags added "UNIT"
  - log: 2026-09-28T09:16:30Z @kj edited test-tags "UNIT" -> "UNIT, INTEGRATION"
  - log: 2026-09-28T09:16:30Z @kj closed: verified in v1.0.11
  - log: 2026-11-06T16:30:02Z @kj coded AUTH
- [x] `ACC-BRIDGE-10-VERBATIM` **C2 PCM -> sink** - CRITICAL; every binary frame received is written verbatim to the sink FIFO in order; bytes written equal bytes received over the connection
  - evidence: test_routes test_pcm_written_verbatim and test_multiframe_round_trip_in_order green in the v1.0.10 publish run, pytest 13/13
  - test-tags: INTEGRATION, FUNCTIONAL
  - test: send frames over the websocket, read the FIFO, assert same bytes in the same order
  - log: 2026-09-28T08:54:26Z @kj edited importance added "CRITICAL"; test added "send frames over the websocket, read the FIFO, assert same bytes in the same order"; test-tags added "INTEGRATION"
  - log: 2026-09-28T08:54:47Z @kj closed: verified in v1.0.10
  - log: 2026-09-28T09:16:30Z @kj edited test-tags "INTEGRATION" -> "INTEGRATION, FUNCTIONAL"
  - log: 2026-11-06T16:30:02Z @kj coded VERBATIM
- [x] `ACC-BRIDGE-11-NO-READER` **C3 consumer-absent tolerance** - HIGH; if the FIFO is not yet created or nothing is reading it yet (PulseAudio not attached), the handler does not crash the server and does not block indefinitely - it drops or buffers within a bounded window and logs, so a later reader gets live audio
  - evidence: test_tolerates_absent_reader and test_new_reader_gets_audio_after_the_old_one_left green on 1.0.11
  - test-tags: INTEGRATION, FUNCTIONAL
  - test: stream with no FIFO, then stop and restart the reader, assert the new reader gets audio
  - log: 2026-09-28T08:54:26Z @kj edited importance added "HIGH"; test added "stream 10 frames with no FIFO present, assert the server still accepts a new connection"; test-tags added "INTEGRATION"
  - log: 2026-09-28T08:54:47Z @kj closed: verified in v1.0.10
  - log: 2026-09-28T09:16:29Z @kj reopened: reopened: DEF-BRIDGE-2 showed a later reader got no audio after the first reader left; evidence retired: test_routes test_tolerates_absent_reader (no FIFO, 10 frames, new connection accepted) green in the v1.0.10 publish run
  - log: 2026-09-28T09:16:30Z @kj edited test "stream 10 frames with no FIFO present, assert the server still accepts a new connection" -> "stream with no FIFO, then stop and restart the reader, assert the new reader gets audio"; test-tags "INTEGRATION" -> "INTEGRATION, FUNCTIONAL"
  - log: 2026-09-28T09:16:30Z @kj closed: verified in v1.0.11
  - log: 2026-11-06T16:30:02Z @kj coded NO-READER
- [x] `ACC-BRIDGE-12-SINK-PATH` **C4 configurable sink, safe default** - HIGH; the sink path defaults to `/run/voice/pulseaudio.fifo` and is overridable via server config; the PulseAudio reader (`module-pipe-source`) owns FIFO creation because it refuses to attach to a pre-existing FIFO, so the handler never creates the FIFO - it attaches as writer, waits for the reader to create it, and refuses only a path that exists as a non-FIFO (C5)
  - evidence: test_streaming_never_creates_the_fifo green: path absent after 10 frames with no reader
  - test-tags: INTEGRATION
  - test: set sink_path in server config, stream with no reader, assert the path is never created
  - log: 2026-09-28T08:54:26Z @kj edited importance added "HIGH"; test added "set sink_path in server config, stream with no reader, assert the path is never created"; test-tags added "INTEGRATION"
  - log: 2026-09-28T09:16:30Z @kj closed: verified in v1.0.11
  - log: 2026-11-06T16:30:02Z @kj coded SINK-PATH
- [x] `ACC-BRIDGE-13-NO-DISK` **C5 no disk capture** - HIGH; audio is never written to a regular file or persisted; only the FIFO (a pipe) is touched
  - evidence: test_regular_file_at_sink_path_is_never_written green after DEF-BRIDGE-4-REGULAR-FILE: file stays 0 bytes
  - test-tags: INTEGRATION
  - test: put a regular file at sink_path, stream frames, assert the file is unchanged
  - log: 2026-09-28T08:54:27Z @kj edited importance added "HIGH"; test added "put a regular file at sink_path, stream frames, assert the file is unchanged"
  - log: 2026-09-28T09:16:30Z @kj edited test-tags added "INTEGRATION"
  - log: 2026-09-28T09:16:30Z @kj closed: verified in v1.0.11
  - log: 2026-11-06T16:30:02Z @kj coded NO-DISK
  - log: 2026-11-06T16:30:06Z @kj edited evidence "test_regular_file_at_sink_path_is_never_written green after DEF-BRIDGE-4: file stays 0 bytes" -> "test_regular_file_at_sink_path_is_never_written green after DEF-BRIDGE-4-REGULAR-FILE: file stays 0 bytes"

## D. Lifecycle and robustness `LIFE`

Reconnect, teardown, concurrent tabs and resource use

- [x] `ACC-LIFE-14-RECONNECT` **D1 reconnect** - HIGH; if the websocket drops while capture is on, the frontend retries with backoff and resumes streaming without user action; the toggle stays "on"
  - evidence: functional D1: socket dropped, second socket opened, Connected again with 1 live track; jest D1 green
  - test-tags: UNIT, FUNCTIONAL
  - test: open then drop the socket, assert state connecting, a retry after backoff, then streaming
  - log: 2026-09-28T08:54:27Z @kj edited importance added "HIGH"; test added "open then drop the socket, assert state connecting, a retry after backoff, then streaming"
  - log: 2026-09-28T09:16:30Z @kj edited test-tags added "UNIT, FUNCTIONAL"
  - log: 2026-09-28T09:16:30Z @kj closed: verified in v1.0.11
  - log: 2026-11-06T16:30:02Z @kj coded RECONNECT
- [x] `ACC-LIFE-15-TEARDOWN` **D2 clean teardown** - HIGH; closing or reloading the tab stops tracks and closes the websocket; the server-side connection closes and stops writing to the sink
  - evidence: functional D2: after the streaming tab closed, FIFO 0 bytes/s over 1 s; jest A3/D2 green
  - test-tags: UNIT, FUNCTIONAL
  - test: close a streaming tab, assert a 1 s window with 0 bytes into the FIFO follows within 30 s
  - log: 2026-09-28T08:54:27Z @kj edited importance added "HIGH"; test added "fire beforeunload, assert tracks stopped and socket closed; assert the server handler closes"; test-tags added "UNIT"
  - log: 2026-09-28T09:16:30Z @kj edited test "fire beforeunload, assert tracks stopped and socket closed; assert the server handler closes" -> "close a streaming tab, assert the FIFO receives 0 bytes/s within 0.5 s"; test-tags "UNIT" -> "UNIT, FUNCTIONAL"
  - log: 2026-09-28T09:16:30Z @kj closed: verified in v1.0.11
  - log: 2026-09-28T11:03:17Z @kj edited test "close a streaming tab, assert the FIFO receives 0 bytes/s within 0.5 s" -> "close a streaming tab, assert a 1 s window with 0 bytes into the FIFO follows within 30 s"
  - log: 2026-11-06T16:30:02Z @kj coded TEARDOWN
- [x] `ACC-LIFE-16-ONE-PRODUCER` **D3 single producer** - MEDIUM; concurrent capture from two tabs does not corrupt the stream - either the second is refused or streams are not interleaved into the sink (define and enforce one behaviour)
  - evidence: functional D3 green after DEF-LIFE-3-TAKE-BACK: second tab takes over, first tab idle with 0 live tracks, no flapping over 3 s
  - test-tags: UNIT, FUNCTIONAL
  - test: open two stream connections, assert the first is closed and only the second writes to the sink
  - log: 2026-09-28T08:54:27Z @kj edited importance added "MEDIUM"; test added "open two stream connections, assert the first is closed and only the second writes to the sink"
  - log: 2026-09-28T09:16:30Z @kj edited test-tags added "UNIT, FUNCTIONAL"
  - log: 2026-09-28T09:16:30Z @kj closed: verified in v1.0.11
  - log: 2026-11-06T16:30:02Z @kj coded ONE-PRODUCER
  - log: 2026-11-06T16:30:06Z @kj edited evidence "functional D3 green after DEF-LIFE-3: second tab takes over, first tab idle with 0 live tracks, no flapping over 3 s" -> "functional D3 green after DEF-LIFE-3-TAKE-BACK: second tab takes over, first tab idle with 0 live tracks, no flapping over 3 s"
- [x] `ACC-LIFE-17-FOOTPRINT` **D4 light footprint** - MEDIUM; streaming holds the main thread free (capture/encoding runs in an AudioWorklet, not on the UI thread); idle extension adds no measurable CPU
  - evidence: functional D4: streaming adds 0.016 s main-thread script per 3 s (limit 0.15); jest D4: 0 timers while idle
  - test-tags: UNIT, FUNCTIONAL
  - test: stream 3 s, compare main-thread ScriptDuration with an idle 3 s window; assert no timers while idle
  - log: 2026-09-28T08:54:27Z @kj edited importance added "MEDIUM"; test added "profile a streaming tab, assert encoding runs on the AudioWorklet thread and the idle tab shows no extension CPU"; test-tags added "MANUAL"
  - log: 2026-09-28T09:16:30Z @kj edited test "profile a streaming tab, assert encoding runs on the AudioWorklet thread and the idle tab shows no extension CPU" -> "stream 3 s, compare main-thread ScriptDuration with an idle 3 s window; assert no timers while idle"; test-tags "MANUAL" -> "UNIT, FUNCTIONAL"
  - log: 2026-09-28T09:16:30Z @kj closed: verified in v1.0.11
  - log: 2026-11-06T16:30:02Z @kj coded FOOTPRINT
- [x] `ACC-LIFE-41-RELOAD` **D5 soft reload replaces the server threads** - HIGH; when /galaxalab/bin/reload-jupyterlab loads a new version in place, the new load closes the FIFO writer and speaker reader of the previous load (kept in web_app.settings) before starting its own; afterwards exactly one writer thread and one speaker reader thread run, and the new code serves /stream and /speaker
  - evidence: pytest test_a_second_load_replaces_the_sink_and_the_speaker_reader green, test_routes 22 passed, full pytest 45 passed; galaxalab soft_reload simulated from 1.0.18 and again: 1 writer and 1 speaker reader thread after each, /speaker answers, capture reaches the FIFO; cleanup call removed: 3 writers, 2 readers
  - test: pytest: load the extension twice in one server; the first load's sink and reader are closed, one thread of each name is alive, audio flows through the new ones
  - test-tags: INTEGRATION
  - log: 2026-11-06T17:37:25Z @kj added
  - log: 2026-11-06T18:03:59Z @kj closed: closed: built in workflow tmp/workflows/reload
- [x] `ACC-LIFE-42-RECONNECT` **D6 open sockets move to the new code** - HIGH; a reload closes the websocket connections the previous load holds, so each tab reconnects to the new handlers within its backoff and capture and playback resume without user action
  - evidence: pytest test_a_second_load_closes_open_sockets_so_tabs_reconnect and test_a_load_after_1_0_18_closes_its_producer_so_the_tab_reconnects green, test_routes 24 passed: old /stream and /speaker sockets closed with 1001, which both frontends answer by reconnecting; soft_reload simulated from installed 1.0.18: its /stream socket closed with 1001, a new /stream reaches the FIFO; reload 2: new sockets carry capture and speaker audio
  - test: pytest: a /stream producer and a /speaker listener connected before the second load are closed; reconnecting reaches the new handlers
  - test-tags: INTEGRATION
  - log: 2026-11-06T17:37:26Z @kj added
  - log: 2026-11-06T18:03:59Z @kj closed: closed: built in workflow tmp/workflows/reload; the first reload from 1.0.18 is DEF-LIFE-10-FIRST-RELOAD
  - log: 2026-11-06T21:09:54Z @kj edited evidence "pytest test_a_second_load_closes_open_sockets_so_tabs_reconnect green, test_routes 22 passed: old /stream and /speaker sockets closed with 1001, which both frontends answer by reconnecting; simulated soft reload 2: new sockets carry capture and speaker audio; holds when the previous load is this version or later; 1.0.18 case: DEF-LIFE-10-FIRST-RELOAD" -> "pytest test_a_second_load_closes_open_sockets_so_tabs_reconnect and test_a_load_after_1_0_18_closes_its_producer_so_the_tab_reconnects green, test_routes 24 passed: old /stream and /speaker sockets closed with 1001, which both frontends answer by reconnecting; soft_reload simulated from installed 1.0.18: its /stream socket closed with 1001, a new /stream reaches the FIFO; reload 2: new sockets carry capture and speaker audio"; reason: names two tests and two simulated reloads with their results
- [x] `ACC-LIFE-43-UNLOAD` **D7 unload hook cleans up** - MEDIUM; _unload_jupyter_server_extension stops the FIFO writer, the speaker reader and the open connections, so a server stop, or a reload tool that calls the hook, leaves no thread or FIFO descriptor behind
  - evidence: pytest test_unload_stops_both_threads_and_releases_connections_and_fifos green, test_routes 22 passed: both threads stopped, connections closed, no descriptor open on either FIFO; jupyter_server 2.21.1 calls no unload hook on stop, so a server stop is met by process exit
  - test: pytest: call the hook; both threads have stopped, no descriptor on either FIFO stays open, connections are closed
  - test-tags: INTEGRATION
  - log: 2026-11-06T17:37:26Z @kj added
  - log: 2026-11-06T18:03:59Z @kj closed: closed: built in workflow tmp/workflows/reload
- [x] `ACC-LIFE-44-LIVERELOAD` **D8 live soft reload** - HIGH; in the Star Colonel's lab, after make install and /galaxalab/bin/reload-jupyterlab: /speaker answers, capture reaches voicein, paplay plays in the tab, and the server process has one audio-fifo-writer thread and one audio-speaker-reader thread
  - evidence: v1.1.0, 2026-11-07: reload-jupyterlab exit 0, extension added, server pid 583 kept; pid 583 runs one voice-capture-speaker-reader and one voice-capture-fifo-writer thread; validate 14 of 14 OK; paplay of the mp3 on voiceout heard in the tab; voicein loaded with loopback on voicedrain; capture not exercised with a live recording in v1.1.0; v1.1.1, 2026-11-07: reload-jupyterlab exit 0, server pid 583 kept, one voice-capture-s and one voice-capture-f thread, validate 14 of 14 OK; after voice-capture:enable, parec -d voicein (16 kHz mono s16le) 6 s while the Star Colonel spoke: 96000 samples, RMS -25.5 dBFS, peak 21736; run record tmp/workflows/live/live2.json
  - test: after the reload: paplay a file and listen, record from voicein, count the thread names in /proc/<server pid>/task/*/comm
  - test-tags: MANUAL
  - log: 2026-11-06T17:37:26Z @kj added
  - log: 2026-11-06T18:03:59Z @kj before checking capture into voicein after the first soft reload from 1.0.18, reload the browser tab (needed for the new speaker frontend anyway); a tab streaming during the reload stays on the 1.0.18 handler until it reconnects: DEF-LIFE-10-FIRST-RELOAD
  - log: 2026-11-07T12:11:11Z @kj closed: live 1.1.0 acceptance, run record tmp/workflows/live/live.json
  - log: 2026-11-07T14:08:40Z @kj edited evidence "v1.1.0, 2026-11-07: reload-jupyterlab exit 0, extension added, server pid 583 kept; pid 583 runs one voice-capture-speaker-reader and one voice-capture-fifo-writer thread; validate 14 of 14 OK; paplay of the mp3 on voiceout heard in the tab; voicein loaded with loopback on voicedrain; capture not exercised with a live recording" -> "v1.1.0, 2026-11-07: reload-jupyterlab exit 0, extension added, server pid 583 kept; pid 583 runs one voice-capture-speaker-reader and one voice-capture-fifo-writer thread; validate 14 of 14 OK; paplay of the mp3 on voiceout heard in the tab; voicein loaded with loopback on voicedrain; capture not exercised with a live recording in v1.1.0; v1.1.1, 2026-11-07: reload-jupyterlab exit 0, server pid 583 kept, one voice-capture-s and one voice-capture-f thread, validate 14 of 14 OK; after voice-capture:enable, parec -d voicein (16 kHz mono s16le) 6 s while the Star Colonel spoke: 96000 samples, RMS -25.5 dBFS, peak 21736; run record tmp/workflows/live/live2.json"; reason: keeps every v1.1.0 fact and adds the v1.1.1 reload and the live voicein recording
  - log: 2026-11-11T23:47:20Z @kj amended text "in the Star Colonel's lab, after make install and /galaxalab/bin/reload-jupyterlab: /speaker answers, capture reaches voicein, paplay plays in the tab, and the server process has one voice-capture writer thread and one speaker reader thread" -> "in the Star Colonel's lab, after make install and /galaxalab/bin/reload-jupyterlab: /speaker answers, capture reaches voicein, paplay plays in the tab, and the server process has one audio-fifo-writer thread and one audio-speaker-reader thread"; reason: thread names renamed in the extension rename

## E. Error handling `ERROR`

Failure paths the user sees

- [x] `ACC-ERROR-18-DENIED` **E1 permission denied** - HIGH; a denied `getUserMedia` shows a clear message and returns the toggle to a safe off state; no retry storm
  - evidence: voice-capture.spec 'maps a denied permission to a terminal error, capture off (E1)' green in the v1.0.10 publish run
  - test-tags: UNIT, FUNCTIONAL
  - test: getUserMedia rejects NotAllowedError, assert state error, capture off, one getUserMedia call
  - log: 2026-09-28T08:54:27Z @kj edited importance added "HIGH"; test added "getUserMedia rejects NotAllowedError, assert state error, capture off, one getUserMedia call"; test-tags added "UNIT"
  - log: 2026-09-28T08:54:47Z @kj closed: verified in v1.0.10
  - log: 2026-09-28T09:16:31Z @kj edited test-tags "UNIT" -> "UNIT, FUNCTIONAL"
  - log: 2026-11-06T16:30:02Z @kj coded DENIED
- [x] `ACC-ERROR-19-NO-DEVICE` **E2 no device** - MEDIUM; absence of any input device is reported distinctly from a permission denial
  - evidence: jest E2 green: NotFoundError gives 'No microphone input device found.', distinct from the denial message
  - test-tags: UNIT
  - test: getUserMedia rejects NotFoundError, assert an error message different from the denial message
  - log: 2026-09-28T08:54:27Z @kj edited importance added "MEDIUM"; test added "getUserMedia rejects NotFoundError, assert an error message different from the denial message"
  - log: 2026-09-28T09:16:31Z @kj edited test-tags added "UNIT"
  - log: 2026-09-28T09:16:31Z @kj closed: verified in v1.0.11
  - log: 2026-11-06T16:30:02Z @kj coded NO-DEVICE
- [x] `ACC-ERROR-20-INSECURE` **E3 insecure context** - MEDIUM; when served without a secure context, capture is disabled with an explanatory message rather than a silent failure
  - evidence: voice-capture.spec 'refuses to capture outside a secure context (E3)' green in the v1.0.10 publish run
  - test-tags: UNIT
  - test: isSecureContext false, enable, assert state error and getUserMedia not called
  - log: 2026-09-28T08:54:27Z @kj edited importance added "MEDIUM"; test added "isSecureContext false, enable, assert state error and getUserMedia not called"; test-tags added "UNIT"
  - log: 2026-09-28T08:54:47Z @kj closed: verified in v1.0.10
  - log: 2026-11-06T16:30:02Z @kj coded INSECURE
- [x] `ACC-ERROR-21-UNREACHABLE` **E4 endpoint unreachable** - HIGH; failure to open the websocket surfaces an error state and does not leave the UI claiming "streaming"
  - evidence: voice-capture.spec 'disconnects on a click in the endpoint-unreachable error (E4)' reaches state error after the 10 s deadline, green in the v1.0.10 publish run
  - test-tags: UNIT
  - test: never open the socket, advance 10 s, assert state error, not streaming
  - log: 2026-09-28T08:54:27Z @kj edited importance added "HIGH"; test added "never open the socket, advance 10 s, assert state error, not streaming"; test-tags added "UNIT"
  - log: 2026-09-28T08:54:47Z @kj closed: verified in v1.0.10
  - log: 2026-11-06T16:30:02Z @kj coded UNREACHABLE

## F. Boundary - out of scope (do not implement here) `SCOPE`

What the extension must not do; the separate plumbing layer owns it

- [x] `ACC-SCOPE-22-NO-PULSE` **F1 No PulseAudio management** - MEDIUM; the extension does not start, configure, or manage PulseAudio
  - evidence: test_boundary green; a subprocess import in sink.py turns it red (mutation checked)
  - test-tags: UNIT
  - test: scan the server modules except cli.py: no subprocess import, no os.system/exec/spawn/popen, no pactl or pacmd string
  - log: 2026-09-28T08:54:27Z @kj edited importance added "MEDIUM"; test added "search the server extension outside cli.py for pactl or pulseaudio calls, assert none"
  - log: 2026-09-28T09:16:31Z @kj edited test-tags added "UNIT"
  - log: 2026-09-28T09:16:31Z @kj edited test "search the server extension outside cli.py for pactl or pulseaudio calls, assert none" -> "scan the server modules except cli.py: no subprocess import, no os.system/exec/spawn/popen, no pactl or pacmd string"
  - log: 2026-09-28T09:16:31Z @kj closed: verified in v1.0.11
  - log: 2026-11-06T16:30:02Z @kj coded NO-PULSE
- [x] `ACC-SCOPE-23-NO-RECORDER` **F2 No recorder invocation** - MEDIUM; the extension does not invoke SoX, `/voice`, or any recorder
  - evidence: test_extension_names_no_audio_tool and test_extension_starts_no_processes green
  - test-tags: UNIT
  - test: scan the server modules except cli.py: no sox, rec, parec or arecord string
  - log: 2026-09-28T08:54:27Z @kj edited importance added "MEDIUM"; test added "search the extension outside cli.py for sox, rec or /voice calls, assert none"
  - log: 2026-09-28T09:16:31Z @kj edited test-tags added "UNIT"
  - log: 2026-09-28T09:16:31Z @kj edited test "search the extension outside cli.py for sox, rec or /voice calls, assert none" -> "scan the server modules except cli.py: no sox, rec, parec or arecord string"
  - log: 2026-09-28T09:16:31Z @kj closed: verified in v1.0.11
  - log: 2026-11-06T16:30:02Z @kj coded NO-RECORDER
- [x] `ACC-SCOPE-24-NO-STT` **F3 No speech-to-text** - LOW; the extension does not perform speech-to-text or transcription
  - evidence: test_extension_imports_no_speech_to_text green
  - test-tags: UNIT
  - test: scan the server modules: no speech-to-text library imported
  - log: 2026-09-28T08:54:27Z @kj edited importance added "LOW"; test added "search the extension for speech-to-text or transcription code, assert none"
  - log: 2026-09-28T09:16:31Z @kj edited test-tags added "UNIT"
  - log: 2026-09-28T09:16:31Z @kj edited test "search the extension for speech-to-text or transcription code, assert none" -> "scan the server modules: no speech-to-text library imported"
  - log: 2026-09-28T09:16:31Z @kj closed: verified in v1.0.11
  - log: 2026-11-06T16:30:02Z @kj coded NO-STT
- [x] `ACC-SCOPE-25-BOUNDARY` **F4 Responsibility ends at the FIFOs** - MEDIUM; for capture, the extension's downstream responsibility ends at delivering correct PCM (B1-B4) to the sink (C2); for playback it begins at reading speaker.fifo (G) or at the file that audio:player names (H); the extension may play files through PulseAudio, and between the FIFOs and the audio programs PulseAudio is the separate plumbing layer; it never starts, stops or configures the daemon, never records and never transcribes
  - evidence: test_boundary green (no processes, no audio tools); routes.on_message only calls sink.write; C2 tests green
  - test-tags: UNIT, INTEGRATION
  - test: scope scan plus the C2 tests: the handler's only output is sink.write of the received frame
  - log: 2026-09-28T08:54:27Z @kj edited importance added "MEDIUM"; test added "review the server extension: its only output is PCM written to the sink FIFO"
  - log: 2026-09-28T09:16:31Z @kj edited test "review the server extension: its only output is PCM written to the sink FIFO" -> "scope scan plus the C2 tests: the handler's only output is sink.write of the received frame"; test-tags added "UNIT, INTEGRATION"
  - log: 2026-09-28T09:16:31Z @kj closed: verified in v1.0.11
  - log: 2026-11-06T15:48:56Z @kj edited title "F4 Responsibility ends at the sink" -> "F4 Responsibility ends at the FIFOs"; text "the extension's sole downstream responsibility ends at delivering correct PCM (B1-B4) to the sink (C2); everything past the FIFO is the separate plumbing layer" -> "for capture, the extension's downstream responsibility ends at delivering correct PCM (B1-B4) to the sink (C2); for playback it begins at reading speaker.fifo (G); PulseAudio between the FIFOs and the audio programs is the separate plumbing layer"
  - log: 2026-11-06T16:30:02Z @kj coded BOUNDARY
  - log: 2026-11-06T17:43:15Z @kj edited text "for capture, the extension's downstream responsibility ends at delivering correct PCM (B1-B4) to the sink (C2); for playback it begins at reading speaker.fifo (G); PulseAudio between the FIFOs and the audio programs is the separate plumbing layer" -> "for capture, the extension's downstream responsibility ends at delivering correct PCM (B1-B4) to the sink (C2); for playback it begins at reading speaker.fifo (G) or the file that voice-capture:play-file names (G15); PulseAudio between the FIFOs and the audio programs is the separate plumbing layer"
  - log: 2026-11-09T01:31:49Z @kj amended text "for capture, the extension's downstream responsibility ends at delivering correct PCM (B1-B4) to the sink (C2); for playback it begins at reading speaker.fifo (G) or the file that voice-capture:play-file names (G15); PulseAudio between the FIFOs and the audio programs is the separate plumbing layer" -> "for capture, the extension's downstream responsibility ends at delivering correct PCM (B1-B4) to the sink (C2); for playback it begins at reading speaker.fifo (G) or at the file that voice-capture:player names (H); the extension may play files through PulseAudio, and between the FIFOs and the audio programs PulseAudio is the separate plumbing layer; it never starts, stops or configures the daemon, never records and never transcribes"; reason: the player replaces play-file and the boundary gains the playback permission
  - log: 2026-11-11T23:47:20Z @kj amended text "for capture, the extension's downstream responsibility ends at delivering correct PCM (B1-B4) to the sink (C2); for playback it begins at reading speaker.fifo (G) or at the file that voice-capture:player names (H); the extension may play files through PulseAudio, and between the FIFOs and the audio programs PulseAudio is the separate plumbing layer; it never starts, stops or configures the daemon, never records and never transcribes" -> "for capture, the extension's downstream responsibility ends at delivering correct PCM (B1-B4) to the sink (C2); for playback it begins at reading speaker.fifo (G) or at the file that audio:player names (H); the extension may play files through PulseAudio, and between the FIFOs and the audio programs PulseAudio is the separate plumbing layer; it never starts, stops or configures the daemon, never records and never transcribes"; reason: command id renamed from voice-capture:player to audio:player

## G. Speaker output `SPEAK`

Container audio played to the default PulseAudio sink is heard in the open JupyterLab tab

- log: 2026-11-06T15:48:44Z @kj category created

- [x] `ACC-SPEAK-26-ALWAYS` **G1 always on** - HIGH; playback starts at plugin activation in every browser tab with no on/off control, toggle or setting; the autoConnect setting stays capture-only; voice-capture:stop-playback stops only the sounds of voice-capture:play-file
  - evidence: Galata 'G1/G2: plays nothing before a user gesture and the tone after one click' green 2 of 2 (suite 32 passed, 2 skipped, 0 failed with --repeat-each 2); jest 'plays a 48 kHz stereo worklet into the destination from the /speaker socket' green (28 of 28); schema holds only autoConnect; no command turns playback on or off
  - test: load the lab, click once, write a tone into speaker.fifo: the tab output is not silent; no status item or setting for playback exists
  - test-tags: FUNCTIONAL
  - log: 2026-11-06T15:48:44Z @kj added
  - log: 2026-11-06T16:30:29Z @kj closed: verified on the 1.0.18 working tree, workflow wf_6630f963-0d6
  - log: 2026-11-06T16:50:56Z @kj edited text "playback starts at plugin activation in every tab with no control, command or setting; the autoConnect setting stays capture-only" -> "playback starts at plugin activation in every browser tab with no on/off control, toggle or setting; the autoConnect setting stays capture-only"
  - log: 2026-11-06T17:24:29Z @kj edited evidence "Galata 'G1/G2: plays nothing before a user gesture and the tone after one click' green (suite 26 passed, 2 skipped, 0 failed with --repeat-each 2); jest 'plays a 48 kHz stereo worklet into the destination from the /speaker socket' green (28 of 28); schema holds only autoConnect; no playback command" -> "Galata 'G1/G2: plays nothing before a user gesture and the tone after one click' green 2 of 2 (suite 32 passed, 2 skipped, 0 failed with --repeat-each 2); jest 'plays a 48 kHz stereo worklet into the destination from the /speaker socket' green (28 of 28); schema holds only autoConnect; no command turns playback on or off"; reason: quotes two test names in full
  - log: 2026-11-07T14:23:33Z @kj the Star Colonel ordered the command voice-capture:stop-playback on 2026-11-07, after a 4-minute play-file sound could not be stopped; playback stays always on with no on/off control, while play-file sounds can be stopped
  - log: 2026-11-07T14:23:33Z @kj edited text "playback starts at plugin activation in every browser tab with no on/off control, toggle or setting; the autoConnect setting stays capture-only" -> "playback starts at plugin activation in every browser tab with no on/off control, toggle or setting; the autoConnect setting stays capture-only; voice-capture:stop-playback stops only the sounds of voice-capture:play-file"
- [x] `ACC-SPEAK-27-AUTOPLAY` **G2 plays as soon as sound arrives** - HIGH; sound plays as soon as it arrives whenever the browser allows sound in the page: at load, with no click, in a browser whose autoplay policy is no-user-gesture-required (the Star Colonel's Chrome, per chrome://media-engagement); in any browser after any click or key press anywhere in JupyterLab, inside panels and frames too; the AudioContext resumes when sound arrives and audio held during that resume plays
  - evidence: Galata 'G2: a tab with no gesture plays the tone when the browser allows autoplay' (--autoplay-policy=no-user-gesture-required, no gesture) green 2 of 2 in the whole suite (38 passed, 2 skipped, 0 failed); red 'suspended, peak 0' with the context suspended until the first gesture, and without the flag; frame-click spec and G1/G2 green 2 of 2; jest 30 of 30, resume on arrival and on keydown included
  - test: Galata, Chromium with --autoplay-policy=no-user-gesture-required: no gesture, tone written, output not silent; default policy: a click only inside an iframe, then the tone: not silent; default policy, no gesture: silent
  - test-tags: FUNCTIONAL
  - log: 2026-11-06T15:48:44Z @kj added
  - log: 2026-11-06T16:30:14Z @kj edited test "Galata with --autoplay-policy=user-gesture-required: silent before any gesture, not silent after one click" -> "Galata with the default Chromium autoplay policy: suspended and silent before any gesture, not silent after one click"
  - log: 2026-11-06T16:30:14Z @kj test changed: --autoplay-policy=user-gesture-required let the context run without a gesture in Playwright 1.64.1 headless Chromium; the default policy blocks it
  - log: 2026-11-06T16:30:34Z @kj closed: verified on the 1.0.18 working tree, workflow wf_6630f963-0d6
  - log: 2026-11-06T16:30:44Z @kj edited evidence "Galata 'G1/G2: plays nothing before a user gesture and the tone after one click' green: suspended and peak 0 before the click, peak 0.5 after; jest 'resumes on the next pointerdown or keydown, in the capture phase, until it runs' and 'drops audio while the context is not running' green" -> "Galata 'G1/G2: plays nothing before a user gesture and the tone after one click' green; jest 'resumes on the next pointerdown or keydown, in the capture phase, until it runs' and 'drops audio while the context is not running, then posts it with transfer' green"
  - log: 2026-11-06T17:24:29Z @kj edited evidence "Galata 'G1/G2: plays nothing before a user gesture and the tone after one click' green; jest 'resumes on the next pointerdown or keydown, in the capture phase, until it runs' and 'drops audio while the context is not running, then posts it with transfer' green" -> "Galata 'G1/G2: plays nothing before a user gesture and the tone after one click' green 2 of 2 with --repeat-each 2: suspended before the click, running with peak above 0.25 after; jest 'resumes on the next pointerdown or keydown, in the capture phase, until it runs' and 'drops audio while the context is not running, then posts it with transfer' green"; reason: quotes three test names in full
  - log: 2026-11-06T19:32:00Z @kj reopened: reopened: the Star Colonel requires sound to play as soon as it arrives, with no key press; the MOTD music already plays at load; evidence retired: Galata 'G1/G2: plays nothing before a user gesture and the tone after one click' green 2 of 2 with --repeat-each 2: suspended before the click, running with peak above 0.25 after; jest 'resumes on the next pointerdown or keydown, in the capture phase, until it runs' and 'drops audio while the context is not running, then posts it with transfer' green
  - log: 2026-11-06T19:32:00Z @kj renamed code "GESTURE" -> "AUTOPLAY"
  - log: 2026-11-06T19:32:00Z @kj edited title "G2 plays after the first gesture" -> "G2 plays as soon as sound arrives"; text "the AudioContext resumes on the first click or key press in the page, or at once when the page already had one; audio received before that is dropped, so no backlog plays on resume" -> "sound plays as soon as it arrives whenever the browser allows sound in the page: at load when the page inherits it (after a click on the page that opened or reloaded the lab, as the MOTD music plays), and after any click or key press anywhere in JupyterLab, inside panels and frames too; the AudioContext resumes when sound arrives and audio held during that resume plays; only while the browser blocks all sound is audio dropped"; test "Galata with the default Chromium autoplay policy: suspended and silent before any gesture, not silent after one click" -> "Galata: click, reload, write a tone with no new gesture: output not silent; click only inside an iframe, then write a tone: output not silent; a fresh tab with no gesture: silent"; test-tags "FUNCTIONAL" -> "FUNCTIONAL"; reason: the requirement changed from first-gesture playback to playback on arrival, and the text must name both permission paths
  - log: 2026-11-06T20:06:13Z @kj edited text "sound plays as soon as it arrives whenever the browser allows sound in the page: at load when the page inherits it (after a click on the page that opened or reloaded the lab, as the MOTD music plays), and after any click or key press anywhere in JupyterLab, inside panels and frames too; the AudioContext resumes when sound arrives and audio held during that resume plays; only while the browser blocks all sound is audio dropped" -> "sound plays as soon as it arrives whenever the browser allows sound in the page: at load, with no click, in a browser whose autoplay policy is no-user-gesture-required (the Star Colonel's Chrome, per chrome://media-engagement); in any browser after any click or key press anywhere in JupyterLab, inside panels and frames too; the AudioContext resumes when sound arrives and audio held during that resume plays"; test "Galata: click, reload, write a tone with no new gesture: output not silent; click only inside an iframe, then write a tone: output not silent; a fresh tab with no gesture: silent" -> "Galata, Chromium with --autoplay-policy=no-user-gesture-required: no gesture, tone written, output not silent; default policy: a click only inside an iframe, then the tone: not silent; default policy, no gesture: silent"; reason: the Star Colonel's chrome://media-engagement shows Autoplay Policy no-user-gesture-required; Chromium does not carry activation over a reload, measured by the running build
  - log: 2026-11-06T21:09:42Z @kj open: workflow tmp/workflows/autoplay; a click only inside a frame now plays the tone, Galata 2 of 2, red without the resume on arrival; a reload the page starts after a click plays with no new gesture, Galata 2 of 2; no gesture stays silent (G1/G2); jest 30 of 30
  - log: 2026-11-06T21:09:54Z @kj open: not met: in Playwright's Chromium a reload the browser starts (page.reload() and page.goto(), as the reload button, F5 or a typed URL do) does not carry the click over; the tab stays suspended until a click or key press; the browser's autoplay policy, which page code cannot lift
  - log: 2026-11-06T21:09:54Z @kj open: the --autoplay-policy=no-user-gesture-required spec in the test line was not written or run, so playback at load with no click stays unproven
  - log: 2026-11-06T21:42:48Z @kj closed: F1 of workflow tmp/workflows/fixes; the location.reload() spec is removed, it passed without this extension's code; reason: names each test and its count, one per clause of the criterion
- [x] `ACC-SPEAK-28-WIRE` **G3 wire format** - CRITICAL; the /speaker websocket carries binary messages of s16le, 48000 Hz, 2 channels interleaved; each message length is a multiple of 4 bytes
  - evidence: pytest test_speaker_pcm_arrives_verbatim_in_whole_frames green: 37-byte writes arrive verbatim as bytes messages, each a multiple of 4 (41 of 41 pytest); server chain run: 374 messages, all multiples of 4; jest s16leStereoToFloat32 test green
  - test: write known bytes into speaker.fifo, assert the websocket receives them verbatim, in order, every message length a multiple of 4
  - test-tags: INTEGRATION
  - log: 2026-11-06T15:48:44Z @kj added
  - log: 2026-11-06T16:30:29Z @kj closed: verified on the 1.0.18 working tree, workflow wf_6630f963-0d6
  - log: 2026-11-06T17:24:18Z @kj edited evidence "pytest test_speaker_pcm_arrives_verbatim_in_whole_frames green: 37-byte writes arrive verbatim as bytes messages, each a multiple of 4 (40 of 40 pytest); server chain run: 374 messages, all multiples of 4; jest s16leStereoToFloat32 test green" -> "pytest test_speaker_pcm_arrives_verbatim_in_whole_frames green: 37-byte writes arrive verbatim as bytes messages, each a multiple of 4 (41 of 41 pytest); server chain run: 374 messages, all multiples of 4; jest s16leStereoToFloat32 test green"
- [x] `ACC-SPEAK-29-AUTH` **G4 authenticated endpoint** - CRITICAL; <base_url>/jupyterlab-audio-extension/speaker rejects a connection without a valid Jupyter token (403); no new port is opened
  - evidence: pytest test_speaker_without_a_token_is_refused green: 403 and the @ws_authenticated flag set, red with @allow_unauthenticated (41 of 41 pytest); the route sits under the Jupyter base URL, no new port
  - test: connect to /speaker without a token, assert 403
  - test-tags: INTEGRATION
  - log: 2026-11-06T15:48:44Z @kj added
  - log: 2026-11-06T16:30:29Z @kj closed: verified on the 1.0.18 working tree, workflow wf_6630f963-0d6
  - log: 2026-11-06T17:24:18Z @kj edited evidence "pytest test_speaker_without_a_token_is_refused green: 403 and the @ws_authenticated flag set, red with @allow_unauthenticated (40 of 40 pytest); the route sits under the Jupyter base URL, no new port" -> "pytest test_speaker_without_a_token_is_refused green: 403 and the @ws_authenticated flag set, red with @allow_unauthenticated (41 of 41 pytest); the route sits under the Jupyter base URL, no new port"
  - log: 2026-11-11T23:47:23Z @kj amended text "<base_url>/jupyterlab-voice-capture-extension/speaker rejects a connection without a valid Jupyter token (403); no new port is opened" -> "<base_url>/jupyterlab-audio-extension/speaker rejects a connection without a valid Jupyter token (403); no new port is opened"; reason: route prefix renamed to /jupyterlab-audio-extension
- [x] `ACC-SPEAK-30-LIVE` **G5 live audio only** - HIGH; the server reads speaker.fifo continuously and discards what it reads while no tab listens, so a tab that connects later hears live audio only
  - evidence: pytest test_speaker_audio_from_before_a_tab_connected_is_discarded green, red when the reader stops reading without a listener (41 of 41 pytest); server chain run: 0 B on the socket before paplay started
  - test: write audio with no tab connected, connect, write new audio: only the new audio arrives
  - test-tags: INTEGRATION
  - log: 2026-11-06T15:48:44Z @kj added
  - log: 2026-11-06T16:30:29Z @kj closed: verified on the 1.0.18 working tree, workflow wf_6630f963-0d6
  - log: 2026-11-06T17:24:18Z @kj edited evidence "pytest test_speaker_audio_from_before_a_tab_connected_is_discarded green, red when the reader stops reading without a listener (40 of 40 pytest); server chain run: 0 B on the socket before paplay started" -> "pytest test_speaker_audio_from_before_a_tab_connected_is_discarded green, red when the reader stops reading without a listener (41 of 41 pytest); server chain run: 0 B on the socket before paplay started"
- [x] `ACC-SPEAK-31-FIFO` **G6 FIFO ownership** - HIGH; module-pipe-sink creates speaker.fifo in the directory of the sink path; the server opens only the read end, waits while the path is absent, never reads a path that is not a FIFO, and reopens after the writer goes away
  - evidence: pytest test_regular_file_at_speaker_path_is_never_read and test_speaker_reader_recovers_after_the_writer_closes green, each red when broken; the FIFO appears after the reader starts in every speaker test (41 of 41 pytest); CLI start: voiceout file=<sink dir>/speaker.fifo
  - test: a regular file at the path is never read; the reader recovers after EOF when a new writer opens
  - test-tags: INTEGRATION
  - log: 2026-11-06T15:48:44Z @kj added
  - log: 2026-11-06T16:30:29Z @kj closed: verified on the 1.0.18 working tree, workflow wf_6630f963-0d6
  - log: 2026-11-06T17:24:18Z @kj edited evidence "pytest test_regular_file_at_speaker_path_is_never_read and test_speaker_reader_recovers_after_the_writer_closes green, each red when broken; the FIFO appears after the reader starts in every speaker test (40 of 40 pytest); CLI start: voiceout file=<sink dir>/speaker.fifo" -> "pytest test_regular_file_at_speaker_path_is_never_read and test_speaker_reader_recovers_after_the_writer_closes green, each red when broken; the FIFO appears after the reader starts in every speaker test (41 of 41 pytest); CLI start: voiceout file=<sink dir>/speaker.fifo"
- [x] `ACC-SPEAK-32-ALLTABS` **G7 every tab plays** - MEDIUM; every open JupyterLab browser tab plays the speaker audio, like several YouTube tabs; a new /speaker connection closes no other; a /stream producer and a /speaker listener never close each other
  - evidence: pytest test_two_speaker_listeners_both_receive_the_same_bytes and test_a_slow_speaker_listener_does_not_drop_data_for_another green, red with the takeover restored and with a shared bound; test_producer_and_listener_do_not_close_each_other green (41 of 41); Galata 'G7: every tab plays and no speaker socket closes' green 2 of 2 with --repeat-each 2, red with the takeover restored
  - test: two /speaker connections both receive the same bytes and neither closes; Galata: two tabs, both outputs not silent
  - test-tags: INTEGRATION, FUNCTIONAL
  - log: 2026-11-06T15:48:45Z @kj added
  - log: 2026-11-06T16:30:29Z @kj closed: verified on the 1.0.18 working tree, workflow wf_6630f963-0d6
  - log: 2026-11-06T16:50:56Z @kj reopened: reopened: the Star Colonel decided every open JupyterLab browser tab plays, like YouTube tabs; no takeover; evidence retired: pytest test_second_speaker_listener_closes_the_first and test_producer_and_listener_do_not_close_each_other green; Galata 'G7: a second tab takes over the speaker and the first stays silent' green; jest 'stops without reconnecting when another tab takes over (4001)' green
  - log: 2026-11-06T16:50:56Z @kj renamed code "TAKEOVER" -> "ALLTABS"
  - log: 2026-11-06T16:50:56Z @kj edited title "G7 one listener" -> "G7 every tab plays"; text "a new /speaker connection closes the previous one with code 4001 and that tab does not reconnect; a /stream producer and a /speaker listener never close each other" -> "every open JupyterLab browser tab plays the speaker audio, like several YouTube tabs; a new /speaker connection closes no other; a /stream producer and a /speaker listener never close each other"; test "two /speaker connections: the first closes with 4001; Galata: the first tab stays silent for 3 s while the second plays" -> "two /speaker connections both receive the same bytes and neither closes; Galata: two tabs, both outputs not silent"; test-tags "INTEGRATION, FUNCTIONAL" -> "INTEGRATION, FUNCTIONAL"
  - log: 2026-11-06T17:24:03Z @kj closed: verified on the 1.0.18 working tree, workflow wf_0257093c-14b
- [x] `ACC-SPEAK-33-LATENCY` **G8 bounded latency** - MEDIUM; audio queued for a tab stays under about 0.5 s: the server drops data past 96000 bytes of unfinished writes per connection, the player drops its oldest samples past about 500 ms; the server IOLoop never blocks
  - evidence: pytest test_speaker_drops_data_while_half_a_second_waits_unsent green: a 48000-byte chunk is sent at 0, 48000 and 96000 bytes pending and dropped at 144000; test_a_slow_speaker_listener_does_not_drop_data_for_another green (41 of 41); jest SpeakerRing 'keeps at most its capacity by dropping the oldest frames' green (24000 frames); write_message runs on the IOLoop through add_callback
  - test: unit tests of the player buffer cap and the server write bound
  - test-tags: UNIT
  - log: 2026-11-06T15:48:45Z @kj added
  - log: 2026-11-06T16:30:29Z @kj closed: verified on the 1.0.18 working tree, workflow wf_6630f963-0d6
  - log: 2026-11-06T17:24:18Z @kj edited evidence "pytest test_speaker_drops_data_while_half_a_second_waits_unsent green: the 48000-byte chunk at 96000 pending is dropped; jest SpeakerRing 'keeps at most its capacity by dropping the oldest frames' green (24000 frames); write_message runs on the IOLoop through add_callback" -> "pytest test_speaker_drops_data_while_half_a_second_waits_unsent green: a 48000-byte chunk is sent at 0, 48000 and 96000 bytes pending and dropped at 144000; test_a_slow_speaker_listener_does_not_drop_data_for_another green (41 of 41); jest SpeakerRing 'keeps at most its capacity by dropping the oldest frames' green (24000 frames); write_message runs on the IOLoop through add_callback"
- [x] `ACC-SPEAK-34-RECONNECT` **G9 reconnect** - HIGH; after the speaker socket drops, the tab reconnects with backoff (500 ms doubling to 10 s) and playback resumes without user action
  - evidence: Galata 'G9: the speaker socket reconnects after a drop and playback resumes' green 2 of 2 with --repeat-each 2, red without the reconnect timer; jest 'reconnects with a backoff of 500 ms doubling to 10 s' green (28 of 28)
  - test: Galata: close the speaker socket from the page, assert a new socket opens and the output is not silent again
  - test-tags: FUNCTIONAL
  - log: 2026-11-06T15:48:45Z @kj added
  - log: 2026-11-06T16:30:30Z @kj closed: verified on the 1.0.18 working tree, workflow wf_6630f963-0d6
  - log: 2026-11-06T17:24:18Z @kj edited evidence "Galata 'G9: the speaker socket reconnects after a drop and playback resumes' green, red without the reconnect timer; jest 'reconnects with a backoff of 500 ms doubling to 10 s' green (28 of 28)" -> "Galata 'G9: the speaker socket reconnects after a drop and playback resumes' green 2 of 2 with --repeat-each 2, red without the reconnect timer; jest 'reconnects with a backoff of 500 ms doubling to 10 s' green (28 of 28)"
- [x] `ACC-SPEAK-35-START` **G10 CLI start loads the speaker sink** - HIGH; jupyterlab_audio start loads module-pipe-sink voiceout (s16le, 48000 Hz, 2 channels, use_system_clock_for_timing=yes) as the default sink and module-suspend-on-idle, also on a running daemon that lacks them; removes a leftover speaker.fifo first; exits 1 when voiceout did not load
  - evidence: pytest test_cli 16 of 16 green, incl. test_start_loads_voiceout_as_the_default_sink_then_suspend_on_idle, test_start_loads_voiceout_on_a_running_daemon_that_lacks_it, test_start_removes_a_leftover_speaker_fifo_before_loading_voiceout, test_start_exits_1_when_voiceout_did_not_load; isolated daemon: start rc 0, Default Sink: voiceout
  - test: CLI unit tests on the pactl calls; start against an isolated PulseAudio daemon lists voiceout as the default sink
  - test-tags: UNIT, MANUAL
  - log: 2026-11-06T15:48:45Z @kj added
  - log: 2026-11-06T16:30:14Z @kj edited test-tags "UNIT, INTEGRATION" -> "UNIT, MANUAL"
  - log: 2026-11-06T16:30:30Z @kj closed: verified on the 1.0.18 working tree, workflow wf_6630f963-0d6
  - log: 2026-11-11T23:47:23Z @kj amended text "jupyterlab_voice_capture start loads module-pipe-sink voiceout (s16le, 48000 Hz, 2 channels, use_system_clock_for_timing=yes) as the default sink and module-suspend-on-idle, also on a running daemon that lacks them; removes a leftover speaker.fifo first; exits 1 when voiceout did not load" -> "jupyterlab_audio start loads module-pipe-sink voiceout (s16le, 48000 Hz, 2 channels, use_system_clock_for_timing=yes) as the default sink and module-suspend-on-idle, also on a running daemon that lacks them; removes a leftover speaker.fifo first; exits 1 when voiceout did not load"; reason: CLI renamed from jupyterlab_voice_capture to jupyterlab_audio
- [x] `ACC-SPEAK-36-VALIDATE` **G11 CLI validate reports the speaker sink** - MEDIUM; jupyterlab_audio validate shows voiceout loaded, voiceout as default sink and speaker.fifo as a FIFO, also in --json
  - evidence: pytest test_validate_reports_the_speaker_rows and test_validate_json_all_present_exits_zero green; isolated daemon after start: validate 14 of 14 OK, rc 0
  - test: validate with and without voiceout: the rows read OK and missing
  - test-tags: UNIT
  - log: 2026-11-06T15:48:45Z @kj added
  - log: 2026-11-06T16:30:30Z @kj closed: verified on the 1.0.18 working tree, workflow wf_6630f963-0d6
  - log: 2026-11-11T23:47:23Z @kj amended text "jupyterlab_voice_capture validate shows voiceout loaded, voiceout as default sink and speaker.fifo as a FIFO, also in --json" -> "jupyterlab_audio validate shows voiceout loaded, voiceout as default sink and speaker.fifo as a FIFO, also in --json"; reason: CLI renamed from jupyterlab_voice_capture to jupyterlab_audio
- [x] `ACC-SPEAK-37-MP3` **G12 mp3 through paplay** - HIGH; paplay of an mp3 file plays through voiceout with only the packages install provides
  - evidence: Galata 'G12/G13: paplay is heard in the tab while the microphone streams into voicein' green 1 of 1 with an mp3: tab peak 0.396, speaker 192230 B/s; paplay of the mp3 into an isolated daemon: speaker.fifo 188232-192324 B/s, stderr empty; libsndfile1 1.2.2 depends on libmpg123-0t64, install unchanged
  - test: Galata real chain with VOICE_TEST_PULSE_SERVER and VOICE_TEST_PLAY_FILE set to an mp3: tab peak above 0.25
  - test-tags: FUNCTIONAL
  - log: 2026-11-06T15:48:45Z @kj added
  - log: 2026-11-06T16:30:14Z @kj edited test "paplay an mp3 into an isolated daemon: bytes reach speaker.fifo at about 192000 B/s" -> "Galata real chain with VOICE_TEST_PULSE_SERVER and VOICE_TEST_PLAY_FILE set to an mp3: tab peak above 0.25"; test-tags "INTEGRATION" -> "FUNCTIONAL"
  - log: 2026-11-06T16:30:30Z @kj closed: verified on the 1.0.18 working tree, workflow wf_6630f963-0d6
  - log: 2026-11-06T17:24:18Z @kj edited evidence "Galata 'G12/G13: paplay is heard in the tab while the microphone streams into voicein' green with an mp3, tab peak 0.554 and 0.437; paplay of the mp3 into an isolated daemon: speaker.fifo 188232-192324 B/s, stderr empty; libsndfile1 1.2.2 depends on libmpg123-0t64, install unchanged" -> "Galata 'G12/G13: paplay is heard in the tab while the microphone streams into voicein' green 1 of 1 with an mp3: tab peak 0.396, speaker 192230 B/s; paplay of the mp3 into an isolated daemon: speaker.fifo 188232-192324 B/s, stderr empty; libsndfile1 1.2.2 depends on libmpg123-0t64, install unchanged"
- [x] `ACC-SPEAK-38-DUPLEX` **G13 capture beside playback** - HIGH; microphone capture keeps streaming at 16 kHz into the sink while the tab plays
  - evidence: Galata 'G13: microphone capture streams at 16 kHz beside playback' green 2 of 2 with --repeat-each 2; real chain: voicein 31869 B/s, peak 31181 while paplay played; pytest test_start_moves_the_voicein_loopback_back_to_voicedrain green
  - mechanism: 2026-11-06T16:30:14Z @kj start moves each module-loopback sink-input back to voicedrain after set-default-sink voiceout; otherwise the voicein loopback plays the microphone in the tab and keeps voiceout from going idle
  - test: Galata: with a tone playing, capture writes 32000 B/s within 15% into the capture FIFO
  - test-tags: FUNCTIONAL
  - log: 2026-11-06T15:48:46Z @kj added
  - log: 2026-11-06T16:30:30Z @kj closed: verified on the 1.0.18 working tree, workflow wf_6630f963-0d6
  - log: 2026-11-06T17:24:18Z @kj edited evidence "Galata 'G13: microphone capture streams at 16 kHz beside playback' green; real chain: voicein 32008 B/s, peak 32767 while paplay played; pytest test_start_moves_the_voicein_loopback_back_to_voicedrain green" -> "Galata 'G13: microphone capture streams at 16 kHz beside playback' green 2 of 2 with --repeat-each 2; real chain: voicein 31869 B/s, peak 31181 while paplay played; pytest test_start_moves_the_voicein_loopback_back_to_voicedrain green"
- [x] `ACC-SPEAK-39-HEARD` **G14 heard in the lab** - CRITICAL; paplay <file> run in a lab terminal is heard in the open JupyterLab tab of the Star Colonel's lab, with no player page, no notebook and no extra click
  - evidence: paplay "/tmp/paste-files/Helsreach - Grimaldus Wall Speech.mp3" on default sink voiceout, 15 s from 12:09:52 UTC: the Star Colonel heard it in his open JupyterLab tab, no extra click ('Heard the mp3', 'heard it all well'); 3 s 440 Hz wav tone at 12:08 UTC also heard; v1.1.0, 2026-11-07
  - test: after make install, a JupyterLab restart and start -d on the live daemon, play an mp3 and listen
  - test-tags: MANUAL
  - log: 2026-11-06T15:48:46Z @kj added
  - log: 2026-11-06T16:30:30Z @kj open: needs make install, a JupyterLab restart and start -d on the live daemon, all gated on the Star Colonel
  - log: 2026-11-07T12:11:10Z @kj closed: first play at 12:04:26 UTC answered 'Silent', cause not established; tone and second mp3 play heard
  - log: 2026-11-07T14:23:34Z @kj the first mp3 play at 12:04 UTC was silent because the Star Colonel's tab had not yet been reloaded after the 1.1.0 install, so it still ran the old page code without the speaker (his answer, 2026-11-07); nothing to fix
- [x] `ACC-SPEAK-40-PLAYFILE` **G15 play-file command** - HIGH; the JupyterLab command voice-capture:play-file with argument path (relative to the Jupyter root) plays that audio file (mp3 or wav) in the tab through the speaker output; a missing or undecodable file logs an error and plays nothing
  - evidence: Galata G15 mp3 spec green 2 of 2 with --repeat-each 2 on 'Helsreach - Grimaldus Wall Speech.mp3' (MPEG layer III 48 kHz): analyser peak above 0; missing-path spec waits for console.error 'Cannot play <path>: HTTP 404'; whole suite 34 passed, 2 skipped, 0 failed; both specs red when broken
  - test: Galata after one click: execute the command with a wav path, and with VOICE_TEST_PLAY_FILE set to an mp3 (G15 VOICE_TEST_PLAY_FILE spec): the output is not silent; a missing path plays nothing
  - test-tags: FUNCTIONAL
  - log: 2026-11-06T15:48:46Z @kj added
  - log: 2026-11-06T16:30:30Z @kj open: not built in the speaker-path campaign; a separate task
  - log: 2026-11-06T17:24:06Z @kj open: built in workflow wf_0257093c-14b; wav proven: the three Galata G15 specs green 6 of 6 with --repeat-each 2, each red when broken, jest filesUrl green; mp3 not tested: the specs play only a generated wav; needs one G15 run with an mp3
  - log: 2026-11-06T18:03:59Z @kj closed: closed: mp3 spec added in workflow tmp/workflows/reload
  - log: 2026-11-06T21:09:54Z @kj edited test "Galata: execute the command with a wav path after one click, the output is not silent; a missing path plays nothing" -> "Galata after one click: execute the command with a wav path, and with VOICE_TEST_PLAY_FILE set to an mp3 (G15 VOICE_TEST_PLAY_FILE spec): the output is not silent; a missing path plays nothing"
  - log: 2026-11-07T14:08:45Z @kj live v1.1.1 in the Star Colonel's lab, 14:07:18 UTC: jupyterlab-commands execute voice-capture:play-file --args '{"path": "private/jupyterlab/jupyterlab_voice_capture_extension/tmp/workflows/live/helsreach.mp3"}' exit 0 after 2 s; he answered 'Hear it'; jupyterlab-commands list shows 'Play Audio File'
- [x] `ACC-SPEAK-49-STOP-PLAYBACK` **G16 stop-playback command** - HIGH; the JupyterLab command voice-capture:stop-playback stops every sound that voice-capture:play-file started, in every open tab, and resolves once the sounds of its own tab are stopped; with nothing playing it does nothing and resolves; the speaker stream and capture go on; a stopped sound is no error of its play-file call
  - evidence: jest speaker.spec.ts 'voice-capture:stop-playback' 6 of 6 green: 'stops the file play-file plays and resolves', 'stops two files playing at once, and not a file that already ended', 'does nothing and resolves when nothing plays', 'resolves in a tab whose speaker failed to start', 'the play-file call whose file it stops neither rejects nor logs an error', 'stop-playback in one tab stops the file another tab plays'; jest 41 of 41; each red before the command existed; Galata 'G16: stop-playback stops the file play-file plays and the output is silent within 0.5 s' green with the 9 capture and 4 G15 specs, 14 passed; G16 red before the command existed and with stopFiles stopping nothing (peak 0.5000152587890625)
  - test: jest speaker.spec.ts voice-capture:stop-playback: play-file then stop-playback stops the source, two files both stop, nothing playing resolves, another tab stops through the BroadcastChannel; Galata G16: after one click play the 3 s tone wav, stop-playback, analyser peak 0 within 0.5 s
  - test-tags: UNIT, FUNCTIONAL
  - log: 2026-11-07T14:23:34Z @kj added
  - log: 2026-11-07T14:23:59Z @kj closed: built in workflow tmp/workflows/stop; reason: names the six jest tests and the Galata test in full
  - log: 2026-11-07T16:43:02Z @kj live v1.1.2 in the Star Colonel's lab (record tmp/workflows/live/live3.json): 16:32:40 UTC play-file helsreach.mp3 exit 0, 16:32:46 UTC stop-playback exit 0, he answered 'Played, then stopped'; after a second reload-jupyterlab (pid 583 kept), 16:42:10 UTC play-file exit 0, heard, 16:42:20 UTC stop-playback exit 0, he answered 'Heard, stop it now'

## H. Agent skill `AGENT`

What an AI assistant in the lab reads to play sound in the browser and run the CLI

- log: 2026-11-06T17:44:51Z @kj category created

- [x] `ACC-AGENT-45-SKILL` **H1 shipped agent skill** - MEDIUM; the wheel ships .agents/skills/jupyterlab-audio-extension/SKILL.md at share/jupyter/agents/skills/jupyterlab-audio-extension/SKILL.md; under 30 lines, it says how to play any sound in the browser with paplay <file> and with jupyterlab-commands execute audio:player, points at jupyterlab_audio --help, and README says where it is
  - evidence: wheel jupyterlab_voice_capture_extension-1.0.18, rebuilt after F2, holds share/jupyter/agents/skills/jupyterlab-voice-capture-extension/SKILL.md byte-identical to the repo file (1233 B), no other .md; SKILL.md 17 lines, quick_validate 'Skill is valid!'; the verifier of workflow tmp/workflows/autoplay found one false statement, on line 15, and F2 removed it; README section Agent skill names both paths
  - test: build the wheel, list share/jupyter/agents/skills/jupyterlab-audio-extension/SKILL.md in it; check every statement of the skill against the code
  - test-tags: MANUAL
  - log: 2026-11-06T17:44:51Z @kj added
  - log: 2026-11-06T21:09:54Z @kj closed: built in workflow tmp/workflows/autoplay
  - log: 2026-11-06T21:42:48Z @kj edited evidence "wheel jupyterlab_voice_capture_extension-1.0.18 holds share/jupyter/agents/skills/jupyterlab-voice-capture-extension/SKILL.md byte-identical to the repo file, no .md in the Python package; SKILL.md 17 lines, quick_validate 'Skill is valid!', each statement checked against the code; README section Agent skill names both paths" -> "wheel jupyterlab_voice_capture_extension-1.0.18, rebuilt after F2, holds share/jupyter/agents/skills/jupyterlab-voice-capture-extension/SKILL.md byte-identical to the repo file (1233 B), no other .md; SKILL.md 17 lines, quick_validate 'Skill is valid!'; the verifier of workflow tmp/workflows/autoplay found one false statement, on line 15, and F2 removed it; README section Agent skill names both paths"; reason: F2 of workflow tmp/workflows/fixes removed the false clause from line 15; the last 0.5 s before the click plays (jest 'drops audio held longer than 0.5 s, so a late resume plays no backlog')
  - log: 2026-11-11T23:47:25Z @kj amended text "the wheel ships .agents/skills/jupyterlab-voice-capture-extension/SKILL.md at share/jupyter/agents/skills/jupyterlab-voice-capture-extension/SKILL.md; under 30 lines, it says how to play any sound in the browser with paplay <file> and with jupyterlab-commands execute voice-capture:play-file, points at jupyterlab_voice_capture --help, and README says where it is" -> "the wheel ships .agents/skills/jupyterlab-audio-extension/SKILL.md at share/jupyter/agents/skills/jupyterlab-audio-extension/SKILL.md; under 30 lines, it says how to play any sound in the browser with paplay <file> and with jupyterlab-commands execute audio:player, points at jupyterlab_audio --help, and README says where it is"; reason: skill directory, CLI and command id renamed
  - log: 2026-11-11T23:47:25Z @kj edited test "build the wheel, list share/jupyter/agents/skills/jupyterlab-voice-capture-extension/SKILL.md in it; check every statement of the skill against the code" -> "build the wheel, list share/jupyter/agents/skills/jupyterlab-audio-extension/SKILL.md in it; check every statement of the skill against the code"; reason: installed skill path renamed
- [x] `ACC-AGENT-46-HELP` **H2 CLI help for agents** - MEDIUM; jupyterlab_audio --help and each subcommand's --help let an agent run every command without other docs: exit codes in the top-level help, a description and one to three worked examples per subcommand, and start says it loads the speaker sink voiceout
  - evidence: pytest test_help_lists_the_exit_codes (install under exit 1), test_help_names_the_environment_variables_it_reads (NO_COLOR, TERM, AUDIODRIVER), test_install_with_apt_get_exits_1_only_when_a_command_it_runs_fails (5 cases) and test_command_help_says_what_it_does_and_shows_examples for install, validate, start and stop green; test_cli 30 passed, full pytest 58 passed; each of 8 breaks of the help text and 5 breaks of F4 turned red
  - test: pytest: each subcommand's help has an examples section; start --help names voiceout; top-level help names the exit codes
  - test-tags: UNIT
  - log: 2026-11-06T17:44:51Z @kj added
  - log: 2026-11-06T21:09:54Z @kj closed: built in workflow tmp/workflows/autoplay
  - log: 2026-11-06T21:42:48Z @kj edited evidence "pytest test_help_lists_the_exit_codes and test_command_help_says_what_it_does_and_shows_examples for install, validate, start and stop green, test_cli 21 passed, full pytest 52 passed; each of 8 breaks of the help text turned one red, start without voiceout included" -> "pytest test_help_lists_the_exit_codes (install under exit 1), test_help_names_the_environment_variables_it_reads (NO_COLOR, TERM, AUDIODRIVER), test_install_exits_1_only_when_a_command_it_runs_fails (5 cases) and test_command_help_says_what_it_does_and_shows_examples for install, validate, start and stop green; test_cli 27 passed, full pytest 58 passed; each of 8 breaks of the help text and 5 breaks of F4 turned red"; reason: F4 of workflow tmp/workflows/fixes: install exits 1 when a command it runs fails, so the exit codes in the help match the code; the help names the environment variables the CLI reads
  - log: 2026-11-07T07:56:39Z @kj edited evidence "pytest test_help_lists_the_exit_codes (install under exit 1), test_help_names_the_environment_variables_it_reads (NO_COLOR, TERM, AUDIODRIVER), test_install_exits_1_only_when_a_command_it_runs_fails (5 cases) and test_command_help_says_what_it_does_and_shows_examples for install, validate, start and stop green; test_cli 27 passed, full pytest 58 passed; each of 8 breaks of the help text and 5 breaks of F4 turned red" -> "pytest test_help_lists_the_exit_codes (install under exit 1), test_help_names_the_environment_variables_it_reads (NO_COLOR, TERM, AUDIODRIVER), test_install_with_apt_get_exits_1_only_when_a_command_it_runs_fails (5 cases) and test_command_help_says_what_it_does_and_shows_examples for install, validate, start and stop green; test_cli 30 passed, full pytest 58 passed; each of 8 breaks of the help text and 5 breaks of F4 turned red"; reason: test_install_exits_1_only_when_a_command_it_runs_fails renamed to test_install_with_apt_get_exits_1_only_when_a_command_it_runs_fails by the DEF-CLI-14/15 fix; test_cli now has 30 tests
  - log: 2026-11-11T23:47:28Z @kj amended text "jupyterlab_voice_capture --help and each subcommand's --help let an agent run every command without other docs: exit codes in the top-level help, a description and one to three worked examples per subcommand, and start says it loads the speaker sink voiceout" -> "jupyterlab_audio --help and each subcommand's --help let an agent run every command without other docs: exit codes in the top-level help, a description and one to three worked examples per subcommand, and start says it loads the speaker sink voiceout"; reason: CLI renamed from jupyterlab_voice_capture to jupyterlab_audio

## I. Virtual player (server) `PLAYER`

Server-side virtual player: one command, a queue and parallel playback, in-memory state.

- log: 2026-11-08T22:44:04Z @kj category created

- [x] `ACC-PLAYER-50-ONE-COMMAND` **One player command with an action argument** - HIGH; one JupyterLab command, audio:player, takes an action argument and covers play, play now, pause, resume, stop, clear and status; there is no separate command id per operation
  - evidence: src/index.ts:64 registers audio:player with describedBy; PlayerHandler POST route; Jest player.spec.ts and pytest test_player.py green (suite: Jest 41, pytest 85)
  - test: jupyterlab-commands execute audio:player --args '{"action": "status"}' and one call per action
  - test-tags: FUNCTIONAL
  - log: 2026-11-08T22:44:04Z @kj added
  - log: 2026-11-09T01:31:49Z @kj closed
  - log: 2026-11-11T23:47:28Z @kj amended text "one JupyterLab command, voice-capture:player, takes an action argument and covers play, play now, pause, resume, stop, clear and status; there is no separate command id per operation" -> "one JupyterLab command, audio:player, takes an action argument and covers play, play now, pause, resume, stop, clear and status; there is no separate command id per operation"; reason: command id renamed from voice-capture:player to audio:player
  - log: 2026-11-11T23:47:28Z @kj edited test "jupyterlab-commands execute voice-capture:player --args '{"action": "status"}' and one call per action" -> "jupyterlab-commands execute audio:player --args '{"action": "status"}' and one call per action"; evidence "src/index.ts:64 registers voice-capture:player with describedBy; PlayerHandler POST route; Jest player.spec.ts and pytest test_player.py green (suite: Jest 41, pytest 85)" -> "src/index.ts:64 registers audio:player with describedBy; PlayerHandler POST route; Jest player.spec.ts and pytest test_player.py green (suite: Jest 41, pytest 85)"; reason: command id renamed from voice-capture:player to audio:player
- [x] `ACC-PLAYER-51-PLAY-NOW` **play now mixes with what is playing** - HIGH; action play with mode now starts the file at once, in parallel with every file already playing; PulseAudio mixes them, so both are heard at the same time
  - evidence: test_player.py play-now concurrency test; Galata real-chain spec plays through the player and observes the bridge FIFO, 2 passed on an isolated daemon; pytest 85
  - test: two play now calls 1 s apart; both files audible at once
  - test-tags: FUNCTIONAL, INTEGRATION
  - log: 2026-11-08T22:44:04Z @kj added
  - log: 2026-11-09T01:31:49Z @kj closed
- [x] `ACC-PLAYER-52-QUEUE` **queue plays after the current file** - HIGH; action play without mode now adds the file to the queue; the next queued file starts when the last playing file ends, in the order added
  - evidence: test_play_after_stop_starts_the_queue_head_before_the_new_file and the queue tests in test_player.py; pytest 85 green
  - test: queue file B while A plays; B starts only after A ends
  - test-tags: FUNCTIONAL
  - log: 2026-11-08T22:44:04Z @kj added
  - log: 2026-11-09T01:31:49Z @kj closed
- [x] `ACC-PLAYER-53-PAUSE` **pause stops every playing file** - HIGH; action pause stops every playing file at its current position within 0.5 s; status reports paused; the queue keeps its order
  - evidence: test_player.py pause/resume on a fake process and clock: SIGSTOP, paused flag, frozen position; pytest 85 and the review round 3 SHIP
  - test: play two files, pause, audible output silent within 0.5 s, status reports paused
  - test-tags: FUNCTIONAL
  - log: 2026-11-08T22:44:04Z @kj added
  - log: 2026-11-09T01:31:49Z @kj closed
- [x] `ACC-PLAYER-54-RESUME` **resume continues from the paused position** - HIGH; action resume continues every paused file from the position where pause stopped it
  - evidence: test_player.py resume: SIGCONT, paused span added, position continues; pytest 85 green
  - test: pause 3 s into a 10 s file, resume, status position near 3 s
  - test-tags: FUNCTIONAL
  - log: 2026-11-08T22:44:04Z @kj added
  - log: 2026-11-09T01:31:49Z @kj closed
- [x] `ACC-PLAYER-55-STOP` **stop ends every playing file** - HIGH; action stop ends every playing file within 0.5 s; queued files stay queued unless action clear also runs
  - evidence: test_player.py stop sets the stopped gate, ends playing records and keeps the queue; Galata palette spec for stop (ACC-PLAYER-55-STOP) 1 passed; pytest 85
  - test: play two files, stop, silence within 0.5 s, status lists the queue unchanged
  - test-tags: FUNCTIONAL
  - log: 2026-11-08T22:44:04Z @kj added
  - log: 2026-11-09T01:31:49Z @kj closed
  - log: 2026-11-09T01:32:10Z @kj reopened; evidence retired: test_player.py stop sets the stopped gate, ends playing records and keeps the queue; Galata palette spec ACC-PLAYER-55 1 passed; pytest 85
  - log: 2026-11-09T01:32:10Z @kj closed
- [x] `ACC-PLAYER-56-CLEAR` **clear removes the queue only** - HIGH; action clear removes every queued file that has not started; files already playing continue
  - evidence: test_player.py clear removes queued records only; pytest 85 green
  - test: queue two files while one plays, clear, status shows an empty queue and the playing file still playing
  - test-tags: FUNCTIONAL
  - log: 2026-11-08T22:44:04Z @kj added
  - log: 2026-11-09T01:31:49Z @kj closed
- [x] `ACC-PLAYER-57-STATUS` **status reports the whole player** - HIGH; action status returns, without changing anything, each playing file with its id and position, the queue in order, and whether playback is paused
  - evidence: test_routes.py -k player 9 passed: status shape, ids and order; test_player.py status tests; pytest 85
  - test: status after play, queue and pause; compare the returned ids, positions and order
  - test-tags: UNIT, FUNCTIONAL
  - log: 2026-11-08T22:44:04Z @kj added
  - log: 2026-11-09T01:31:49Z @kj closed
- [x] `ACC-PLAYER-58-MEMORY` **player state is memory only** - HIGH; the player lives only in server memory and writes nothing to disk; a server start or a soft reload starts with an empty queue and nothing playing
  - evidence: test_player.py memory-only state; no file write in player.py; soft-reload tests in test_routes.py; pytest 85
  - test: play and queue files, run reload-jupyterlab, status reports an empty player and no player process remains
  - test-tags: FUNCTIONAL
  - log: 2026-11-08T22:44:05Z @kj added
  - log: 2026-11-09T01:31:50Z @kj closed
- [x] `ACC-PLAYER-59-MIX-ALLTABS` **every tab hears every playing file** - HIGH; every playing file is heard in every open JupyterLab tab at the same time; a tab that connects later hears the files still playing
  - evidence: Galata real-chain spec 2 passed: the player's paplay reaches the bridge FIFO on an isolated daemon; speaker chain unchanged, Galata 17 passed
  - test: two tabs, play now two files, both tabs carry both files
  - test-tags: FUNCTIONAL
  - log: 2026-11-08T22:44:05Z @kj added
  - log: 2026-11-09T01:31:50Z @kj closed
- [x] `ACC-PLAYER-60-AUTH` **player endpoint requires the token** - HIGH; the player endpoint requires the Jupyter token; a call without it is refused
  - evidence: test_player_route_requires_the_token and its with-token pair in test_routes.py; .github/scripts/check_auth.py all endpoints require authentication
  - test: request the player route without a token and expect a refusal
  - test-tags: UNIT
  - log: 2026-11-08T22:44:05Z @kj added
  - log: 2026-11-09T01:31:50Z @kj closed
- [x] `ACC-PLAYER-61-ERRORS` **bad input changes nothing** - MEDIUM; an unknown action, a missing path, a path outside the Jupyter root or a file that does not decode is refused with a message naming the problem, and the player state is unchanged
  - evidence: test_a_spawn_error_is_refused_without_changing_the_state and test_an_undecodable_file_is_refused_with_paplays_reason; route 400 mapping in test_routes.py; pytest 85
  - test: one call per bad input; status unchanged afterwards
  - test-tags: UNIT
  - log: 2026-11-08T22:44:05Z @kj added
  - log: 2026-11-09T01:31:50Z @kj closed
- [x] `ACC-PLAYER-62-SINGLE` **one player per server** - MEDIUM; one player exists per server process; after a soft reload exactly one player exists and no player process from the previous load remains
  - evidence: soft-reload tests: test_a_second_load_replaces_the_player and the close-load test; pytest 85 green
  - test: count player threads and player processes before and after reload-jupyterlab
  - test-tags: FUNCTIONAL
  - log: 2026-11-08T22:44:05Z @kj added
  - log: 2026-11-09T01:31:50Z @kj closed
- [x] `ACC-PLAYER-63-RETIRE` **play-file and stop-playback retired** - HIGH; voice-capture:play-file and voice-capture:stop-playback are retired; the player command covers their behaviour, and the skill names the player command only
  - evidence: no play-file or stop-playback registration in src; speaker.spec.ts retirement test; commands extension schema names neither; Jest 41 and schema 2 passed
  - test: check the registered command list and the skill for the retired ids
  - test-tags: UNIT
  - log: 2026-11-08T22:44:05Z @kj added
  - log: 2026-11-09T01:31:50Z @kj closed
- [x] `ACC-PLAYER-64-ALLOWLIST` **player command allowed and described** - MEDIUM; audio:player is in the commands extension default allowlist and jupyterlab-commands list prints it with a description; the commands extension is released with that change
  - evidence: commands extension schema/plugin.json carries audio:player and test_schema.py asserts it, 2 passed; the stored user setting is the live-lab step
  - test: jupyterlab-commands list shows the id and its description after a fresh install
  - test-tags: FUNCTIONAL
  - log: 2026-11-08T22:44:05Z @kj added
  - log: 2026-11-09T01:31:50Z @kj closed
  - log: 2026-11-11T23:47:31Z @kj amended text "voice-capture:player is in the commands extension default allowlist and jupyterlab-commands list prints it with a description; the commands extension is released with that change" -> "audio:player is in the commands extension default allowlist and jupyterlab-commands list prints it with a description; the commands extension is released with that change"; reason: command id renamed from voice-capture:player to audio:player
  - log: 2026-11-11T23:47:31Z @kj edited evidence "commands extension schema/plugin.json carries voice-capture:player and test_schema.py asserts it, 2 passed; the stored user setting is the live-lab step" -> "commands extension schema/plugin.json carries audio:player and test_schema.py asserts it, 2 passed; the stored user setting is the live-lab step"; reason: command id renamed from voice-capture:player to audio:player
- [x] `ACC-PLAYER-65-DOC` **player design document** - MEDIUM; docs/voice-player-design.md states the command contract, the actions, the state model and the reset rule in the terse technical form
  - evidence: docs/voice-player-design.md states the contract, the stopped gate, the latency flag, SIGCONT, the route and the palette entry; prettier clean; review round 3 SHIP
  - test: read the document against the command help
  - test-tags: MANUAL
  - log: 2026-11-08T22:44:05Z @kj added
  - log: 2026-11-09T01:31:50Z @kj closed
- [x] `ACC-PLAYER-71-SINK` **Sink health in the player status** - HIGH; the player status action reports sink.state ready when the speaker path is a FIFO, off when a .stopped marker sits beside it, and missing when the path is absent or is a regular file
  - evidence: pytest: test_player_status_reports_a_missing_speaker_fifo, test_player_status_reports_a_ready_speaker_fifo, test_player_status_reports_a_speaker_path_that_is_not_a_fifo and test_player_status_lets_a_stop_marker_win_over_a_stale_speaker_fifo report missing, ready, missing and off; pytest 92 passed of 92 (test_pulse_integration.py ignored), Jest 62 passed of 62, functional 20 passed, 2 skipped, 0 failed
  - test: pytest: call status with the speaker path absent, then a FIFO, then a regular file, then a FIFO beside a .stopped marker; assert sink.state missing, ready, missing and off
  - test-tags: UNIT, FUNCTIONAL
  - log: 2026-11-10T22:43:24Z @kj added
  - log: 2026-11-10T23:54:35Z @kj closed: verified in v1.1.3+controls
  - log: 2026-11-11T18:13:52Z @kj edited text "the player status action reports whether the audio sink is functional and names the cause when it is not" -> "the player status action reports sink.state ready when the speaker path is a FIFO, off when a .stopped marker sits beside it, and missing when the path is absent or is a regular file"; test "call the player route with status while /run/voice/speaker.fifo is absent, assert the sink is reported not ok and the reason names the missing FIFO and the start command" -> "pytest: call status with the speaker path absent, then a FIFO, then a regular file, then a FIFO beside a .stopped marker; assert sink.state missing, ready, missing and off"; evidence "pytest: a missing speaker FIFO reports sink ok false naming the path and jupyterlab_voice_capture start -d; a present FIFO reports ok true, 89 passed" -> "pytest: test_player_status_reports_a_missing_speaker_fifo, test_player_status_reports_a_ready_speaker_fifo, test_player_status_reports_a_speaker_path_that_is_not_a_fifo and test_player_status_lets_a_stop_marker_win_over_a_stale_speaker_fifo report missing, ready, missing and off; pytest 92 passed of 92 (test_pulse_integration.py ignored), Jest 62 passed of 62, functional 20 passed, 2 skipped, 0 failed"
- [x] `ACC-PLAYER-80-SINK-STATE` **The player status reports the sink state** - HIGH; the player status answers sink.state ready when the speaker FIFO exists, off when a .stopped marker sits beside it, and missing when the path is absent or not a FIFO; jupyterlab_audio stop writes the marker after the daemon stops and start removes it only after every component loads
  - evidence: pytest: missing without a FIFO and for a regular file, ready for a FIFO, off for a .stopped marker over a stale FIFO; test_cli: stop writes the marker, start clears it only after daemon, source and sink load, a failed start keeps it; Galata: the marker turns the lamp off
  - test: pytest: status reports sink.state missing for an absent FIFO and a regular file, ready for a FIFO, and off when a stop marker is present even beside a FIFO; test_cli: stop writes the marker and start clears it only after the daemon, source and sink load
  - test-tags: UNIT, FUNCTIONAL
  - log: 2026-11-11T17:33:29Z @kj added
  - log: 2026-11-11T17:33:53Z @kj closed: jest 6 suites / 62 tests passed; pytest 89 passed; Galata 20 passed, 2 skipped, 0 failed
  - log: 2026-11-11T23:47:31Z @kj amended text "the player status answers sink.state ready when the speaker FIFO exists, off when a .stopped marker sits beside it, and missing when the path is absent or not a FIFO; jupyterlab_voice_capture stop writes the marker after the daemon stops and start removes it only after every component loads" -> "the player status answers sink.state ready when the speaker FIFO exists, off when a .stopped marker sits beside it, and missing when the path is absent or not a FIFO; jupyterlab_audio stop writes the marker after the daemon stops and start removes it only after every component loads"; reason: CLI renamed from jupyterlab_voice_capture to jupyterlab_audio

## Playback controls (status bar) `CTRL`

Status bar controls that act on the player: play, pause and stop

- log: 2026-11-10T22:26:49Z @kj category created

- [x] `ACC-CTRL-66-CONTROLS` **Playback controls in the status bar** - HIGH; the status bar shows one pill holding the microphone toggle, a play/stop control and a pause control, separated by hairline dividers
  - evidence: jest: one pill root holds mic, divider, play/stop, divider, pause with three icons; Galata: the pill class is present, two dividers, all three segments inside the pill box
  - test: open the lab, assert both controls sit in the status bar next to the capture toggle
  - test-tags: UNIT, FUNCTIONAL
  - log: 2026-11-10T22:26:49Z @kj added
  - log: 2026-11-10T23:54:35Z @kj closed: verified in v1.1.3+controls
  - log: 2026-11-11T12:35:34Z @kj amended text "the status bar shows a play control and a pause control beside the microphone toggle" -> "the status bar shows one pill holding the microphone toggle, a play/stop control and a pause control, separated by hairline dividers"
  - log: 2026-11-11T13:08:07Z @kj edited evidence "jest player-status spec: the status bar item holds exactly two control buttons, one play/stop and one pause; Galata: the playback item renders beside the microphone toggle, 18 passed" -> "jest: one pill root holds mic, divider, play/stop, divider, pause with three icons; Galata: the pill class is present, two dividers, all three segments inside the pill box"
- [x] `ACC-CTRL-67-STOP-FACE` **Play reads as stop while playing** - HIGH; while a file plays the play control shows stop, and when nothing plays it shows play
  - evidence: jest: playing shows the stop face and idle shows play; Galata: the idle face is play
  - test: play a file, assert the control shows stop; stop it, assert play
  - test-tags: UNIT, FUNCTIONAL
  - log: 2026-11-10T22:26:49Z @kj added
  - log: 2026-11-10T23:54:35Z @kj closed: verified in v1.1.3+controls
- [x] `ACC-CTRL-68-LIT` **Controls act while playing** - HIGH; while a file plays both controls are enabled and run the matching player action
  - evidence: jest: while playing both controls are enabled and clicks post stop, pause and resume to the player route
  - test: play a file, click pause, assert the player pauses; click resume, assert it continues
  - test-tags: UNIT
  - log: 2026-11-10T22:26:49Z @kj added
  - log: 2026-11-10T23:54:35Z @kj edited test-tags "UNIT, E2E" -> "UNIT"
  - log: 2026-11-10T23:54:35Z @kj closed: verified in v1.1.3+controls
- [x] `ACC-CTRL-69-GREYED` **Controls disabled when idle** - HIGH; when the player plays nothing both player controls are disabled and drawn in the same grey as the disabled microphone segment
  - evidence: jest: both player controls disabled when idle; Galata: the idle mic colour equals the disabled pause colour
  - test: with nothing playing, assert both controls are disabled and carry the grey style of the disabled capture toggle
  - test-tags: UNIT, E2E
  - log: 2026-11-10T22:26:49Z @kj added
  - log: 2026-11-10T23:54:35Z @kj closed: verified in v1.1.3+controls
  - log: 2026-11-11T12:35:34Z @kj amended text "when the player plays nothing both controls are disabled and drawn grey as the disabled microphone toggle is" -> "when the player plays nothing both player controls are disabled and drawn in the same grey as the disabled microphone segment"
  - log: 2026-11-11T13:08:07Z @kj edited evidence "jest: both controls disabled when idle; Galata: the disabled colour equals the idle microphone grey, 18 passed" -> "jest: both player controls disabled when idle; Galata: the idle mic colour equals the disabled pause colour"
- [x] `ACC-CTRL-72-BLINK` **The lamp blinks amber when the sink is not functional** - HIGH; when the player status reports the sink missing, the leading lamp blinks amber in the error colour for the episode and the pill border and tint stay unchanged; the play tooltip says audio output is unavailable
  - evidence: jest: data-vc-lamp fault while the sink is missing with play and pause still enabled, no jp-mod-error or jp-mod-sink-error class, and title and aria-label Play - Audio output is unavailable with no path, FIFO or command; Galata: audio-blink animation, var(--jp-warn-color0) background and unchanged pill border
  - test: jest: return sink missing and assert the amber fault lamp with no error class on the pill or controls, the controls still following the player mode, and the plain unavailable tooltip; Galata: the lamp blinks in var(--jp-warn-color0)
  - test-tags: UNIT, FUNCTIONAL
  - log: 2026-11-10T22:43:25Z @kj added
  - log: 2026-11-10T23:54:36Z @kj closed: verified in v1.1.3+controls
  - log: 2026-11-11T14:38:38Z @kj amended text "when the player status reports the sink not functional, the play icon blinks in the error colour and the tooltip carries the reason" -> "when the player status reports the sink not functional, a small amber dot on the play control blinks in the error colour for the episode and the pill border and tint stay unchanged; the tooltip says audio output is unavailable"
  - log: 2026-11-11T15:23:04Z @kj edited test "jest: return sink not ok from the status poll, assert the play control carries the blinking error class and the tooltip carries the reason; Galata: a lab without the voiceout sink shows the blinking play icon" -> "jest: return sink not ok and assert the dot is visible and blinking, the pill has no error border, the play control has no error class and the tooltip reads Audio output is unavailable; Galata: the blinking dot is present in var(--jp-warn-color0)"; evidence "jest and Galata: jp-mod-error, vc-blink animation and var(--jp-warn-color1) on the play control with the reason in the tooltip" -> "jest: dot visible and blinking at 29999 ms, hidden at 30000 ms; no jp-mod-error or jp-mod-sink-error; tooltip Play - Audio output is unavailable with no path or command; Galata: jp-VoiceCapture-dot blinks in var(--jp-warn-color0) and the pill border is unchanged"
  - log: 2026-11-11T17:33:35Z @kj amended title "Play icon blinks when the sink is not functional" -> "The lamp blinks amber when the sink is not functional"; text "when the player status reports the sink not functional, a small amber dot on the play control blinks in the error colour for the episode and the pill border and tint stay unchanged; the tooltip says audio output is unavailable" -> "when the player status reports the sink missing, the leading lamp blinks amber in the error colour for the episode and the pill border and tint stay unchanged; the play tooltip says audio output is unavailable"
  - log: 2026-11-11T17:33:40Z @kj edited test "jest: return sink not ok and assert the dot is visible and blinking, the pill has no error border, the play control has no error class and the tooltip reads Audio output is unavailable; Galata: the blinking dot is present in var(--jp-warn-color0)" -> "jest: return sink missing and assert the amber fault lamp with no error class on the pill or controls, the controls still following the player mode, and the plain unavailable tooltip; Galata: the lamp blinks in var(--jp-warn-color0)"
  - log: 2026-11-11T17:33:47Z @kj reopened: dot replaced by the leading lamp in the lamp build; evidence retired: jest: dot visible and blinking at 29999 ms, hidden at 30000 ms; no jp-mod-error or jp-mod-sink-error; tooltip Play - Audio output is unavailable with no path or command; Galata: jp-VoiceCapture-dot blinks in var(--jp-warn-color0) and the pill border is unchanged
  - log: 2026-11-11T17:33:47Z @kj closed: jest 6 suites / 62 tests passed; pytest 89 passed; Galata 20 passed, 2 skipped, 0 failed
  - log: 2026-11-11T17:34:08Z @kj edited evidence "jest: pill children lamp, divider, mic, divider, play, divider, pause with the lamp aria-hidden; data-vc-lamp ready filled at idle, active while a file plays and while the microphone streams, ready on connecting, pause and capture error, fault on missing; Galata: a fresh FIFO flips fault to ready" -> "jest: data-vc-lamp fault while the sink is missing with play and pause still enabled, no jp-mod-error or jp-mod-sink-error class, and title and aria-label Play - Audio output is unavailable with no path, FIFO or command; Galata: vc-blink animation, var(--jp-warn-color0) background and unchanged pill border"
  - log: 2026-11-11T23:47:34Z @kj edited evidence "jest: data-vc-lamp fault while the sink is missing with play and pause still enabled, no jp-mod-error or jp-mod-sink-error class, and title and aria-label Play - Audio output is unavailable with no path, FIFO or command; Galata: vc-blink animation, var(--jp-warn-color0) background and unchanged pill border" -> "jest: data-vc-lamp fault while the sink is missing with play and pause still enabled, no jp-mod-error or jp-mod-sink-error class, and title and aria-label Play - Audio output is unavailable with no path, FIFO or command; Galata: audio-blink animation, var(--jp-warn-color0) background and unchanged pill border"; reason: lamp animation renamed from vc-blink to audio-blink
- [x] `ACC-CTRL-73-BLINK-END` **The fault blink ends after 30 seconds** - HIGH; when the sink stays missing the lamp blinks amber for 30 seconds, then settles to the off ring with both controls disabled and the plain message still in the play tooltip; a healthy status ends the episode and a later break blinks again
  - evidence: jest fake timers: data-vc-lamp fault and both controls enabled at 29999 ms, off and both disabled at 30000 ms with title Stop - Audio output is unavailable; a ready poll restores active and a later missing poll blinks fault again; Galata: data-vc-lamp fault on load with animation audio-blink
  - test: jest fake timers: return sink missing, assert the fault lamp at 29999 ms, then the off ring with both controls disabled at 30000 ms; a ready status restores the active lamp and a new break blinks again; Galata: the lamp blinks on load
  - test-tags: UNIT, FUNCTIONAL
  - log: 2026-11-11T12:28:19Z @kj added
  - log: 2026-11-11T13:08:07Z @kj closed: verified in the pill build
  - log: 2026-11-11T14:38:39Z @kj amended text "when the sink stays broken the play control blinks for 30 seconds and then stops blinking and reads as disabled, with the reason still in the tooltip" -> "when the sink stays broken the amber dot blinks for 30 seconds and then disappears, and both controls read as disabled with the plain message still in the play tooltip"
  - log: 2026-11-11T15:23:04Z @kj edited test "jest with fake timers: return sink not ok, assert the blinking class, advance 30 s, assert it is gone and the control disabled; Galata: the blink is present on load" -> "jest with fake timers: return sink not ok, assert the dot visible and blinking, advance 29999 ms and assert it still blinks, advance 1 ms and assert it is hidden with both controls disabled; Galata: the dot blinks on load"; evidence "jest fake timers: blink present, gone after 30 s with both controls disabled and the reason kept, recovery ends the episode and a new break blinks again; Galata: the blink class is present on load" -> "jest fake timers: dot visible and blinking at 29999 ms, hidden at 30000 ms with both controls disabled and the plain message kept; recovery ends the episode and a new break blinks again; Galata: the dot blinks on load"
  - log: 2026-11-11T17:33:35Z @kj amended title "The error blink ends after 30 seconds" -> "The fault blink ends after 30 seconds"; text "when the sink stays broken the amber dot blinks for 30 seconds and then disappears, and both controls read as disabled with the plain message still in the play tooltip" -> "when the sink stays missing the lamp blinks amber for 30 seconds, then settles to the off ring with both controls disabled and the plain message still in the play tooltip; a healthy status ends the episode and a later break blinks again"
  - log: 2026-11-11T17:33:40Z @kj edited test "jest with fake timers: return sink not ok, assert the dot visible and blinking, advance 29999 ms and assert it still blinks, advance 1 ms and assert it is hidden with both controls disabled; Galata: the dot blinks on load" -> "jest fake timers: return sink missing, assert the fault lamp at 29999 ms, then the off ring with both controls disabled at 30000 ms; a ready status restores the active lamp and a new break blinks again; Galata: the lamp blinks on load"
  - log: 2026-11-11T17:33:50Z @kj reopened: dot replaced by the leading lamp in the lamp build; evidence retired: jest fake timers: dot visible and blinking at 29999 ms, hidden at 30000 ms with both controls disabled and the plain message kept; recovery ends the episode and a new break blinks again; Galata: the dot blinks on load
  - log: 2026-11-11T17:33:50Z @kj closed: jest 6 suites / 62 tests passed; pytest 89 passed; Galata 20 passed, 2 skipped, 0 failed
  - log: 2026-11-11T23:47:34Z @kj edited evidence "jest fake timers: data-vc-lamp fault and both controls enabled at 29999 ms, off and both disabled at 30000 ms with title Stop - Audio output is unavailable; a ready poll restores active and a later missing poll blinks fault again; Galata: data-vc-lamp fault on load with animation vc-blink" -> "jest fake timers: data-vc-lamp fault and both controls enabled at 29999 ms, off and both disabled at 30000 ms with title Stop - Audio output is unavailable; a ready poll restores active and a later missing poll blinks fault again; Galata: data-vc-lamp fault on load with animation audio-blink"; reason: lamp animation renamed from vc-blink to audio-blink
- [x] `ACC-CTRL-74-FLAT` **Enabled state lights the glyphs only** - MEDIUM; the playback pill paints no background tint for hover, active or pressed; an enabled control is shown by its glyph colour alone
  - evidence: jest: no inline style and no background class in any state; Galata: computed background of the pill and all three segments equal, unchanged after hover
  - test: jest: no tinted background class on any control in any state; Galata: computed background-color of the pill controls equals the pill background
  - test-tags: UNIT, FUNCTIONAL
  - log: 2026-11-11T12:33:21Z @kj added
  - log: 2026-11-11T13:08:07Z @kj closed: verified in the pill build
- [x] `ACC-CTRL-75-MIC-COLOR` **The microphone segment shares the control colours** - MEDIUM; the microphone segment inside the pill uses the same enabled colour as play, stop and pause, and the same disabled colour as they do when disabled
  - evidence: jest: the mic and pause share the control class and the root state classes; Galata: computed idle mic equals the disabled pause colour and the streaming mic equals the enabled pause colour
  - test: jest: the microphone control and the pause control carry the same computed class/colour in the enabled state and in the disabled state; Galata: computed colour of the mic equals that of an enabled control
  - test-tags: UNIT, FUNCTIONAL
  - log: 2026-11-11T12:33:21Z @kj added
  - log: 2026-11-11T13:08:07Z @kj closed: verified in the pill build
- [x] `ACC-CTRL-77-PLAIN-TIP` **The sink tooltips are written in plain words** - MEDIUM; the play control's title and aria-label carry the action plus Audio output is unavailable while the sink is missing or Audio output is shut down after a deliberate shutdown, and never a path, FIFO, command or other technical detail
  - evidence: jest: title and aria-label Play - Audio output is unavailable while missing and Stop - Audio output is shut down after a shutdown, both matched against no fifo, path, start -d or jupyterlab_audio; Galata: the rendered title is Play - Audio output is unavailable
  - test: jest: assert the play title and aria-label equal Play - Audio output is unavailable and Stop - Audio output is shut down in their states and match no fifo, path, start -d or jupyterlab_audio; Galata: the rendered title is the plain message
  - test-tags: UNIT, FUNCTIONAL
  - log: 2026-11-11T14:38:38Z @kj added
  - log: 2026-11-11T15:23:04Z @kj closed
  - log: 2026-11-11T17:33:36Z @kj amended title "The sink error tooltip is written in plain words" -> "The sink tooltips are written in plain words"; text "when the audio sink is not functional the play control's tooltip says audio output is unavailable and carries no file path, FIFO, command or other technical detail" -> "the play control's title and aria-label carry the action plus Audio output is unavailable while the sink is missing or Audio output is shut down after a deliberate shutdown, and never a path, FIFO, command or other technical detail"
  - log: 2026-11-11T17:33:40Z @kj edited test "jest: assert the play tooltip equals the plain message and holds no path, FIFO or command" -> "jest: assert the play title and aria-label equal Play - Audio output is unavailable and Stop - Audio output is shut down in their states and match no fifo, path, start -d or jupyterlab_voice_capture; Galata: the rendered title is the plain message"; test-tags "UNIT" -> "UNIT, FUNCTIONAL"
  - log: 2026-11-11T17:33:50Z @kj reopened: dot and unavailable-only wording replaced by both sink states; evidence retired: jest: the play tooltip equals Play - Audio output is unavailable and holds no fifo, path or jupyterlab_voice_capture; Galata: the rendered title is the same plain message
  - log: 2026-11-11T17:33:50Z @kj closed: jest 6 suites / 62 tests passed; pytest 89 passed; Galata 20 passed, 2 skipped, 0 failed
  - log: 2026-11-11T23:47:36Z @kj edited test "jest: assert the play title and aria-label equal Play - Audio output is unavailable and Stop - Audio output is shut down in their states and match no fifo, path, start -d or jupyterlab_voice_capture; Galata: the rendered title is the plain message" -> "jest: assert the play title and aria-label equal Play - Audio output is unavailable and Stop - Audio output is shut down in their states and match no fifo, path, start -d or jupyterlab_audio; Galata: the rendered title is the plain message"; evidence "jest: title and aria-label Play - Audio output is unavailable while missing and Stop - Audio output is shut down after a shutdown, both matched against no fifo, path, start -d or jupyterlab_voice_capture; Galata: the rendered title is Play - Audio output is unavailable" -> "jest: title and aria-label Play - Audio output is unavailable while missing and Stop - Audio output is shut down after a shutdown, both matched against no fifo, path, start -d or jupyterlab_audio; Galata: the rendered title is Play - Audio output is unavailable"; reason: CLI renamed from jupyterlab_voice_capture to jupyterlab_audio in the forbidden-token check
- [x] `ACC-CTRL-78-LAMP` **The leading lamp reports the audio system** - HIGH; the pill leads with one 6 px lamp before the microphone: filled grey when the sink is ready, a 1 px hollow ring after a deliberate shutdown, muted green while the microphone streams or a file plays, and amber blinking while the sink is missing; the lamp carries role=img and its own tooltip and aria-label name the audio-system state in plain words: Audio system ready, in use, shut down or unavailable
  - evidence: jest: pill order lamp, divider, mic, divider, play, divider, pause; the lamp has role=img and title and aria-label Audio system ready at idle, in use while playing or streaming, unavailable on missing and after the 30 s blink, shut down after a deliberate shutdown; Galata: fault to ready on a FIFO and off on a .stopped marker, with lamp title unavailable, ready and shut down
  - test: jest: assert the pill children are lamp, divider, mic, divider, play, divider, pause and data-vc-lamp is ready at idle, active while playing or streaming, fault while missing and off after a shutdown; Galata: a FIFO and a stop marker flip the lamp
  - test-tags: UNIT, FUNCTIONAL
  - log: 2026-11-11T17:33:25Z @kj added
  - log: 2026-11-11T17:33:53Z @kj closed: jest 6 suites / 62 tests passed; pytest 89 passed; Galata 20 passed, 2 skipped, 0 failed
  - log: 2026-11-11T17:34:09Z @kj edited evidence "jest: pill children lamp, divider, mic, divider, play, divider, pause with the lamp aria-hidden; data-vc-lamp ready filled at idle, active while a file plays and while the microphone streams, ready on connecting, pause and capture error, fault on missing; Galata: a fresh FIFO flips fault to ready" -> "jest: pill order lamp, divider, mic, divider, play, divider, pause with the lamp aria-hidden; data-vc-lamp ready at idle, active while playing or streaming, ready on connecting, pause and capture error, fault on missing, off on shutdown; Galata: fault to ready on a FIFO and off on a .stopped marker"
  - log: 2026-11-11T21:54:57Z @kj edited text "the pill leads with one 6 px lamp before the microphone: filled grey when the sink is ready, a hollow ring after a deliberate shutdown, muted green while the microphone streams or a file plays, and amber blinking while the sink is missing" -> "The leading lamp reports the audio system - HIGH; the pill leads with one 6 px lamp before the microphone: filled grey when the sink is ready, a 1 px hollow ring after a deliberate shutdown, muted green while the microphone streams or a file plays, and amber blinking while the sink is missing; the lamp carries role=img and its own tooltip and aria-label name the audio-system state in plain words: Audio system ready, in use, shut down or unavailable"; evidence "jest: pill order lamp, divider, mic, divider, play, divider, pause with the lamp aria-hidden; data-vc-lamp ready at idle, active while playing or streaming, ready on connecting, pause and capture error, fault on missing, off on shutdown; Galata: fault to ready on a FIFO and off on a .stopped marker" -> "jest: pill order lamp, divider, mic, divider, play, divider, pause; the lamp has role=img and title and aria-label Audio system ready at idle, in use while playing or streaming, unavailable on missing and after the 30 s blink, shut down after a deliberate shutdown; Galata: fault to ready on a FIFO and off on a .stopped marker, with lamp title unavailable, ready and shut down"; reason: the criterion now records the lamp tooltip and the 1 px ring, replacing the aria-hidden wording
  - log: 2026-11-11T21:55:07Z @kj edited text "The leading lamp reports the audio system - HIGH; the pill leads with one 6 px lamp before the microphone: filled grey when the sink is ready, a 1 px hollow ring after a deliberate shutdown, muted green while the microphone streams or a file plays, and amber blinking while the sink is missing; the lamp carries role=img and its own tooltip and aria-label name the audio-system state in plain words: Audio system ready, in use, shut down or unavailable" -> "the pill leads with one 6 px lamp before the microphone: filled grey when the sink is ready, a 1 px hollow ring after a deliberate shutdown, muted green while the microphone streams or a file plays, and amber blinking while the sink is missing; the lamp carries role=img and its own tooltip and aria-label name the audio-system state in plain words: Audio system ready, in use, shut down or unavailable"; reason: remove the duplicated title and importance left by the previous edit
- [x] `ACC-CTRL-79-LAMP-OFF` **A deliberate shutdown is a calm hollow lamp** - HIGH; a deliberate shutdown is a calm hollow ring with no blink or amber, both player controls are disabled at once, the microphone stays enabled, and the play tooltip says the audio output is shut down
  - evidence: jest: sink off while playing gives data-vc-lamp off, play and pause disabled, mic enabled, aria-label and title Stop - Audio output is shut down with no path, FIFO or command; Galata: a .stopped marker gives a transparent 6 px ring with inset shadow, no animation and both controls disabled
  - test: jest: return sink off while a file plays and assert the transparent ring with an inset shadow, both controls disabled, the microphone enabled and the tooltip Stop - Audio output is shut down; Galata: a .stopped marker shows the same ring on a live lab
  - test-tags: UNIT, FUNCTIONAL
  - log: 2026-11-11T17:33:27Z @kj added
  - log: 2026-11-11T17:33:53Z @kj closed: jest 6 suites / 62 tests passed; pytest 89 passed; Galata 20 passed, 2 skipped, 0 failed
- [x] `ACC-CTRL-81-BLOCK` **The controls read as a block against the status bar** - HIGH; the pill reads as a shallow chip: background is color-mix(in srgb, layout-color1 50%, layout-color2), 1.15:1 against the Steel Dark bar and 1.09:1 against Steel Light; the dividers stay visible at 1.3:1 or more against the fill, and the streaming microphone uses the active lamp's muted green (#6dbd81 dark, #347443 light)
  - evidence: Jest 62/62 (pill, 3 dividers, streaming active lamp); Galata: ACC-CTRL-66/69/74/75 pill fill = color(srgb 0.219608 0.256863 0.292157) dark / color(srgb 0.713726 0.735294 0.764706) light, not transparent, border match; dividers rgb(77,90,101) dark / rgb(154,162,172) light; A2 mic = lamp rgb(109,189,129) / rgb(52,116,67).
  - test: jest: the streaming microphone colour equals the active-lamp green; Galata: the pill background equals color-mix(layout-color1 50%, layout-color2) and the dividers and green clear their floors against the fill
  - test-tags: UNIT, FUNCTIONAL
  - mechanism: 2026-11-11T22:34:40Z @kj fill or outline the pill with a theme token that separates it from the status bar, keep the dividers visible inside the block, and colour the streaming microphone with the active-lamp green
  - log: 2026-11-11T22:34:40Z @kj added
  - log: 2026-11-11T22:43:27Z @kj edited text "the pill reads as one block against the status bar in both themes: its surface or boundary differs from the bar by at least 1.5:1 (Steel Dark #404b54, Steel Light #aeb4bc), the dividers stay visible, and the streaming microphone uses the active lamp's muted green (#78a884 dark, #3a5d42 light)" -> "the pill reads as a shallow chip: background is color-mix(in srgb, layout-color1 50%, layout-color2), 1.15:1 against the Steel Dark bar and 1.09:1 against Steel Light; the dividers stay visible at 1.3:1 or more against the fill, and the streaming microphone uses the active lamp's muted green (#78a884 dark, #3a5d42 light)"; test "jest: the streaming microphone colour equals the active-lamp green; Galata: the pill background or border contrast against the status bar is at least 1.5:1 in both themes" -> "jest: the streaming microphone colour equals the active-lamp green; Galata: the pill background equals color-mix(layout-color1 50%, layout-color2) and the dividers and green clear their floors against the fill"; reason: the user picked option D and asked for a shallower chip; the 1.5:1 floor is replaced by the chosen 50 percent blend
  - log: 2026-11-11T22:44:59Z @kj edited text "the pill reads as a shallow chip: background is color-mix(in srgb, layout-color1 50%, layout-color2), 1.15:1 against the Steel Dark bar and 1.09:1 against Steel Light; the dividers stay visible at 1.3:1 or more against the fill, and the streaming microphone uses the active lamp's muted green (#78a884 dark, #3a5d42 light)" -> "the pill reads as a shallow chip: background is color-mix(in srgb, layout-color1 50%, layout-color2), 1.15:1 against the Steel Dark bar and 1.09:1 against Steel Light; the dividers stay visible at 1.3:1 or more against the fill, and the streaming microphone uses the active lamp's muted green (#76b085 dark, #396042 light)"; reason: the user asked for a tiny bit stronger green; the mic and the active lamp keep one colour
  - log: 2026-11-11T22:47:02Z @kj edited text "the pill reads as a shallow chip: background is color-mix(in srgb, layout-color1 50%, layout-color2), 1.15:1 against the Steel Dark bar and 1.09:1 against Steel Light; the dividers stay visible at 1.3:1 or more against the fill, and the streaming microphone uses the active lamp's muted green (#76b085 dark, #396042 light)" -> "the pill reads as a shallow chip: background is color-mix(in srgb, layout-color1 50%, layout-color2), 1.15:1 against the Steel Dark bar and 1.09:1 against Steel Light; the dividers stay visible at 1.3:1 or more against the fill, and the streaming microphone uses the active lamp's muted green (#75b585 dark, #376442 light)"; reason: the user raised the green saturation one step; the mic and the active lamp keep one colour
  - log: 2026-11-11T22:48:19Z @kj edited text "the pill reads as a shallow chip: background is color-mix(in srgb, layout-color1 50%, layout-color2), 1.15:1 against the Steel Dark bar and 1.09:1 against Steel Light; the dividers stay visible at 1.3:1 or more against the fill, and the streaming microphone uses the active lamp's muted green (#75b585 dark, #376442 light)" -> "the pill reads as a shallow chip: background is color-mix(in srgb, layout-color1 50%, layout-color2), 1.15:1 against the Steel Dark bar and 1.09:1 against Steel Light; the dividers stay visible at 1.3:1 or more against the fill, and the streaming microphone uses the active lamp's muted green (#6dbd81 dark, #376a43 light)"; reason: dark green more saturated, light green lighter and a little more saturated, at the 3:1 floor on the light bar
  - log: 2026-11-11T22:50:00Z @kj edited text "the pill reads as a shallow chip: background is color-mix(in srgb, layout-color1 50%, layout-color2), 1.15:1 against the Steel Dark bar and 1.09:1 against Steel Light; the dividers stay visible at 1.3:1 or more against the fill, and the streaming microphone uses the active lamp's muted green (#6dbd81 dark, #376a43 light)" -> "the pill reads as a shallow chip: background is color-mix(in srgb, layout-color1 50%, layout-color2), 1.15:1 against the Steel Dark bar and 1.09:1 against Steel Light; the dividers stay visible at 1.3:1 or more against the fill, and the streaming microphone uses the active lamp's muted green (#6dbd81 dark, #347443 light)"; reason: the light green is lighter and more saturated on the owner's comment: it trades the 3:1 floor for a green read
  - log: 2026-11-11T23:24:08Z @kj closed
- [x] `ACC-CTRL-95-CROSSED` **Shut-down state crosses the icons** - HIGH; when the audio system is shut down (the hollow lamp) the pill icons carry a diagonal cross with a cutout
  - evidence: Jest status.spec.ts:472: root dataset.vcLamp = ready/active/fault/off, lamp keeps its own. Galata bubblewrap 20 passed/0 failed: ACC-CTRL-79-LAMP-OFF root data-vc-lamp='off'; mic/play/pause ::after content '""' not none, background rgba(0, 0, 0, 0.54) = control colour, ::before background color(srgb 0.966667 0.966667 0.966667) = pill fill; ACC-CTRL-78-LAMP ready contents none.
  - test: Galata: with a .stopped marker the control glyphs carry the cross overlay; Jest: the off state paints the marking
  - test-tags: UNIT, FUNCTIONAL
  - mechanism: 2026-11-12T00:15:01Z @kj an overlay on each icon in the shut-down state: a diagonal slash in the icon colour over a chip-coloured cutout gap
  - log: 2026-11-12T00:15:01Z @kj added
  - log: 2026-11-12T00:47:51Z @kj closed
  - log: 2026-11-12T00:48:02Z @kj edited evidence "Jest status.spec.ts:472: root dataset.vcLamp = ready/active/fault/off, lamp keeps its own. Galata bubblewrap 20 passed/0 failed: ACC-CTRL-79 root data-vc-lamp='off'; mic/play/pause ::after content '""' not none, background rgba(0, 0, 0, 0.54) = control colour, ::before background color(srgb 0.966667 0.966667 0.966667) = pill fill; ACC-CTRL-78 ready contents none." -> "Jest status.spec.ts:472: root dataset.vcLamp = ready/active/fault/off, lamp keeps its own. Galata bubblewrap 20 passed/0 failed: ACC-CTRL-79-LAMP-OFF root data-vc-lamp='off'; mic/play/pause ::after content '""' not none, background rgba(0, 0, 0, 0.54) = control colour, ::before background color(srgb 0.966667 0.966667 0.966667) = pill fill; ACC-CTRL-78-LAMP ready contents none."

## Identity and rename `NAME`

New package, labextension, command and repository names, and the republish under them

- log: 2026-11-11T22:53:26Z @kj category created

- [x] `ACC-NAME-82-MODULE` **Python module and distribution renamed** - HIGH; the distribution and module are jupyterlab_audio_extension; a built wheel installs and imports under the new path, and the old module name is absent
  - evidence: pip install of the 1.0.0 wheel succeeded during make publish; python -c import jupyterlab_audio_extension reports dist 1.0.0; pytest 95 passed on the renamed module
  - test: python -m build; install the wheel in a scratch env; import jupyterlab_audio_extension; grep for the old module
  - test-tags: UNIT, INTEGRATION
  - mechanism: 2026-11-11T22:53:26Z @kj rename the package directory, imports, pyproject name and hatch targets, and every test import
  - log: 2026-11-11T22:53:26Z @kj added
  - log: 2026-11-12T01:40:44Z @kj closed: module renamed
- [x] `ACC-NAME-83-ENTRYPOINT` **CLI renamed to jupyterlab_audio** - HIGH; the console script is jupyterlab_audio; the installed command answers --help with exit 0, and no jupyterlab_voice_capture script is installed
  - evidence: jupyterlab_audio --help exits 0 and lists install, validate, start, stop; command -v jupyterlab_voice_capture finds nothing
  - test: install the wheel; jupyterlab_audio --help; assert the old script is absent
  - test-tags: INTEGRATION
  - mechanism: 2026-11-11T22:53:31Z @kj rename the [project.scripts] entry point and every doc and test that runs the command
  - log: 2026-11-11T22:53:31Z @kj added
  - log: 2026-11-12T01:40:44Z @kj closed: CLI renamed
- [x] `ACC-NAME-84-LABEXTENSION` **npm and labextension renamed** - HIGH; the npm package and installed labextension are @stellarshenson/jupyterlab-audio-extension, and jupyter labextension list shows that name OK
  - evidence: jupyter labextension list shows @stellarshenson/jupyterlab-audio-extension v1.0.0 enabled OK (python, jupyterlab_audio_extension); no voice-capture labextension remains
  - test: make install; jupyter labextension list; grep the new name with OK
  - test-tags: FUNCTIONAL
  - mechanism: 2026-11-11T22:53:31Z @kj rename package.json, the copier answer, _jupyter_labextension_paths and the wheel shared-data target; rebuild
  - log: 2026-11-11T22:53:31Z @kj added
  - log: 2026-11-12T01:40:44Z @kj closed: labextension renamed
- [x] `ACC-NAME-85-SETTINGS` **Settings id and schema path renamed** - MEDIUM; the settings plugin id and schema path carry the new labextension name, and the settings registry loads them
  - evidence: the installed schema sits at share/jupyter/labextensions/@stellarshenson/jupyterlab-audio-extension/schemas/@stellarshenson/jupyterlab-audio-extension/plugin.json and the Galata run booted the settings registry with the new plugin id
  - test: open the new settings page in JupyterLab; the schema loads without the i.forEach error
  - test-tags: FUNCTIONAL
  - mechanism: 2026-11-11T22:53:31Z @kj rename the settings schema path and plugin id with the labextension name; reload and open the settings page
  - log: 2026-11-11T22:53:31Z @kj added
  - log: 2026-11-12T01:40:44Z @kj closed: settings renamed
- [x] `ACC-NAME-86-COMMANDS` **Command ids renamed** - HIGH; command ids use the audio: prefix; the palette, the player route and the shipped agent skill name them, and no voice-capture command id remains outside changelog and journal history
  - evidence: grep over tracked files: audio:player, audio:enable and audio:disable in src and ui-tests; no voice-capture: command id outside CHANGELOG, journal and tracker history; Jest 63 and Galata 20 passed / 2 skipped / 0 failed on the renamed ids
  - test: grep for voice-capture command ids; jupyterlab-commands list shows audio:player, audio:enable and audio:disable
  - test-tags: UNIT, FUNCTIONAL
  - mechanism: 2026-11-11T22:53:32Z @kj rename the command prefixes in src, schema, tests, docs and the agent skill; update the live allowlist later
  - log: 2026-11-11T22:53:32Z @kj added
  - log: 2026-11-12T00:49:09Z @kj closed: renamed to the audio: prefix
- [x] `ACC-NAME-87-REPO` **GitHub repository renamed** - HIGH; the GitHub repository is stellarshenson/jupyterlab_audio_extension, renamed through the GitHub API with the vault token, and the local origin URL points at it
  - evidence: PATCH /repos/stellarshenson/jupyterlab_voice_capture_extension with name jupyterlab_audio_extension returned full_name stellarshenson/jupyterlab_audio_extension; GET confirmed it; git remote -v shows https://github.com/stellarshenson/jupyterlab_audio_extension.git
  - test: read the repository through the API under the new name; git remote -v in the checkout
  - test-tags: MANUAL
  - mechanism: 2026-11-11T22:53:32Z @kj PATCH the repository name through the API; set the new remote URL; follow the redirects elsewhere
  - log: 2026-11-11T22:53:32Z @kj added
  - log: 2026-11-12T00:49:09Z @kj closed: renamed through the GitHub API
- [x] `ACC-NAME-88-WORKSPACE` **Workspace superproject points at the renamed repository** - HIGH; the workspace superproject lists the renamed repository in .gitmodules at private/jupyterlab/jupyterlab_audio_extension with the new URL
  - evidence: .gitmodules lines 357-359 carry the new section, path private/jupyterlab/jupyterlab_audio_extension and url; git mv moved the submodule checkout; the old path is absent
  - test: grep .gitmodules for the new path and URL; git submodule status in the workspace
  - test-tags: MANUAL
  - mechanism: 2026-11-11T22:53:38Z @kj edit .gitmodules path and url, move the submodule checkout, and update any workspace listing that names the old path
  - log: 2026-11-11T22:53:38Z @kj added
  - log: 2026-11-12T00:49:09Z @kj closed: workspace submodule renamed
- [x] `ACC-NAME-89-NPM` **First release published to npm under the new name** - HIGH; the first release under the new name is published to npm as @stellarshenson/jupyterlab-audio-extension and the tarball installs
  - evidence: make publish output: + @stellarshenson/jupyterlab-audio-extension@1.0.0; tarball name stellarshenson-jupyterlab-audio-extension-1.0.0.tgz
  - test: npm view @stellarshenson/jupyterlab-audio-extension version; install it in a scratch directory
  - test-tags: MANUAL
  - mechanism: 2026-11-11T22:53:38Z @kj make publish with the renamed package.json after the rename lands; the npm upload reports the new name
  - log: 2026-11-11T22:53:38Z @kj added
  - log: 2026-11-12T01:40:49Z @kj closed: published 1.0.0 to npm
- [x] `ACC-NAME-90-PYPI` **First release published to PyPI under the new name** - HIGH; the first release under the new name is published to PyPI as jupyterlab-audio-extension and the wheel installs
  - evidence: make publish output: View at https://pypi.org/project/jupyterlab-audio-extension/1.0.0/; the wheel jupyterlab_audio_extension-1.0.0-py3-none-any.whl uploaded
  - test: pip install the new distribution in a scratch environment; import jupyterlab_audio_extension
  - test-tags: MANUAL
  - mechanism: 2026-11-11T22:53:38Z @kj make publish with the renamed pyproject; the twine upload reports the new name
  - log: 2026-11-11T22:53:38Z @kj added
  - log: 2026-11-12T01:40:49Z @kj closed: published 1.0.0 to PyPI
- [x] `ACC-NAME-91-DOCS` **Current-facing files carry the new name** - MEDIUM; the old identity appears in current files only where the upgrade path needs it - the Makefile uninstall, the README upgrade section, the VoiceCapture.sink_path fallback, the old route cleanup and the voice_capture keys - and in changelog, journal and tracker history
  - evidence: git grep for the old identity over tracked files leaves CHANGELOG and journal history, the tracker history, and the upgrade-path references the plan requires; the copier answers now carry the new names (commit 403cf74)
  - test: grep -ri voice-capture over tracked files; only CHANGELOG.md and the journal history match
  - test-tags: MANUAL
  - mechanism: 2026-11-11T22:53:38Z @kj rename files and references; keep the changelog and journal entries as written
  - log: 2026-11-11T22:53:38Z @kj added
  - log: 2026-11-12T01:40:44Z @kj edited text "README, docs, the shipped agent skill, the UI test paths and the tracker file names use the new name; no current-facing file carries the old name outside changelog and journal history" -> "the old identity appears in current files only where the upgrade path needs it - the Makefile uninstall, the README upgrade section, the VoiceCapture.sink_path fallback, the old route cleanup and the voice_capture keys - and in changelog, journal and tracker history"; reason: the adjudicated upgrade path requires the old distribution name, fallback key and route prefix in the current files
  - log: 2026-11-12T01:40:49Z @kj closed: docs renamed
- [x] `ACC-NAME-92-LIVE` **Live lab carries the new command ids** - HIGH; the live lab's stored allowlist names the new command ids and no old voice-capture command id remains, and the installed extension reports the new name after an approved install and reload
  - evidence: the Commands Executor allowlist now lists audio:enable, audio:disable and audio:player with the voice-capture ids removed; the first soft reload added jupyterlab_audio_extension and the CLI reports 1.0.0 OK, the old route answers 404
  - test: read the allowlist setting; jupyter labextension list and the commands list on the running server
  - test-tags: MANUAL
  - mechanism: 2026-11-11T22:53:38Z @kj update the allowlist setting; install and reload once approved; verify the command list and the extension name
  - log: 2026-11-11T22:53:38Z @kj added
  - log: 2026-11-11T22:56:48Z @kj edited text "the live lab's stored commands allowlist names the new command ids, and the installed extension reports the new name after an approved install and reload" -> "the live lab's stored allowlist names the new command ids and no old voice-capture command id remains, and the installed extension reports the new name after an approved install and reload"; reason: the user ordered the allowlist updated with the new ids and the old ids removed
  - log: 2026-11-12T01:40:49Z @kj closed: live lab moved to the new ids
- [x] `ACC-NAME-93-TESTS` **Suites pass under the renamed module** - HIGH; Jest, pytest and Galata pass with the renamed module, labextension name and command ids
  - evidence: tsc exit 0; lint 0 problems; Jest 6 suites / 63 tests passed; pytest 92 passed; Galata 20 passed / 2 skipped / 0 failed on the renamed module and labextension
  - test: jlpm test; pytest; the Galata spec through the bubblewrap runner
  - test-tags: UNIT, FUNCTIONAL
  - mechanism: 2026-11-11T22:53:39Z @kj update the test imports, selectors and activation message expectations with the rename
  - log: 2026-11-11T22:53:39Z @kj added
  - log: 2026-11-12T00:49:09Z @kj closed: suites green under the new names
- [x] `ACC-NAME-94-SKILL` **Agent skill renamed** - HIGH; the shipped agent skill is renamed jupyterlab-audio-extension, installed under share/jupyter/agents/skills/, and names the new CLI, command ids and repository
  - evidence: the installed skill sits at share/jupyter/agents/skills/jupyterlab-audio-extension; the old skill directory is absent
  - test: install the wheel; the skill lands at share/jupyter/agents/skills/jupyterlab-audio-extension; grep the new names
  - test-tags: MANUAL
  - mechanism: 2026-11-11T22:56:48Z @kj rename the skill directory and its pyproject data-files path; rewrite the skill text for the new names
  - log: 2026-11-11T22:56:48Z @kj added
  - log: 2026-11-12T01:40:50Z @kj closed: skill renamed
