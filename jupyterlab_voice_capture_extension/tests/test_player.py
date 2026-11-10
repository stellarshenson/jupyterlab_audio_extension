"""The virtual player: its state machine with a fake process, and its real paplay engine.

These tests fix the interface the build implements in
``jupyterlab_voice_capture_extension/player.py``::

    Player(root_dir, log=None, spawn=None, clock=None)
    play(path, mode="queue") -> state
    pause(), resume(), stop(), clear(), status() -> state
    close()

``spawn(argv, **kwargs)`` returns a process handle with ``pid``, ``poll()``,
``wait(timeout=None)``, ``send_signal(sig)`` and a binary ``stderr`` stream; the default is
``subprocess.Popen``. ``clock()`` is the wall clock for the position only - start, pause and
resume times - and defaults to ``time.monotonic``; the short grace that turns an immediate
``paplay`` failure into a refusal must wait on the process (``wait(timeout)``), never on the
injected clock. ``close()`` stops every process and is what the extension's load and unload
hook calls.

The state is the JSON object the route returns::

    {"paused": bool, "stopped": bool,
     "playing": [{"id": int, "path": str, "position_s": float}],
     "queue": [{"id": int, "path": str}]}

A paused record stays in ``playing`` with its position frozen; ``paused`` says it is not
audible. ``stopped`` is the gate that stop sets so the queue does not advance.
"""

import io
import math
import os
import signal
import struct
import subprocess
import threading
import time
import wave

import pytest

from jupyterlab_voice_capture_extension.player import Player

EMPTY_STATE = {"paused": False, "stopped": False, "playing": [], "queue": []}


class FakeProcess:
    """A paplay stand-in.

    ``send_signal`` records the signal; SIGTERM and SIGKILL end the process, as they end
    real paplay, so the player's monitor thread returns. The pid is not a live one: if the
    player used ``os.kill`` instead of ``process.send_signal``, nothing would be signalled.
    """

    def __init__(self, argv, stderr=b"", returncode=None):
        self.argv = list(argv)
        self.pid = 2**31 - 1
        self.returncode = returncode
        self.signals = []
        self.stderr = io.BytesIO(stderr)
        self._done = threading.Event()
        if returncode is not None:
            self._done.set()

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        if self._done.wait(timeout):
            return self.returncode
        raise subprocess.TimeoutExpired(self.argv, timeout)

    def send_signal(self, sig):
        self.signals.append(sig)
        if sig in (signal.SIGTERM, signal.SIGKILL):
            self.finish(-sig)

    def terminate(self):
        self.send_signal(signal.SIGTERM)

    def kill(self):
        self.send_signal(signal.SIGKILL)

    def finish(self, code=0):
        self.returncode = code
        self._done.set()


class Spawns:
    """The injected spawn callable. ``returncode`` makes every process fail at once."""

    def __init__(self, stderr=b"", returncode=None):
        self.stderr = stderr
        self.returncode = returncode
        self.processes = []

    def __call__(self, argv, **kwargs):
        process = FakeProcess(argv, stderr=self.stderr, returncode=self.returncode)
        self.processes.append(process)
        return process


class Clock:
    """Testing clock: the tests choose every reading."""

    def __init__(self, now=100.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def _files(tmp_path, *names):
    for name in names:
        (tmp_path / name).write_bytes(b"RIFF")
    return [str(tmp_path / name) for name in names]


def _paths(state, key):
    return [entry["path"] for entry in state[key]]


def _wait_for(check):
    """Poll until the monitor threads have done their work."""
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.01)
    raise AssertionError("the player did not reach the expected state in 2 s")


def _wait_paths(player, key, expected):
    def check():
        state = player.status()
        return state if _paths(state, key) == expected else None

    return _wait_for(check)


