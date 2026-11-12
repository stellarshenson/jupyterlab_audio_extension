import asyncio
import json
import math
import os
import stat
import struct
import sys
import threading
import time
import wave
from pathlib import Path

import pytest
import tornado.httpclient
from jupyter_server.utils import url_path_join
from tornado.routing import PathMatches


@pytest.fixture
def voice_sink_path(tmp_path):
    return str(tmp_path / "pulseaudio.fifo")


@pytest.fixture
def jp_server_config(jp_server_config, voice_sink_path):
    """Extend the base server config with a per-test FIFO sink path."""
    config = dict(jp_server_config)
    config["AudioCapture"] = {"sink_path": voice_sink_path}
    return config


async def test_pcm_written_verbatim(jp_ws_fetch, voice_sink_path):
    # The PulseAudio reader owns FIFO creation; create it here to play that role, then
    # attach as reader before streaming so the writer thread can open the pipe.
    os.mkfifo(voice_sink_path)
    assert stat.S_ISFIFO(os.stat(voice_sink_path).st_mode)
    rfd = os.open(voice_sink_path, os.O_RDONLY | os.O_NONBLOCK)
    try:
        ws = await jp_ws_fetch(
            "jupyterlab-audio-extension", "stream"
        )
        payload = bytes(range(256)) + bytes(range(256))  # 512 bytes of known PCM
        await ws.write_message(payload, binary=True)

        received = b""
        for _ in range(60):
            await asyncio.sleep(0.05)
            try:
                received += os.read(rfd, 4096)
            except BlockingIOError:
                pass
            if len(received) >= len(payload):
                break
        ws.close()

        # C2: bytes written to the FIFO equal bytes received over the connection.
        assert received == payload
    finally:
        os.close(rfd)


async def test_multiframe_round_trip_in_order(jp_ws_fetch, voice_sink_path):
    # C2: many binary frames pushed from the browser end arrive at the FIFO end byte-for-byte
    # and in order. Each 640-byte frame carries a distinct marker so reordering is detectable.
    os.mkfifo(voice_sink_path)  # reader owns FIFO creation
    rfd = os.open(voice_sink_path, os.O_RDONLY | os.O_NONBLOCK)
    try:
        ws = await jp_ws_fetch("jupyterlab-audio-extension", "stream")
        frames = [bytes([i]) * 640 for i in range(20)]  # 20 frames, 12800 bytes total
        received = b""
        # Two bursts of 6400 bytes: the sink drops what the FIFO cannot hold, and the kernel
        # gives a FIFO only 8 KB once the user's pipes exceed fs.pipe-user-pages-soft.
        for burst in (frames[:10], frames[10:]):
            for frame in burst:
                await ws.write_message(frame, binary=True)
            received += await _read_at_least(rfd, 640 * len(burst))
        ws.close()

        assert received == b"".join(frames)  # exact bytes, exact order
    finally:
        os.close(rfd)


async def test_tolerates_absent_reader(jp_ws_fetch):
    # C3: streaming with no FIFO reader attached must not crash the server.
    ws = await jp_ws_fetch("jupyterlab-audio-extension", "stream")
    for _ in range(10):
        await ws.write_message(b"\x00\x01" * 320, binary=True)  # 640-byte frames
    await asyncio.sleep(0.2)
    ws.close()

    # The server is still responsive: a fresh connection succeeds.
    ws2 = await jp_ws_fetch("jupyterlab-audio-extension", "stream")
    ws2.close()


def test_endpoint_requires_authentication():
    # C1: the stream endpoint enforces Jupyter auth. @ws_authenticated stamps
    # __allow_unauthenticated = False on get, which is the flag jupyter_server's own
    # auth layer checks to reject anonymous connections before the websocket upgrade.
    from jupyterlab_audio_extension.routes import (
        AudioCaptureWebSocketHandler,
    )

    assert (
        getattr(AudioCaptureWebSocketHandler.get, "__allow_unauthenticated", True)
        is False
    )


async def _read_at_least(rfd, n, attempts=80):
    """Read from a non-blocking FIFO until at least n bytes arrived or the attempts run out."""
    received = b""
    for _ in range(attempts):
        await asyncio.sleep(0.05)
        try:
            received += os.read(rfd, 65536)
        except BlockingIOError:
            pass
        if len(received) >= n:
            break
    return received


