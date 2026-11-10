"""The virtual player: an ordered queue of audio files played through PulseAudio.

One ``paplay`` process per playing file; PulseAudio mixes the concurrent clients. The
state lives in server memory only, and the ``/player`` route drives it.
"""

import os
import signal
import subprocess
import threading
import time

# Client name and buffer latency for every paplay process; the lab's paplay supports both.
CLIENT_NAME = "voice-capture-player"
LATENCY_MS = 200
# A paplay that exits this soon after start is a refusal, not a playback: play() waits on
# the process this long so the caller gets its stderr instead of a failed record.
START_GRACE_S = 0.2
# Seconds between SIGTERM and SIGKILL for a stopped process.
KILL_AFTER_S = 2.0
ACTIVE = ("playing", "paused")


class _Record:
    """One file in the player."""

    def __init__(self, id, path):
        self.id = id
        self.path = path
        self.state = "queued"
        self.process = None
        self.start = None
        self.paused_total = 0.0
        self.pause_start = None
        self.returncode = None
        self.error = ""
        self.thread = None


class Player:
    """Plays audio files through PulseAudio, with a queue, pause and a stop gate."""

    def __init__(self, root_dir, log=None, spawn=None, clock=None):
        self._root = os.path.realpath(root_dir)
        self._log = log
        self._spawn = spawn or subprocess.Popen
        self._clock = clock or time.monotonic
        self._lock = threading.Lock()
        self._records = []
        self._next_id = 1
        self._stopped = False
        self._closed = False

    # -- actions ----------------------------------------------------------------------

    def play(self, path, mode="queue"):
        """Queue a file, or start it at once with mode 'now'; returns the state."""
        if mode not in ("queue", "now"):
            raise ValueError(f"Unknown play mode {mode!r}: use 'queue' or 'now'")
        resolved = self._resolve(path)
        with self._lock:
            if self._closed:
                raise ValueError("The player is closed")
            record = _Record(self._next_id, resolved)
            self._next_id += 1
            self._records.append(record)
            started = None
            if mode == "now":
                started = record
            elif not self._active():
                # The queue head may be an earlier record; a new file behind it waits.
                started = next(r for r in self._records if r.state == "queued")
            was_stopped = self._stopped
            if started is not None:
                try:
                    self._start(started)
                except OSError as exc:
                    self._records.remove(record)
                    raise ValueError(f"Cannot play {started.path}: {exc}")
                # A play clears the gate only once its start succeeds.
                self._stopped = False
        if started is not None:
            rejection = self._await_start(started, was_stopped)
            if rejection:
                with self._lock:
                    if record is not started and record.state == "queued":
                        self._records.remove(record)
                raise ValueError(rejection)
        return self.status()

    def pause(self):
        with self._lock:
            now = self._clock()
            for record in self._records:
                if record.state == "playing":
                    record.state = "paused"
                    record.pause_start = now
                    record.process.send_signal(signal.SIGSTOP)
            return self._state()

    def resume(self):
        with self._lock:
            now = self._clock()
            for record in self._records:
                if record.state == "paused":
                    record.paused_total += now - record.pause_start
                    record.pause_start = None
                    record.state = "playing"
                    record.process.send_signal(signal.SIGCONT)
            self._stopped = False
            self._advance()
            return self._state()

    def stop(self):
        with self._lock:
            self._stopped = True
            for record in self._records:
                if record.state in ACTIVE:
                    self._end(record)
            return self._state()

    def clear(self):
        with self._lock:
            self._records = [r for r in self._records if r.state != "queued"]
            return self._state()

    def status(self):
        with self._lock:
            return self._state()

    def close(self):
        """Stop every process; the extension's load and unload hook calls this."""
        with self._lock:
            self._closed = True
            threads = []
            for record in self._records:
                if record.state in ACTIVE:
                    self._end(record)
                if record.thread is not None:
                    threads.append(record.thread)
        for thread in threads:
            thread.join(timeout=KILL_AFTER_S)

    # -- state ------------------------------------------------------------------------

    def _state(self):
        playing = []
        queue = []
        paused = False
        for record in self._records:
            if record.state in ACTIVE:
                paused = paused or record.state == "paused"
                playing.append(
                    {
                        "id": record.id,
                        "path": record.path,
                        "position_s": self._position(record),
                    }
                )
            elif record.state == "queued":
                queue.append({"id": record.id, "path": record.path})
        return {
            "paused": paused,
            "stopped": self._stopped,
            "playing": playing,
            "queue": queue,
        }

    def _position(self, record):
        end = record.pause_start if record.state == "paused" else self._clock()
        return end - record.start - record.paused_total

    def _active(self):
        return any(record.state in ACTIVE for record in self._records)

    # -- engine -----------------------------------------------------------------------

    def _resolve(self, path):
        """The absolute path, refused unless it is an existing file under the root."""
        if not isinstance(path, str) or not path.strip():
            raise ValueError("A path is required to play a file")
        resolved = os.path.realpath(os.path.join(self._root, path))
        if os.path.commonpath((self._root, resolved)) != self._root:
            raise ValueError(f"Path {path} is outside the Jupyter root")
        if not os.path.isfile(resolved):
            raise ValueError(f"Cannot play {path}: no such file")
        return resolved

    def _start(self, record):
        """Spawn paplay for a record; the caller starts the monitor under the lock."""
        record.process = self._spawn(
            [
                "paplay",
                f"--client-name={CLIENT_NAME}",
                f"--latency-msec={LATENCY_MS}",
                record.path,
            ],
            stderr=subprocess.PIPE,
        )
        record.state = "playing"
        record.start = self._clock()
        record.paused_total = 0.0

    def _watch(self, record):
        record.thread = threading.Thread(
            target=self._monitor,
            args=(record,),
            name="voice-capture-player-monitor",
            daemon=True,
        )
        record.thread.start()

    def _await_start(self, record, was_stopped):
        """Wait briefly on a fresh process; returns a refusal message or None."""
        try:
            returncode = record.process.wait(timeout=START_GRACE_S)
        except subprocess.TimeoutExpired:
            with self._lock:
                self._watch(record)
            return None
        if returncode == 0:
            # A file shorter than the grace played in full; the monitor records the end.
            with self._lock:
                self._watch(record)
            return None
        with self._lock:
            error = _last_stderr_line(record.process) or f"paplay exited with {returncode}"
            # A refused start leaves the gate as the caller found it.
            if not self._stopped:
                self._stopped = was_stopped
            self._records.remove(record)
        return f"Cannot play {record.path}: {error}"

    def _monitor(self, record):
        returncode = record.process.wait()
        with self._lock:
            if record.state not in ACTIVE:
                _close_stderr(record.process)
                return
            record.returncode = returncode
            if returncode == 0:
                record.state = "ended"
            else:
                record.state = "failed"
                record.error = _last_stderr_line(record.process)
                if self._log is not None:
                    self._log.warning(
                        "voice-capture player: %s failed (%s): %s",
                        record.path,
                        returncode,
                        record.error,
                    )
            _close_stderr(record.process)
            self._advance()

    def _end(self, record):
        """End a playing or paused record: SIGCONT a paused process, then SIGTERM."""
        process = record.process
        if record.state == "paused":
            process.send_signal(signal.SIGCONT)
        record.state = "ended"
        process.send_signal(signal.SIGTERM)
        timer = threading.Timer(KILL_AFTER_S, _kill, args=(process,))
        timer.daemon = True
        timer.start()

    def _advance(self):
        """Start the first queued record when nothing plays and the gate is clear."""
        if self._stopped or self._closed or self._active():
            return
        for record in self._records:
            if record.state == "queued":
                self._start(record)
                self._watch(record)
                return


def _kill(process):
    if process.poll() is None:
        process.send_signal(signal.SIGKILL)


def _close_stderr(process):
    stream = getattr(process, "stderr", None)
    if stream is not None:
        try:
            stream.close()
        except OSError:
            pass


def _last_stderr_line(process):
    """The last non-empty line paplay wrote to stderr."""
    stream = getattr(process, "stderr", None)
    if stream is None:
        return ""
    try:
        data = stream.read()
    except (OSError, ValueError):
        return ""
    text = data.decode("utf-8", "replace") if isinstance(data, bytes) else str(data)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return lines[-1] if lines else ""
