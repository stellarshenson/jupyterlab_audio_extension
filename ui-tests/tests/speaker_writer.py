"""Stand-in for PulseAudio's module-pipe-sink in the UI tests.

Creates the speaker FIFO (the writer owns creation, as module-pipe-sink does), holds it open
read-write and writes a 440 Hz tone as s16le 48 kHz stereo at real-time pace. The second
argument is the tone's amplitude as a fraction of full scale. SIGTERM removes the FIFO and
exits.
"""

import math
import os
import signal
import stat
import sys
import time

RATE = 48000
FRAME_BYTES = 4  # s16le stereo
CHUNK_FRAMES = 1024  # 4096 bytes = PIPE_BUF, so each write is all or nothing

path, amplitude = sys.argv[1], float(sys.argv[2])
if os.path.exists(path) and stat.S_ISFIFO(os.stat(path).st_mode):
    os.unlink(path)  # stale FIFO from an interrupted run
os.mkfifo(path)
fd = os.open(path, os.O_RDWR | os.O_NONBLOCK)


def stop(*_):
    os.close(fd)
    os.unlink(path)
    sys.exit(0)


signal.signal(signal.SIGTERM, stop)

# One second holds 440 whole periods, so the looped second has no step at the seam.
level = round(amplitude * 32767)
tone = b"".join(
    int(level * math.sin(2 * math.pi * 440 * i / RATE)).to_bytes(2, "little", signed=True) * 2
    for i in range(RATE)
)

start = time.monotonic()
sent = 0  # frames
while True:
    due = int((time.monotonic() - start) * RATE)
    while sent < due:
        offset = sent % RATE
        n = min(due - sent, RATE - offset, CHUNK_FRAMES)
        try:
            os.write(fd, tone[offset * FRAME_BYTES : (offset + n) * FRAME_BYTES])
        except BlockingIOError:
            pass  # pipe full (nothing reads it): drop the chunk and keep real-time pace
        sent += n
    time.sleep(0.01)