async def test_wrong_token_is_refused(jp_ws_fetch):
    # C1 live: a connection without a valid Jupyter token is refused before the upgrade.
    with pytest.raises(tornado.httpclient.HTTPClientError) as refused:
        await jp_ws_fetch(
            "jupyterlab-audio-extension",
            "stream",
            headers={"Authorization": "token not-the-server-token"},
        )
    assert refused.value.code == 403


async def test_streaming_never_creates_the_fifo(jp_ws_fetch, voice_sink_path):
    # C4: the reader owns FIFO creation; streaming with no reader leaves the path absent.
    ws = await jp_ws_fetch("jupyterlab-audio-extension", "stream")
    for _ in range(10):
        await ws.write_message(b"\x00\x01" * 320, binary=True)
    await asyncio.sleep(0.5)
    ws.close()
    assert not os.path.exists(voice_sink_path)


async def test_regular_file_at_sink_path_is_never_written(jp_ws_fetch, voice_sink_path):
    # C5: a regular file that appears at the sink path after startup is never written to.
    with open(voice_sink_path, "wb"):
        pass
    ws = await jp_ws_fetch("jupyterlab-audio-extension", "stream")
    for _ in range(10):
        await ws.write_message(b"\x00\x01" * 320, binary=True)
    await asyncio.sleep(0.5)
    ws.close()
    assert os.path.getsize(voice_sink_path) == 0


async def test_new_reader_gets_audio_after_the_old_one_left(jp_ws_fetch, voice_sink_path):
    # DEF-BRIDGE-2: after the FIFO reader goes away (PulseAudio restart), the next reader
    # gets live audio again - the writer thread must survive the broken pipe.
    os.mkfifo(voice_sink_path)
    frame = b"\x01\x02" * 320
    rfd = os.open(voice_sink_path, os.O_RDONLY | os.O_NONBLOCK)
    ws = await jp_ws_fetch("jupyterlab-audio-extension", "stream")
    await ws.write_message(frame, binary=True)
    assert len(await _read_at_least(rfd, len(frame))) >= len(frame)
    os.close(rfd)  # the reader goes away; the next write hits a broken pipe

    for _ in range(5):
        await ws.write_message(frame, binary=True)
        await asyncio.sleep(0.05)

    rfd = os.open(voice_sink_path, os.O_RDONLY | os.O_NONBLOCK)  # a new reader
    try:
        for _ in range(5):
            await ws.write_message(frame, binary=True)
        assert len(await _read_at_least(rfd, len(frame))) >= len(frame)
    finally:
        ws.close()
        os.close(rfd)


async def test_reader_never_gets_audio_from_before_it_attached(jp_ws_fetch, voice_sink_path):
    # A reader that attaches later gets live audio only, never frames that arrived while no
    # reader existed (PulseAudio stopped, or the FIFO not yet created).
    ws = await jp_ws_fetch("jupyterlab-audio-extension", "stream")
    for _ in range(5):
        await ws.write_message(b"\xaa" * 640, binary=True)
    await asyncio.sleep(0.6)

    os.mkfifo(voice_sink_path)
    rfd = os.open(voice_sink_path, os.O_RDONLY | os.O_NONBLOCK)
    try:
        for _ in range(5):
            await ws.write_message(b"\x01" * 640, binary=True)
        received = await _read_at_least(rfd, 640)
        assert received and b"\xaa" not in received
    finally:
        ws.close()
        os.close(rfd)


# -- speaker path ----------------------------------------------------------------------


@pytest.fixture
def speaker_path(voice_sink_path):
    from jupyterlab_audio_extension.speaker import SPEAKER_FIFO_NAME

    return os.path.join(os.path.dirname(voice_sink_path), SPEAKER_FIFO_NAME)


def _pipe_sink(path):
    """Play module-pipe-sink: create the FIFO and hold it open read-write."""
    os.mkfifo(path)
    return os.open(path, os.O_RDWR)


async def _receive(ws, n):
    """Collect speaker messages until at least n bytes arrived."""
    messages = []
    while sum(map(len, messages)) < n:
        messages.append(await asyncio.wait_for(ws.read_message(), 5))
    return messages


