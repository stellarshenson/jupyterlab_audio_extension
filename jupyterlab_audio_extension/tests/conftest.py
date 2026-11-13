"""Fixtures shared by the server tests."""

import os
import shutil
import subprocess
import tempfile
import time

import pytest


@pytest.fixture(scope="session")
def _pulse_daemon():
    """One isolated PulseAudio server for the tests that start paplay.

    PULSE_SERVER from the environment wins: the runner started that daemon and owns its
    cleanup. Otherwise start one under a fresh /tmp directory and stop it after the session.
    The variable is set per test by pulse_server, never for the whole session: the pulse
    integration tests need the lab's own daemon to test the FIFO chain. A daemon that will
    not start fails the test that asked for this fixture; nothing is skipped silently.
    """
    existing = os.environ.get("PULSE_SERVER")
    if existing:
        yield existing
        return

    if shutil.which("pulseaudio") is None or shutil.which("pactl") is None:
        pytest.fail(
            "PulseAudio is not installed and PULSE_SERVER names no isolated daemon"
        )
    runtime = tempfile.mkdtemp(prefix="vcpl.", dir="/tmp")
    env = dict(os.environ, PULSE_RUNTIME_PATH=runtime, PULSE_STATE_PATH=runtime)
    started = subprocess.run(
        [
            "pulseaudio",
            "-n",
            "--daemonize=yes",
            "--exit-idle-time=-1",
            "--load=module-native-protocol-unix",
            # A bare -n daemon has no sink, so paplay would refuse every file.
            "--load=module-null-sink",
        ],
        env=env,
        capture_output=True,
        text=True,
    )
    if started.returncode != 0:
        pytest.fail(f"the isolated PulseAudio daemon did not start: {started.stderr}")

    server = f"unix:{runtime}/native"
    os.environ["PULSE_SERVER"] = server
    try:
        for _ in range(100):
            answer = subprocess.run(
                ["pactl", "info"], env=dict(os.environ), capture_output=True
            )
            if answer.returncode == 0:
                break
            time.sleep(0.05)
        else:
            pytest.fail("the isolated PulseAudio daemon did not answer pactl info")
        os.environ.pop("PULSE_SERVER", None)
        yield server
    finally:
        os.environ.pop("PULSE_SERVER", None)
        subprocess.run(["pulseaudio", "--kill"], env=env, capture_output=True)
        if shutil.which("trash-put"):
            subprocess.run(
                ["trash-put", "--trash-dir", "/tmp/.Trash-1000", runtime],
                capture_output=True,
            )
        else:  # a CI runner has no trash-cli; the directory is this fixture's own
            shutil.rmtree(runtime, ignore_errors=True)


@pytest.fixture
def pulse_server(_pulse_daemon, monkeypatch):
    """Point this test's PulseAudio clients at the isolated daemon."""
    monkeypatch.setenv("PULSE_SERVER", _pulse_daemon)
    yield _pulse_daemon