def test_play_queues_and_starts_the_next_file_in_order(tmp_path):
    a, b, c = _files(tmp_path, "a.wav", "b.wav", "c.wav")
    spawn = Spawns()
    player = Player(str(tmp_path), spawn=spawn, clock=Clock())
    try:
        first = player.play("a.wav")
        assert _paths(first, "playing") == [a]
        assert first["queue"] == []
        assert first["paused"] is False and first["stopped"] is False

        argv = spawn.processes[0].argv
        assert argv[0] == "paplay"
        assert "--client-name=voice-capture-player" in argv
        assert "--latency-msec=200" in argv
        assert a in argv

        second = player.play("b.wav")
        third = player.play("c.wav")
        assert _paths(second, "playing") == [a]
        assert _paths(second, "queue") == [b]
        assert _paths(third, "queue") == [b, c]
        ids = [entry["id"] for entry in third["playing"] + third["queue"]]
        assert all(isinstance(value, int) for value in ids)
        assert len(set(ids)) == 3  # unique for the life of the process
        assert len(spawn.processes) == 1  # a queued file starts no process

        spawn.processes[0].finish(0)
        state = _wait_paths(player, "playing", [b])
        assert _paths(state, "queue") == [c]

        spawn.processes[1].finish(1)  # a failure advances the queue too
        state = _wait_paths(player, "playing", [c])
        assert state["queue"] == []
    finally:
        player.close()


def test_play_now_mixes_with_what_is_playing(tmp_path):
    a, b = _files(tmp_path, "a.wav", "b.wav")
    spawn = Spawns()
    player = Player(str(tmp_path), spawn=spawn, clock=Clock())
    try:
        player.play("a.wav")
        state = player.play("b.wav", mode="now")
        assert _paths(state, "playing") == [a, b]  # start order
        assert state["queue"] == []
        assert len(spawn.processes) == 2

        spawn.processes[0].finish(0)
        _wait_paths(player, "playing", [b])
        spawn.processes[1].finish(0)
        _wait_paths(player, "playing", [])
    finally:
        player.close()


def test_pause_freezes_the_position_and_resume_continues_it(tmp_path):
    a, = _files(tmp_path, "a.wav")
    spawn = Spawns()
    clock = Clock(100.0)
    player = Player(str(tmp_path), spawn=spawn, clock=clock)
    try:
        player.play("a.wav")
        clock.advance(3.5)
        assert player.status()["playing"][0]["position_s"] == pytest.approx(
            3.5, abs=1e-3
        )

        clock.advance(0.5)
        paused = player.pause()
        assert paused["paused"] is True
        assert paused["playing"][0]["position_s"] == pytest.approx(4.0, abs=1e-3)
        assert _paths(paused, "playing") == [a]
        assert spawn.processes[0].signals == [signal.SIGSTOP]

        clock.advance(10.0)
        frozen = player.status()
        assert frozen["paused"] is True
        assert frozen["playing"][0]["position_s"] == pytest.approx(4.0, abs=1e-3)

        resumed = player.resume()
        assert resumed["paused"] is False
        assert spawn.processes[0].signals == [signal.SIGSTOP, signal.SIGCONT]

        clock.advance(1.0)
        assert player.status()["playing"][0]["position_s"] == pytest.approx(
            5.0, abs=1e-3
        )
    finally:
        player.close()


def test_stop_ends_playing_keeps_the_queue_and_gates_advance(tmp_path):
    a, b = _files(tmp_path, "a.wav", "b.wav")
    spawn = Spawns()
    player = Player(str(tmp_path), spawn=spawn, clock=Clock())
    try:
        player.play("a.wav")
        queued = player.play("b.wav")["queue"][0]

        stopped = player.stop()
        assert stopped["stopped"] is True
        assert stopped["playing"] == []
        assert stopped["queue"] == [queued]

        # a exits on SIGTERM, as real paplay does; the gate keeps the monitor from
        # starting b anyway.
        time.sleep(0.2)
        assert player.status()["playing"] == []
        assert len(spawn.processes) == 1

        resumed = player.resume()  # clears the gate and starts the queue
        assert resumed["stopped"] is False
        assert _paths(resumed, "playing") == [b]
        assert len(spawn.processes) == 2
    finally:
        player.close()