async def test_speaker_without_a_token_is_refused(jp_ws_fetch):
    from jupyterlab_audio_extension.routes import SpeakerWebSocketHandler

    # The test server refuses anonymous requests server-wide; the decorator keeps the
    # endpoint authenticated on a server that allows them.
    assert getattr(SpeakerWebSocketHandler.get, "__allow_unauthenticated", True) is False
    with pytest.raises(tornado.httpclient.HTTPClientError) as refused:
        await jp_ws_fetch(
            "jupyterlab-audio-extension", "speaker", headers={"Authorization": ""}
        )
    assert refused.value.code == 403


async def test_speaker_pcm_arrives_verbatim_in_whole_frames(jp_ws_fetch, speaker_path):
    wfd = _pipe_sink(speaker_path)
    try:
        ws = await jp_ws_fetch("jupyterlab-audio-extension", "speaker")
        data = bytes(range(256)) * 16
        # 37-byte writes split sample frames across reads; the reader must rejoin them.
        for i in range(0, len(data), 37):
            os.write(wfd, data[i : i + 37])
            await asyncio.sleep(0.01)
        messages = await _receive(ws, len(data))
        ws.close()

        assert b"".join(messages) == data
        assert all(isinstance(m, bytes) and len(m) % 4 == 0 for m in messages)
    finally:
        os.close(wfd)


async def test_speaker_audio_from_before_a_tab_connected_is_discarded(jp_ws_fetch, speaker_path):
    wfd = _pipe_sink(speaker_path)
    try:
        os.write(wfd, b"\xaa" * 4000)
        await asyncio.sleep(0.6)  # the reader opens the FIFO within 0.2 s
        ws = await jp_ws_fetch("jupyterlab-audio-extension", "speaker")
        os.write(wfd, b"\x01" * 4000)
        received = b"".join(await _receive(ws, 4000))
        ws.close()

        assert received == b"\x01" * 4000
    finally:
        os.close(wfd)


async def test_two_speaker_listeners_both_receive_the_same_bytes(jp_ws_fetch, speaker_path):
    wfd = _pipe_sink(speaker_path)
    try:
        first = await jp_ws_fetch("jupyterlab-audio-extension", "speaker")
        second = await jp_ws_fetch("jupyterlab-audio-extension", "speaker")
        data = bytes(range(256)) * 16
        os.write(wfd, data)
        assert b"".join(await _receive(first, len(data))) == data
        assert b"".join(await _receive(second, len(data))) == data
        assert first.close_code is None and second.close_code is None
        first.close()
        second.close()
    finally:
        os.close(wfd)


async def test_producer_and_listener_do_not_close_each_other(jp_ws_fetch):
    stream = await jp_ws_fetch("jupyterlab-audio-extension", "stream")
    speaker = await jp_ws_fetch("jupyterlab-audio-extension", "speaker")
    await asyncio.sleep(0.3)
    assert stream.close_code is None  # a listener does not take the producer slot

    stream2 = await jp_ws_fetch("jupyterlab-audio-extension", "stream")
    await asyncio.sleep(0.3)
    assert speaker.close_code is None  # a producer does not close a listener
    for ws in (stream, speaker, stream2):
        ws.close()


async def test_regular_file_at_speaker_path_is_never_read(jp_ws_fetch, speaker_path):
    with open(speaker_path, "wb") as handle:
        handle.write(b"\xaa" * 4000)
    ws = await jp_ws_fetch("jupyterlab-audio-extension", "speaker")
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(ws.read_message(), 1)
    ws.close()


async def test_speaker_reader_recovers_after_the_writer_closes(jp_ws_fetch, speaker_path):
    wfd = _pipe_sink(speaker_path)
    ws = await jp_ws_fetch("jupyterlab-audio-extension", "speaker")
    os.write(wfd, b"\x01" * 400)
    assert b"".join(await _receive(ws, 400)) == b"\x01" * 400

    # PulseAudio restarts: the old writer goes (EOF) and a new FIFO appears at the path.
    os.close(wfd)
    os.unlink(speaker_path)
    wfd = _pipe_sink(speaker_path)
    try:
        os.write(wfd, b"\x02" * 400)
        assert b"".join(await _receive(ws, 400)) == b"\x02" * 400
    finally:
        ws.close()
        os.close(wfd)


