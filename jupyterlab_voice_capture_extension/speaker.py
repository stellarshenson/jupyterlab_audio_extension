"""FIFO reader for the speaker path.

PulseAudio ``module-pipe-sink`` creates the speaker FIFO and holds it open read-write; this
server only opens the read end. A daemon thread reads the FIFO continuously whether or not a
tab listens, so the pipe never holds old audio: with no listener the data is discarded, and
a tab that connects later hears live audio only.

The thread hands each chunk to the listener callback, which the ``/speaker`` websocket
handler sets. Every chunk is a whole number of s16le stereo sample frames.
"""

import os
import select
import stat
import threading

# File name of the speaker FIFO, in the directory of c.VoiceCapture.sink_path.
SPEAKER_FIFO_NAME = "speaker.fifo"

# Bytes in one s16le stereo sample frame.
FRAME_BYTES = 4


class SpeakerReader:
    """Reads PCM from the speaker FIFO on a background thread."""

    def __init__(self, path, log):
        self._path = path
        self._log = log
        self._stop = threading.Event()
        self._thread = None
        # Called on the reader thread with each chunk; None while no tab listens.
        self.listener = None

    def start(self):
        """Launch the reader thread."""
        self._thread = threading.Thread(
            target=self._run, name="voice-capture-speaker-reader", daemon=True
        )
        self._thread.start()

    def close(self):
        """Stop the reader thread and release the FIFO."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)

    # -- reader thread ----------------------------------------------------------------

    def _run(self):
        refused = False
        while not self._stop.is_set():
            try:
                fd = os.open(self._path, os.O_RDONLY | os.O_NONBLOCK)
            except FileNotFoundError:
                self._stop.wait(0.2)  # module-pipe-sink has not created the FIFO yet
                continue
            except OSError as exc:
                self._log.warning("voice-capture: cannot open speaker %s: %s", self._path, exc)
                self._stop.wait(0.5)
                continue
            try:
                if stat.S_ISFIFO(os.fstat(fd).st_mode):
                    self._read(fd)
                elif not refused:
                    self._log.error(
                        "voice-capture: speaker %s is not a FIFO; refusing to read it", self._path
                    )
                    refused = True
            except OSError as exc:
                self._log.warning("voice-capture: speaker read failed, reopening: %s", exc)
            finally:
                os.close(fd)
            self._stop.wait(0.2)

    def _read(self, fd):
        """Read until EOF (no writer left) or close(), handing on whole sample frames."""
        poller = select.poll()
        poller.register(fd, select.POLLIN)
        rest = b""
        while not self._stop.is_set():
            try:
                data = os.read(fd, 65536)
            except BlockingIOError:
                poller.poll(200)
                continue
            if not data:
                return
            data = rest + data
            end = len(data) - len(data) % FRAME_BYTES
            rest = data[end:]
            listener = self.listener
            if listener is not None and end:
                listener(data[:end])