def test_play_after_stop_starts_the_queue_head_before_the_new_file(tmp_path):
    # A play clears the gate; it must start the first queued record, not the record it
    # appends, so a file queued before stop keeps its turn ahead of the new one.
    a, b, c = _files(tmp_path, "a.wav", "b.wav", "c.wav")
    spawn = Spawns()
    player = Player(str(tmp_path), spawn=spawn, clock=Clock())
    try:
        player.play("a.wav")
        queued = player.play("b.wav")
        assert _paths(queued, "queue") == [b]
        b_id = queued["queue"][0]["id"]

        stopped = player.stop()  # a ends; b stays queued and the gate is set
        assert _paths(stopped, "queue") == [b]
        assert stopped["stopped"] is True

        state = player.play("c.wav")  # mode queue: the head b starts, c waits
        assert _paths(state, "playing") == [b]
        assert _paths(state, "queue") == [c]
        c_id = state["queue"][0]["id"]
        assert [entry["id"] for entry in state["playing"]] == [b_id]
        assert b_id < c_id
        assert len(spawn.processes) == 2  # a, then b; c has not started

        spawn.processes[1].finish(0)  # b ends; the queue advances to c
        state = _wait_paths(player, "playing", [c])
        assert state["queue"] == []
    finally:
        player.close()


def test_a_queue_mode_play_that_fails_in_the_grace_is_still_refused(tmp_path):
    # Mode queue on an idle player starts the queue head; a head that paplay refuses is
    # removed and the call raises, so the failed file leaves no record behind.
    _files(tmp_path, "junk.wav")
    spawn = Spawns(returncode=1, stderr=b"paplay: Failed to open file: unknown format\n")
    player = Player(str(tmp_path), spawn=spawn, clock=Clock())
    try:
        with pytest.raises(ValueError) as refused:
            player.play("junk.wav")
        assert "junk.wav" in str(refused.value)
        assert "unknown format" in str(refused.value)
        assert player.status() == EMPTY_STATE
        assert len(spawn.processes) == 1
    finally:
        player.close()


def test_stop_releases_a_paused_process_before_terminating_it(tmp_path):
    _files(tmp_path, "a.wav")
    spawn = Spawns()
    player = Player(str(tmp_path), spawn=spawn, clock=Clock())
    try:
        player.play("a.wav")
        player.pause()
        player.stop()

        assert spawn.processes[0].signals == [
            signal.SIGSTOP,
            signal.SIGCONT,
            signal.SIGTERM,
        ]
    finally:
        player.close()


def test_clear_removes_the_queue_only(tmp_path):
    a, b, c = _files(tmp_path, "a.wav", "b.wav", "c.wav")
    spawn = Spawns()
    player = Player(str(tmp_path), spawn=spawn, clock=Clock())
    try:
        player.play("a.wav")
        player.play("b.wav")
        player.play("c.wav")

        cleared = player.clear()
        assert _paths(cleared, "playing") == [a]
        assert cleared["queue"] == []

        spawn.processes[0].finish(0)
        _wait_paths(player, "playing", [])
        assert len(spawn.processes) == 1  # b and c never start
    finally:
        player.close()


def test_status_reports_after_a_play_without_changing_anything(tmp_path):
    _files(tmp_path, "a.wav")
    spawn = Spawns()
    clock = Clock()
    player = Player(str(tmp_path), spawn=spawn, clock=clock)
    try:
        player.play("a.wav")
        clock.advance(1.0)
        first = player.status()
        assert first["playing"][0]["position_s"] == pytest.approx(1.0, abs=1e-3)
        assert player.status() == first
    finally:
        player.close()


def test_bad_input_is_refused_and_changes_nothing(tmp_path):
    _files(tmp_path, "a.wav")
    outside = tmp_path.parent / f"{tmp_path.name}-outside.wav"
    outside.write_bytes(b"RIFF")
    player = Player(str(tmp_path), spawn=Spawns(), clock=Clock())
    try:
        for path in (None, "", "missing.wav", "../outside.wav", str(outside)):
            with pytest.raises(ValueError):
                player.play(path)
        assert player.status() == EMPTY_STATE
    finally:
        player.close()


def test_an_undecodable_file_is_refused_with_paplays_reason(tmp_path):
    _files(tmp_path, "junk.wav")
    spawn = Spawns(returncode=1, stderr=b"paplay: Failed to open file: unknown format\n")
    player = Player(str(tmp_path), spawn=spawn, clock=Clock())
    try:
        with pytest.raises(ValueError) as refused:
            player.play("junk.wav")
        message = str(refused.value)
        assert "junk.wav" in message
        assert "unknown format" in message  # the last stderr line names the problem
        assert player.status() == EMPTY_STATE
    finally:
        player.close()