def test_speaker_drops_data_while_half_a_second_waits_unsent():
    import concurrent.futures

    from jupyterlab_audio_extension.routes import SpeakerWebSocketHandler

    handler = SpeakerWebSocketHandler.__new__(SpeakerWebSocketHandler)
    handler._pending = 0
    futures = []

    def write_message(data, binary):
        futures.append(concurrent.futures.Future())
        return futures[-1]

    handler.write_message = write_message
    for _ in range(4):
        handler._send(b"\0" * 48000)
    assert len(futures) == 3  # 0, 48000 and 96000 bytes pending: sent; 144000: dropped

    futures[0].set_result(None)
    handler._send(b"\0" * 48000)
    assert len(futures) == 4


def test_a_slow_speaker_listener_does_not_drop_data_for_another():
    import concurrent.futures

    from jupyterlab_audio_extension.routes import SpeakerWebSocketHandler

    def listener(futures, finish):
        handler = SpeakerWebSocketHandler.__new__(SpeakerWebSocketHandler)
        handler._pending = 0

        def write_message(data, binary):
            futures.append(concurrent.futures.Future())
            if finish:
                futures[-1].set_result(None)
            return futures[-1]

        handler.write_message = write_message
        return handler

    slow, fast = [], []
    listeners = {listener(slow, finish=False), listener(fast, finish=True)}
    SpeakerWebSocketHandler._listeners |= listeners
    try:
        for _ in range(6):
            SpeakerWebSocketHandler._broadcast(b"\0" * 48000)
    finally:
        SpeakerWebSocketHandler._listeners -= listeners
    assert len(slow) == 3  # its own bound: 144000 bytes pending, the rest dropped
    assert len(fast) == 6


# -- player route ----------------------------------------------------------------------

PLAYER = ("jupyterlab-audio-extension", "player")
EMPTY_PLAYER = {"paused": False, "stopped": False, "playing": [], "queue": []}


async def _player(jp_fetch, body, headers=None):
    return await jp_fetch(
        *PLAYER,
        method="POST",
        body=json.dumps(body),
        headers={"Content-Type": "application/json", **(headers or {})},
    )


def _player_state(response):
    """The response state without the sink report, which the sink tests cover."""
    state = json.loads(response.body)
    state.pop("sink")
    return state


def _player_message(refused):
    """The message from the 400 the player route returned."""
    return json.loads(refused.value.response.body)["message"]


def _tone_wav(path, seconds=5.0, rate=48000):
    """A 440 Hz mono s16 wav file the real paplay can decode."""
    frames = bytearray()
    for index in range(int(rate * seconds)):
        sample = 0.5 * 32767 * math.sin(2 * math.pi * 440 * index / rate)
        frames += struct.pack("<h", int(sample))
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(bytes(frames))


async def test_player_route_requires_the_token(jp_fetch):
    # ACC-PLAYER-60: @tornado.web.authenticated keeps the handler authenticated on a server
    # that allows anonymous access; the test server refuses anonymous requests anyway.
    with pytest.raises(tornado.httpclient.HTTPClientError) as refused:
        await _player(jp_fetch, {"action": "status"}, headers={"Authorization": ""})
    assert refused.value.code == 403


async def test_player_route_returns_the_empty_state(jp_fetch):
    response = await _player(jp_fetch, {"action": "status"})
    assert response.code == 200
    assert _player_state(response) == EMPTY_PLAYER


async def test_player_status_reports_a_missing_speaker_fifo(jp_fetch, speaker_path):
    # ACC-PLAYER-80: an absent speaker FIFO with no stop marker reads missing.
    response = await _player(jp_fetch, {"action": "status"})
    assert json.loads(response.body)["sink"] == {"state": "missing"}


async def test_player_status_reports_a_ready_speaker_fifo(jp_fetch, speaker_path):
    # ACC-PLAYER-80: module-pipe-sink created the FIFO, so the sink is ready.
    os.mkfifo(speaker_path)
    response = await _player(jp_fetch, {"action": "status"})
    assert json.loads(response.body)["sink"] == {"state": "ready"}


async def test_player_status_reports_a_speaker_path_that_is_not_a_fifo(jp_fetch, speaker_path):
    with open(speaker_path, "wb"):
        pass
    response = await _player(jp_fetch, {"action": "status"})
    assert json.loads(response.body)["sink"] == {"state": "missing"}


async def test_player_status_lets_a_stop_marker_win_over_a_stale_speaker_fifo(
    jp_fetch, speaker_path
):
    # ACC-PLAYER-80: a killed daemon can leave its FIFO behind; the stop marker still reads off.
    from jupyterlab_audio_extension.speaker import STOP_MARKER_NAME

    os.mkfifo(speaker_path)
    with open(os.path.join(os.path.dirname(speaker_path), STOP_MARKER_NAME), "w"):
        pass
    response = await _player(jp_fetch, {"action": "status"})
    assert json.loads(response.body)["sink"] == {"state": "off"}


async def test_player_route_names_an_unknown_action_and_changes_nothing(jp_fetch):
    with pytest.raises(tornado.httpclient.HTTPClientError) as refused:
        await _player(jp_fetch, {"action": "explode"})
    assert refused.value.code == 400
    assert "explode" in _player_message(refused)
    response = await _player(jp_fetch, {"action": "status"})
    assert _player_state(response) == EMPTY_PLAYER


async def test_player_route_names_a_missing_path(jp_fetch):
    with pytest.raises(tornado.httpclient.HTTPClientError) as refused:
        await _player(jp_fetch, {"action": "play"})
    assert refused.value.code == 400
    assert "path" in _player_message(refused)


async def test_player_route_refuses_a_path_outside_the_root(jp_fetch):
    path = "../../outside.wav"
    with pytest.raises(tornado.httpclient.HTTPClientError) as refused:
        await _player(jp_fetch, {"action": "play", "path": path})
    assert refused.value.code == 400
    assert path in _player_message(refused)


async def test_player_route_names_a_missing_file(jp_fetch):
    with pytest.raises(tornado.httpclient.HTTPClientError) as refused:
        await _player(jp_fetch, {"action": "play", "path": "missing.wav"})
    assert refused.value.code == 400
    assert "missing.wav" in _player_message(refused)


async def test_player_route_refuses_a_file_that_does_not_decode(
    jp_fetch, jp_serverapp, pulse_server
):
    # ACC-PLAYER-61: paplay's failure reaches the caller as a 400 that names the file, and
    # the player state does not change.
    root = Path(jp_serverapp.contents_manager.root_dir)
    (root / "not-audio.wav").write_bytes(b"not audio")
    with pytest.raises(tornado.httpclient.HTTPClientError) as refused:
        await _player(jp_fetch, {"action": "play", "path": "not-audio.wav"})
    assert refused.value.code == 400
    assert "not-audio.wav" in _player_message(refused)
    response = await _player(jp_fetch, {"action": "status"})
    assert _player_state(response) == EMPTY_PLAYER


def _player_pids(root):
    """Live paplay processes this server's player started: same client name and file root."""
    marker = str(root).encode()
    pids = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/cmdline", "rb") as handle:
                argv = handle.read().split(b"\0")
        except OSError:
            continue
        if (
            argv
            and argv[0].endswith(b"paplay")
            and b"--client-name=audio-player" in argv
            and any(argument.startswith(marker) for argument in argv)
        ):
            pids.append(int(entry))
    return pids


async def test_a_second_load_stops_the_previous_players_paplay(
    jp_serverapp, jp_fetch, soft_reload, pulse_server
):
    # ACC-PLAYER-62: after a soft reload exactly one player exists and no player process
    # from the previous load remains.
    root = Path(jp_serverapp.contents_manager.root_dir)
    _tone_wav(root / "reload-tone.wav")
    await _player(jp_fetch, {"action": "play", "path": "reload-tone.wav"})
    assert _player_pids(root)

    await soft_reload()

    deadline = time.monotonic() + 5
    while _player_pids(root) and time.monotonic() < deadline:
        await asyncio.sleep(0.05)
    assert _player_pids(root) == []


# -- reload and unload -----------------------------------------------------------------

PACKAGE = "jupyterlab_audio_extension"


@pytest.fixture
def soft_reload(jp_serverapp):
    """Load the extension again the way galaxalab_utils.soft_reload does: forget its
    modules and manager entries, add, link, load and start it through the live
    ExtensionManager, then move the new routes in front of the old ones."""
    saved = {name: module for name, module in sys.modules.items() if name.split(".")[0] == PACKAGE}

    async def reload():
        manager = jp_serverapp.extension_manager
        routers = [jp_serverapp.web_app.default_router, jp_serverapp.web_app.wildcard_router]
        known = [{id(rule) for rule in router.rules} for router in routers]
        for name in [name for name in sys.modules if name.split(".")[0] == PACKAGE]:
            del sys.modules[name]
        manager.extensions.pop(PACKAGE, None)
        manager.linked_extensions.pop(PACKAGE, None)
        jp_serverapp.reraise_server_extension_failures = True
        assert manager.add_extension(PACKAGE, enabled=True)
        manager.link_extension(PACKAGE)
        manager.load_extension(PACKAGE)
        await manager.start_extension(PACKAGE)
        for router, old in zip(routers, known):
            router.rules[:] = [rule for rule in router.rules if id(rule) not in old] + [
                rule for rule in router.rules if id(rule) in old
            ]

    yield reload
    sys.modules.update(saved)  # later tests keep the modules they imported