def test_a_spawn_error_is_refused_without_changing_the_state(tmp_path):
    # A spawn that fails raises OSError (a missing paplay, for one). The call raises
    # ValueError naming the problem, and the refused request leaves no record and no gate
    # change.
    _files(tmp_path, "a.wav")

    def broken_spawn(argv, **kwargs):
        raise FileNotFoundError(2, "No such file or directory", "paplay")

    player = Player(str(tmp_path), spawn=broken_spawn, clock=Clock())
    try:
        with pytest.raises(ValueError) as refused:
            player.play("a.wav")
        assert "a.wav" in str(refused.value)
        assert "paplay" in str(refused.value)
        assert player.status() == EMPTY_STATE
    finally:
        player.close()


def test_a_refused_play_now_after_stop_keeps_the_gate_and_the_queue(tmp_path):
    # play now after stop clears the gate and starts the new file at once. When paplay
    # refuses that file in the grace, the gate is restored, the new record is removed and
    # the queued file keeps waiting and starts nothing.
    a, b, c = _files(tmp_path, "a.wav", "b.wav", "c.wav")
    spawn = Spawns()
    player = Player(str(tmp_path), spawn=spawn, clock=Clock())
    try:
        player.play("a.wav")
        player.play("b.wav")  # queued behind a
        stopped = player.stop()
        assert stopped["stopped"] is True
        assert _paths(stopped, "queue") == [b]

        spawn.returncode = 1
        spawn.stderr = b"paplay: Failed to open file: unknown format\n"
        with pytest.raises(ValueError) as refused:
            player.play("c.wav", mode="now")
        assert "c.wav" in str(refused.value)

        state = player.status()
        assert state["stopped"] is True
        assert state["playing"] == []
        assert _paths(state, "queue") == [b]  # the refused request left no record
        assert len(spawn.processes) == 2  # a, and the refused c; b never started
    finally:
        player.close()


def test_the_player_writes_nothing_to_disk(tmp_path):
    _files(tmp_path, "a.wav", "b.wav")
    before = sorted(entry.name for entry in tmp_path.iterdir())
    player = Player(str(tmp_path), spawn=Spawns(), clock=Clock())
    try:
        player.play("a.wav")
        player.play("b.wav")
        player.pause()
        player.resume()
        player.status()
        player.clear()
        player.stop()
    finally:
        player.close()
    assert sorted(entry.name for entry in tmp_path.iterdir()) == before


def _tone(path, seconds=1.5, rate=48000):
    """A 440 Hz mono s16 wav file."""
    frames = bytearray()
    for index in range(int(rate * seconds)):
        sample = 0.5 * 32767 * math.sin(2 * math.pi * 440 * index / rate)
        frames += struct.pack("<h", int(sample))
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(bytes(frames))


def test_paplay_plays_a_real_file_and_the_state_follows_it(pulse_server, tmp_path):
    # The real engine against the isolated daemon: paplay starts, SIGSTOP/SIGCONT pause
    # and resume it, and SIGTERM stops it.
    assert os.environ["PULSE_SERVER"] == pulse_server
    path = tmp_path / "tone.wav"
    _tone(path)
    player = Player(str(tmp_path))
    try:
        state = player.play("tone.wav")
        assert _paths(state, "playing") == [str(path)]
        assert state["playing"][0]["position_s"] >= 0

        first = player.status()["playing"][0]["position_s"]
        time.sleep(0.3)
        later = player.status()["playing"][0]["position_s"]
        assert later > first and later - first >= 0.2

        paused = player.pause()
        assert paused["paused"] is True
        frozen = paused["playing"][0]["position_s"]
        time.sleep(0.3)
        assert player.status()["playing"][0]["position_s"] == pytest.approx(
            frozen, abs=0.05
        )

        player.resume()
        time.sleep(0.3)
        assert player.status()["playing"][0]["position_s"] > frozen + 0.2

        stopped = player.stop()
        assert stopped["playing"] == []
        assert stopped["queue"] == []
    finally:
        player.close()