def _alive(name):
    return sum(thread.name == name for thread in threading.enumerate())


def _descriptors_on(*paths):
    """Descriptors this process holds open on the given paths."""
    held = set()
    for fd in os.listdir("/proc/self/fd"):
        try:
            if os.readlink(f"/proc/self/fd/{fd}") in paths:
                held.add(int(fd))
        except OSError:
            pass  # closed after listdir
    return held


async def test_a_second_load_replaces_the_sink_and_the_speaker_reader(
    jp_serverapp, jp_ws_fetch, soft_reload, voice_sink_path, speaker_path
):
    settings = jp_serverapp.web_app.settings
    first_sink, first_reader = settings["audio_capture_sink"], settings["audio_capture_speaker"]
    # Earlier tests' servers leave their threads running, so count against this server's start.
    names = ("audio-fifo-writer", "audio-speaker-reader")
    counts = [_alive(name) for name in names]
    await soft_reload()

    assert not first_sink._thread.is_alive() and not first_reader._thread.is_alive()
    assert [_alive(name) for name in names] == counts  # one of each stopped, one started
    os.mkfifo(voice_sink_path)
    rfd = os.open(voice_sink_path, os.O_RDONLY | os.O_NONBLOCK)
    wfd = _pipe_sink(speaker_path)
    try:
        stream = await jp_ws_fetch("jupyterlab-audio-extension", "stream")
        speaker = await jp_ws_fetch("jupyterlab-audio-extension", "speaker")
        await stream.write_message(b"\x01\x02" * 320, binary=True)
        assert await _read_at_least(rfd, 640) == b"\x01\x02" * 320
        os.write(wfd, b"\x03" * 400)
        assert b"".join(await _receive(speaker, 400)) == b"\x03" * 400
        stream.close()
        speaker.close()
    finally:
        os.close(rfd)
        os.close(wfd)


async def test_a_second_load_closes_open_sockets_so_tabs_reconnect(
    jp_serverapp, jp_ws_fetch, soft_reload
):
    stream = await jp_ws_fetch("jupyterlab-audio-extension", "stream")
    speaker = await jp_ws_fetch("jupyterlab-audio-extension", "speaker")
    await soft_reload()

    for ws in (stream, speaker):
        assert await asyncio.wait_for(ws.read_message(), 5) is None
        assert ws.close_code == 1001  # the frontend reconnects on it, not on 4001

    stream = await jp_ws_fetch("jupyterlab-audio-extension", "stream")
    speaker = await jp_ws_fetch("jupyterlab-audio-extension", "speaker")
    routes = sys.modules[PACKAGE + ".routes"]  # the second load's module
    connections = jp_serverapp.web_app.settings[routes.CONNECTIONS_KEY]
    assert {type(connection) for connection in connections} == {
        routes.AudioCaptureWebSocketHandler,
        routes.SpeakerWebSocketHandler,
    }
    stream.close()
    speaker.close()


async def test_a_load_after_1_0_18_closes_its_sink(jp_serverapp, soft_reload):
    settings = jp_serverapp.web_app.settings
    settings.pop("audio_capture_speaker").close()
    del settings["audio_capture_connections"]
    # What 1.0.18 left in the settings: only its FifoSink, under the old key and with the
    # sink.py of this package.
    settings["voice_capture_sink"] = settings.pop("audio_capture_sink")
    old_sink = settings["voice_capture_sink"]
    await soft_reload()

    assert not old_sink._thread.is_alive()
    assert settings["audio_capture_sink"]._thread.is_alive()
    assert settings["audio_capture_speaker"]._thread.is_alive()


def _handler_classes(web_app):
    """The handler class of every route rule from this package's routes module, in both routers."""
    return [
        rule.target
        for router in (web_app.default_router, web_app.wildcard_router)
        for host_rule in router.rules
        for rule in getattr(host_rule.target, "rules", [])
        if getattr(rule.target, "__module__", None) == PACKAGE + ".routes"
    ]


def _rules_under(web_app, prefix):
    """Every route rule in both routers whose path starts with prefix."""
    return [
        rule
        for router in (web_app.default_router, web_app.wildcard_router)
        for host_rule in router.rules
        for rule in getattr(host_rule.target, "rules", [])
        if isinstance(rule.matcher, PathMatches)
        and rule.matcher.regex.pattern.startswith(prefix)
    ]


async def test_a_second_load_replaces_the_player(jp_serverapp, soft_reload):
    # ACC-PLAYER-62: one player per server process; the load hook stops and replaces it.
    settings = jp_serverapp.web_app.settings
    first = settings["audio_capture_player"]
    await soft_reload()

    player = settings["audio_capture_player"]
    assert player is not first
    assert player.status() == EMPTY_PLAYER


async def test_a_second_load_removes_the_previous_routes(jp_serverapp, soft_reload):
    web_app = jp_serverapp.web_app
    assert len(_handler_classes(web_app)) == 3
    await soft_reload()

    routes = sys.modules[PACKAGE + ".routes"]
    assert _handler_classes(web_app) == [
        routes.AudioCaptureWebSocketHandler,
        routes.SpeakerWebSocketHandler,
        routes.PlayerHandler,
    ]


async def test_a_load_after_1_0_18_closes_its_producer_so_the_tab_reconnects(
    jp_serverapp, jp_ws_fetch, soft_reload
):
    web_app = jp_serverapp.web_app
    settings = web_app.settings
    routes = sys.modules[PACKAGE + ".routes"]
    old_prefix = url_path_join(
        web_app.settings["base_url"], "jupyterlab-voice-capture-extension"
    )
    # 1.0.18 registered its routes under the old prefix and held its producer only in the
    # handler class attribute _active; its settings kept only the sink, under the old key.
    web_app.add_handlers(
        ".*$",
        [
            (
                url_path_join(old_prefix, "stream"),
                routes.AudioCaptureWebSocketHandler,
                {"sink": settings["audio_capture_sink"]},
            )
        ],
    )
    stream = await jp_ws_fetch("jupyterlab-voice-capture-extension", "stream")
    settings.pop("audio_capture_speaker").close()
    del settings["audio_capture_connections"]
    settings["voice_capture_sink"] = settings.pop("audio_capture_sink")
    await soft_reload()

    assert await asyncio.wait_for(stream.read_message(), 5) is None
    assert stream.close_code == 1001
    assert _rules_under(web_app, old_prefix + "/") == []
    stream = await jp_ws_fetch("jupyterlab-audio-extension", "stream")
    routes = sys.modules[PACKAGE + ".routes"]
    assert routes.AudioCaptureWebSocketHandler._active is not None
    stream.close()


async def test_unload_stops_both_threads_and_releases_connections_and_fifos(
    jp_serverapp, jp_ws_fetch, voice_sink_path, speaker_path
):
    from jupyterlab_audio_extension import _unload_jupyter_server_extension

    settings = jp_serverapp.web_app.settings
    sink, reader = settings["audio_capture_sink"], settings["audio_capture_speaker"]
    os.mkfifo(voice_sink_path)
    rfd = os.open(voice_sink_path, os.O_RDONLY | os.O_NONBLOCK)
    wfd = _pipe_sink(speaker_path)
    try:
        stream = await jp_ws_fetch("jupyterlab-audio-extension", "stream")
        speaker = await jp_ws_fetch("jupyterlab-audio-extension", "speaker")
        await stream.write_message(b"\x01" * 640, binary=True)
        assert len(await _read_at_least(rfd, 640)) == 640
        os.write(wfd, b"\x02" * 400)
        assert b"".join(await _receive(speaker, 400)) == b"\x02" * 400
        # The writer and the reader thread each hold their FIFO open now.
        assert len(_descriptors_on(voice_sink_path, speaker_path) - {rfd, wfd}) == 2

        _unload_jupyter_server_extension(jp_serverapp)

        assert not sink._thread.is_alive() and not reader._thread.is_alive()
        for ws in (stream, speaker):
            assert await asyncio.wait_for(ws.read_message(), 5) is None
            assert ws.close_code == 1001
        assert _descriptors_on(voice_sink_path, speaker_path) - {rfd, wfd} == set()
    finally:
        os.close(rfd)
        os.close(wfd)
