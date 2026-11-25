import ast
import http.server
import json
import os
import pathlib
import socket
import sys
import threading
import time

import pytest

import jupyterlab_audio_extension.cli as cli
from jupyterlab_audio_extension import _sink_path
from jupyterlab_audio_extension.speaker import STOP_MARKER_NAME


def test_install_dry_run_uses_apt_never_conda(capsys, monkeypatch):
    monkeypatch.setattr(cli, "_COLOR", False)
    # even when conda is present, install must never use it: conda-forge sox lacks the
    # pulseaudio driver, so the recorder always comes from the Debian sox + libsox-fmt-pulse
    monkeypatch.setattr(cli.shutil, "which", lambda name: "/usr/bin/" + name)
    rc = cli.main(["install", "--dry-run", "--sink-path", "/run/voice/pulseaudio.fifo"])
    out = capsys.readouterr().out

    assert rc == 0
    assert "DRY RUN" in out
    assert "conda" not in out.lower()
    assert "apt-get update" in out
    assert "apt-get install" in out and "libsox-fmt-pulse" in out
    assert "/run/voice/pulseaudio.fifo" in out
    # install must NOT start the daemon or load the source - it advises `start` instead
    assert "module-pipe-source" not in out
    assert "set-default-source" not in out
    assert "start" in out


def test_install_dry_run_lists_all_apt_packages(capsys, monkeypatch):
    monkeypatch.setattr(cli, "_COLOR", False)
    monkeypatch.setattr(cli.shutil, "which", lambda name: None)
    rc = cli.main(["install", "--dry-run"])
    out = capsys.readouterr().out

    assert rc == 0
    for pkg in ("pulseaudio", "pulseaudio-utils", "sox", "libsox-fmt-pulse"):
        assert pkg in out


@pytest.mark.parametrize(
    "failing, rc",
    [(None, 0), ("apt-get update", 1), ("apt-get install", 1), ("install -d", 1), ("sh -c", 1)],
)
def test_install_with_apt_get_exits_1_only_when_a_command_it_runs_fails(tmp_path, monkeypatch, failing, rc):
    monkeypatch.setattr(
        cli, "_run", lambda cmd, **kw: 100 if failing and " ".join(cmd).startswith(failing) else 0
    )
    monkeypatch.setattr(cli.shutil, "which", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(cli, "_jupyter_server_config", lambda: str(tmp_path / "jupyter_server_config.py"))
    sink = str(tmp_path / "voice" / "pulseaudio.fifo")  # a missing directory, so install -d runs

    assert cli.main(["install", "--sink-path", sink]) == rc


def test_install_prints_done_only_when_no_step_failed(tmp_path, capsys, monkeypatch):
    # DEF-CLI-14: after a failed step install says it failed instead of 'Done.' and the next steps.
    monkeypatch.setattr(cli, "_COLOR", False)
    monkeypatch.setattr(cli.shutil, "which", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(cli, "_jupyter_server_config", lambda: str(tmp_path / "jupyter_server_config.py"))
    sink = str(tmp_path / "pulseaudio.fifo")
    failed = "install failed - fix the errors above and run install again"

    monkeypatch.setattr(cli, "_run", lambda cmd, **kw: 100 if cmd[:2] == ["apt-get", "update"] else 0)
    assert cli.main(["install", "--sink-path", sink]) == 1
    out = capsys.readouterr().out
    assert failed in out and "Done." not in out and "start -d" not in out

    monkeypatch.setattr(cli, "_run", lambda cmd, **kw: 0)
    assert cli.main(["install", "--sink-path", sink]) == 0
    out = capsys.readouterr().out
    assert failed not in out and "Done." in out


@pytest.mark.parametrize("present, rc", [(True, 0), (False, 1)])
def test_install_without_apt_get_fails_only_when_a_package_is_missing(
    tmp_path, capsys, monkeypatch, present, rc
):
    # DEF-CLI-15: with no apt-get, install cannot add a missing package, so install fails.
    monkeypatch.setattr(cli, "_COLOR", False)
    monkeypatch.setattr(cli, "_run", lambda cmd, **kw: 0)
    monkeypatch.setattr(
        cli.shutil, "which", lambda name: None if name == "apt-get" else "/usr/bin/" + name
    )
    monkeypatch.setattr(cli, "_sox_has_pulse", lambda: present)
    monkeypatch.setattr(cli, "_jupyter_server_config", lambda: str(tmp_path / "jupyter_server_config.py"))

    assert cli.main(["install", "--sink-path", str(tmp_path / "pulseaudio.fifo")]) == rc
    assert ("Done." in capsys.readouterr().out) == present


def test_a_saved_voice_capture_sink_path_is_used_when_the_new_key_is_absent():
    # The 1.1.8 config wrote c.VoiceCapture.sink_path; the renamed extension must honour it.
    from traitlets.config import Config

    assert _sink_path(Config({"VoiceCapture": {"sink_path": "/old.fifo"}})) == "/old.fifo"


def test_the_audio_capture_sink_path_wins_over_the_saved_voice_capture_one():
    from traitlets.config import Config

    config = Config(
        {
            "VoiceCapture": {"sink_path": "/old.fifo"},
            "AudioCapture": {"sink_path": "/new.fifo"},
        }
    )
    assert _sink_path(config) == "/new.fifo"


def test_a_config_with_only_the_saved_voice_capture_line_is_left_untouched(tmp_path, capsys):
    cfg = tmp_path / "jupyter_server_config.py"
    cfg.write_text('c.VoiceCapture.sink_path = "/custom/voice.fifo"\n')

    cli._write_sink_config(str(cfg), "/run/voice/pulseaudio.fifo", dry=False)

    assert cfg.read_text() == 'c.VoiceCapture.sink_path = "/custom/voice.fifo"\n'
    assert "sink_path already set" in capsys.readouterr().out


def test_validate_reports_missing_and_prints_config(capsys, monkeypatch):
    monkeypatch.setattr(cli, "_COLOR", False)
    monkeypatch.setattr(cli.shutil, "which", lambda name: None)
    monkeypatch.setattr(cli, "_pactl", lambda *a: (1, ""))
    monkeypatch.setattr(cli, "_sox_has_pulse", lambda: False)
    monkeypatch.setattr(cli.os.path, "isdir", lambda p: False)
    monkeypatch.setattr(cli, "_is_fifo", lambda p: False)
    monkeypatch.setattr(cli, "_client_conf_has_default_server", lambda: False)
    monkeypatch.delenv("AUDIODRIVER", raising=False)

    rc = cli.main(["validate"])
    out = capsys.readouterr().out

    assert rc == 1  # something missing
    assert "[MISS]" in out
    assert 'c.AudioCapture.sink_path = "/run/voice/pulseaudio.fifo"' in out
    assert "AUDIODRIVER=pulseaudio" in out


def test_validate_passes_when_everything_present(capsys, monkeypatch):
    monkeypatch.setattr(cli, "_COLOR", False)
    monkeypatch.setattr(cli.shutil, "which", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(cli, "_sox_has_pulse", lambda: True)
    monkeypatch.setattr(cli.os.path, "isdir", lambda p: True)
    monkeypatch.setattr(cli, "_is_fifo", lambda p: True)
    monkeypatch.setattr(cli, "_client_conf_has_default_server", lambda: True)
    monkeypatch.setenv("AUDIODRIVER", "pulseaudio")

    def fake_pactl(*args):
        if args and args[0] == "info":
            return 0, (
                f"Server String: x\nDefault Source: {cli.SOURCE_NAME}\n"
                f"Default Sink: {cli.SPEAKER_SINK_NAME}\n"
            )
        return 0, (
            f"1\t{cli.SOURCE_NAME}\tmodule-pipe-source.c\ts16le 1ch 16000Hz\n"
            f"2\t{cli.SPEAKER_SINK_NAME}\tmodule-pipe-sink.c\ts16le 2ch 48000Hz\n"
        )

    monkeypatch.setattr(cli, "_pactl", fake_pactl)

    rc = cli.main(["validate"])
    out = capsys.readouterr().out

    assert rc == 0
    assert "[MISS]" not in out
    assert "All components in place." in out


def test_validate_json_is_machine_readable(capsys, monkeypatch):
    monkeypatch.setattr(cli.shutil, "which", lambda name: None)
    monkeypatch.setattr(cli, "_pactl", lambda *a: (1, ""))
    monkeypatch.setattr(cli, "_sox_has_pulse", lambda: False)
    monkeypatch.setattr(cli.os.path, "isdir", lambda p: False)
    monkeypatch.setattr(cli, "_is_fifo", lambda p: False)
    monkeypatch.setattr(cli, "_client_conf_has_default_server", lambda: False)
    monkeypatch.delenv("AUDIODRIVER", raising=False)

    rc = cli.main(["validate", "--json"])
    out = capsys.readouterr().out

    data = json.loads(out)  # must parse cleanly - no colour codes, no surrounding prose
    assert rc == 1
    assert data["ok"] is False
    assert data["sink_path"] == "/run/voice/pulseaudio.fifo"
    assert any(
        c["name"] == "sox pulseaudio driver" and c["ok"] is False for c in data["checks"]
    )
    assert data["missing"]  # at least one missing entry
    assert "\x1b[" not in out  # no ANSI escape sequences in JSON output


def test_validate_json_all_present_exits_zero(capsys, monkeypatch):
    monkeypatch.setattr(cli.shutil, "which", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(cli, "_sox_has_pulse", lambda: True)
    monkeypatch.setattr(cli.os.path, "isdir", lambda p: True)
    monkeypatch.setattr(cli, "_is_fifo", lambda p: True)
    monkeypatch.setattr(cli, "_client_conf_has_default_server", lambda: True)
    monkeypatch.setenv("AUDIODRIVER", "pulseaudio")

    def fake_pactl(*args):
        if args and args[0] == "info":
            return 0, (
                f"Default Source: {cli.SOURCE_NAME}\nDefault Sink: {cli.SPEAKER_SINK_NAME}\n"
            )
        return 0, (
            f"1\t{cli.SOURCE_NAME}\tmodule-pipe-source.c\ts16le 1ch 16000Hz\n"
            f"2\t{cli.SPEAKER_SINK_NAME}\tmodule-pipe-sink.c\ts16le 2ch 48000Hz\n"
        )

    monkeypatch.setattr(cli, "_pactl", fake_pactl)

    rc = cli.main(["validate", "--json"])
    data = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert data["ok"] is True
    assert data["missing"] == []


def _record_runs(monkeypatch):
    """Record the commands start would run, without running any of them or querying a
    daemon."""
    runs = []
    monkeypatch.setattr(cli, "_run", lambda cmd, **kw: runs.append(cmd) or 0)
    monkeypatch.setattr(cli, "_pactl", lambda *a: (1, ""))
    return runs


def test_start_removes_a_leftover_fifo_before_loading_the_source(tmp_path, monkeypatch):
    # DEF-CLI-6: module-pipe-source refuses an existing path, so a FIFO left by a killed
    # daemon is removed before the source is loaded.
    sink = str(tmp_path / "pulseaudio.fifo")
    os.mkfifo(sink)
    runs = _record_runs(monkeypatch)
    monkeypatch.setattr(cli, "_daemon_running", lambda: True)
    monkeypatch.setattr(cli, "_source_loaded", lambda: False)

    cli._start_pulse_and_source(sink, dry=False)

    load = next(i for i, cmd in enumerate(runs) if "load-module" in cmd)
    assert ["rm", "-f", sink] in runs[:load]


def test_start_exits_1_when_the_source_did_not_load(tmp_path, capsys, monkeypatch):
    # DEF-CLI-6: a daemon without voicein is a failed start, not exit 0.
    _record_runs(monkeypatch)
    monkeypatch.setattr(cli, "_daemon_running", lambda: True)
    monkeypatch.setattr(cli, "_source_loaded", lambda: False)

    rc = cli.main(["start", "-d", "--sink-path", str(tmp_path / "pulseaudio.fifo")])

    assert rc == 1
    assert "validate" in capsys.readouterr().out



def test_start_keeps_voicein_reading_through_a_drain(tmp_path, monkeypatch):
    # DEF-BRIDGE-7: a loopback from voicein into the voicedrain null sink keeps the
    # pipe-source reading, so no old audio waits in the FIFO for /voice.
    runs = _record_runs(monkeypatch)
    monkeypatch.setattr(cli, "_daemon_running", lambda: True)
    monkeypatch.setattr(cli, "_source_loaded", lambda: False)

    cli._start_pulse_and_source(str(tmp_path / "pulseaudio.fifo"), dry=False)

    loads = [cmd for cmd in runs if "load-module" in cmd]
    assert [cmd[2] for cmd in loads[:3]] == ["module-pipe-source", "module-null-sink", "module-loopback"]
    assert "sink_name=voicedrain" in loads[1]
    assert f"source={cli.SOURCE_NAME}" in loads[2] and "sink=voicedrain" in loads[2]
    assert cli.SOURCE_NAME not in "voicedrain"  # _source_loaded matches by substring


SPEAKER_LOAD = [
    "pactl",
    "load-module",
    "module-pipe-sink",
    "sink_name=voiceout",
    "file={}",
    "format=s16le",
    "rate=48000",
    "channels=2",
    "use_system_clock_for_timing=yes",
]


def _speaker_load(sink_dir):
    return [arg.format(os.path.join(sink_dir, "speaker.fifo")) for arg in SPEAKER_LOAD]


def test_start_loads_voiceout_as_the_default_sink_then_suspend_on_idle(tmp_path, monkeypatch):
    runs = _record_runs(monkeypatch)
    monkeypatch.setattr(cli, "_daemon_running", lambda: True)
    monkeypatch.setattr(cli, "_source_loaded", lambda: False)

    cli._start_pulse_and_source(str(tmp_path / "pulseaudio.fifo"), dry=False)

    load = runs.index(_speaker_load(str(tmp_path)))
    default = runs.index(["pactl", "set-default-sink", "voiceout"])
    suspend = runs.index(["pactl", "load-module", "module-suspend-on-idle"])
    assert load < default < suspend


def test_start_keeps_a_loaded_suspend_on_idle(tmp_path, monkeypatch):
    runs = _record_runs(monkeypatch)
    monkeypatch.setattr(cli, "_daemon_running", lambda: True)
    monkeypatch.setattr(cli, "_source_loaded", lambda: True)
    monkeypatch.setattr(cli, "_pactl", lambda *a: (0, "7\tmodule-suspend-on-idle\t\t\n"))

    cli._start_pulse_and_source(str(tmp_path / "pulseaudio.fifo"), dry=False)

    assert ["pactl", "load-module", "module-suspend-on-idle"] not in runs


def test_start_removes_a_leftover_speaker_fifo_before_loading_voiceout(tmp_path, monkeypatch):
    speaker = str(tmp_path / "speaker.fifo")
    os.mkfifo(speaker)
    runs = _record_runs(monkeypatch)
    monkeypatch.setattr(cli, "_daemon_running", lambda: True)
    monkeypatch.setattr(cli, "_source_loaded", lambda: True)

    cli._start_pulse_and_source(str(tmp_path / "pulseaudio.fifo"), dry=False)

    assert ["rm", "-f", speaker] in runs[: runs.index(_speaker_load(str(tmp_path)))]


def test_start_loads_voiceout_on_a_running_daemon_that_lacks_it(tmp_path, monkeypatch):
    # A daemon started by an older start has voicein but no voiceout.
    runs = _record_runs(monkeypatch)
    monkeypatch.setattr(cli, "_daemon_running", lambda: True)
    monkeypatch.setattr(cli, "_source_loaded", lambda: True)

    cli._start_pulse_and_source(str(tmp_path / "pulseaudio.fifo"), dry=False)

    assert _speaker_load(str(tmp_path)) in runs
    assert not any("module-pipe-source" in cmd for cmd in runs)


def test_start_exits_1_when_voiceout_did_not_load(tmp_path, capsys, monkeypatch):
    _record_runs(monkeypatch)
    monkeypatch.setattr(cli, "_daemon_running", lambda: True)
    monkeypatch.setattr(cli, "_source_loaded", lambda: True)
    monkeypatch.setattr(cli, "_sink_loaded", lambda: False)

    rc = cli.main(["start", "-d", "--sink-path", str(tmp_path / "pulseaudio.fifo")])

    assert rc == 1
    assert "voiceout" in capsys.readouterr().out


def test_stop_records_the_stop_marker_beside_the_sink(tmp_path, capsys, monkeypatch):
    # ACC-PLAYER-80: a deliberate shutdown is recorded so the player reports the sink off.
    sink = str(tmp_path / "pulseaudio.fifo")
    monkeypatch.setattr(cli, "_daemon_running", lambda: True)
    monkeypatch.setattr(cli, "_stop_daemon", lambda: 0)

    assert cli.main(["stop", "--sink-path", sink]) == 0

    assert (tmp_path / STOP_MARKER_NAME).is_file()
    assert "shut down" in capsys.readouterr().out


def test_stop_records_the_stop_marker_when_the_daemon_is_already_down(
    tmp_path, capsys, monkeypatch
):
    # A daemon already down plus a stale FIFO must not read ready after a deliberate stop.
    sink = str(tmp_path / "pulseaudio.fifo")
    monkeypatch.setattr(cli, "_daemon_running", lambda: False)

    assert cli.main(["stop", "--sink-path", sink]) == 0

    assert (tmp_path / STOP_MARKER_NAME).is_file()
    assert "shut down" in capsys.readouterr().out


def test_stop_writes_no_marker_when_the_kill_fails(tmp_path, capsys, monkeypatch):
    # A failed kill must not claim the audio is shut down.
    sink = str(tmp_path / "pulseaudio.fifo")
    monkeypatch.setattr(cli, "_daemon_running", lambda: True)
    monkeypatch.setattr(cli, "_stop_daemon", lambda: 1)

    assert cli.main(["stop", "--sink-path", sink]) == 1

    assert not (tmp_path / STOP_MARKER_NAME).exists()
    assert "shut down" not in capsys.readouterr().out


def test_interrupted_start_records_the_stop_marker(tmp_path, capsys, monkeypatch):
    # Ctrl-C stops the daemon and records the deliberate shutdown.
    sink = str(tmp_path / "pulseaudio.fifo")
    monkeypatch.setattr(cli, "_start_pulse_and_source", lambda sink, dry: None)
    monkeypatch.setattr(cli, "_daemon_running", lambda: True)
    monkeypatch.setattr(cli, "_source_loaded", lambda: True)
    monkeypatch.setattr(cli, "_sink_loaded", lambda: True)
    monkeypatch.setattr(cli, "_stop_daemon", lambda: 0)

    def interrupted(_seconds):
        raise KeyboardInterrupt

    monkeypatch.setattr(time, "sleep", interrupted)

    assert cli.main(["start", "--sink-path", sink]) == 0

    assert (tmp_path / STOP_MARKER_NAME).is_file()
    assert "shut down" in capsys.readouterr().out


def test_start_clears_the_stop_marker_only_after_every_component_loaded(tmp_path, monkeypatch):
    # ACC-PLAYER-80: a failed start leaves the marker, so the sink still reads off.
    sink = str(tmp_path / "pulseaudio.fifo")
    marker = tmp_path / STOP_MARKER_NAME
    monkeypatch.setattr(cli, "_start_pulse_and_source", lambda sink, dry: None)
    monkeypatch.setattr(cli, "_daemon_running", lambda: True)
    monkeypatch.setattr(cli, "_source_loaded", lambda: True)
    monkeypatch.setattr(cli, "_sink_loaded", lambda: True)

    marker.write_text("")
    assert cli.main(["start", "-d", "--sink-path", sink]) == 0
    assert not marker.exists()

    marker.write_text("")
    monkeypatch.setattr(cli, "_sink_loaded", lambda: False)
    assert cli.main(["start", "-d", "--sink-path", sink]) == 1
    assert marker.exists()


def test_validate_reports_the_speaker_rows(capsys, monkeypatch):
    monkeypatch.setattr(cli, "_COLOR", False)
    monkeypatch.setattr(cli.shutil, "which", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(cli, "_sox_has_pulse", lambda: True)
    monkeypatch.setattr(cli.os.path, "isdir", lambda p: True)
    monkeypatch.setattr(cli, "_is_fifo", lambda p: p != "/run/voice/speaker.fifo")
    monkeypatch.setattr(cli, "_client_conf_has_default_server", lambda: True)
    monkeypatch.setenv("AUDIODRIVER", "pulseaudio")

    def fake_pactl(*args):
        if args and args[0] == "info":
            return 0, "Default Source: voicein\nDefault Sink: voiceout\n"
        return 0, "1\tvoicein\tmodule-pipe-source.c\n2\tvoiceout\tmodule-pipe-sink.c\n"

    monkeypatch.setattr(cli, "_pactl", fake_pactl)
    rows = ["speaker FIFO /run/voice/speaker.fifo", "sink 'voiceout' connected",
            "default sink is 'voiceout'"]

    # The sink is loaded and default, but its FIFO is missing: all three rows fail.
    rc = cli.main(["validate"])
    out = capsys.readouterr().out
    assert rc == 1
    for row in rows:
        assert f"[MISS]  {row}" in out

    rc = cli.main(["validate", "--json"])
    data = json.loads(capsys.readouterr().out)
    assert rc == 1
    assert [c["name"] for c in data["missing"]] == rows

    monkeypatch.setattr(cli, "_is_fifo", lambda p: True)
    rc = cli.main(["validate", "--json"])
    data = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert {c["name"]: c["ok"] for c in data["checks"] if c["name"] in rows} == dict.fromkeys(
        rows, True
    )


def test_start_moves_the_voicein_loopback_back_to_voicedrain(tmp_path, monkeypatch):
    # A new default sink takes the loopback off voicedrain; on voiceout it would play the
    # microphone in the tab and keep voiceout from going idle.
    runs = _record_runs(monkeypatch)
    monkeypatch.setattr(cli, "_daemon_running", lambda: True)
    monkeypatch.setattr(cli, "_source_loaded", lambda: True)
    inputs = "3\t1\t-\tmodule-loopback.c\ts16le 1ch 16000Hz\n"
    monkeypatch.setattr(cli, "_pactl", lambda *a: (0, inputs))

    cli._start_pulse_and_source(str(tmp_path / "pulseaudio.fifo"), dry=False)

    move = runs.index(["pactl", "move-sink-input", "3", "voicedrain"])
    assert move > runs.index(["pactl", "set-default-sink", "voiceout"])


def _help(capsys, *argv):
    with pytest.raises(SystemExit) as exited:
        cli.main([*argv, "--help"])
    assert exited.value.code == 0
    return capsys.readouterr().out


def test_help_lists_the_exit_codes(capsys):
    out = _help(capsys)
    assert "exit codes:" in out
    for code in ("0  success", "1  validate found", "2  unknown command"):
        assert f"\n  {code}" in out
    flat = " ".join(out.split())
    assert (
        "a command that install runs failed, or install found a required package missing and no "
        "apt-get on PATH" in flat
    )
    # ACC-PLAYER-103: the player path adds refused, unreachable and usage exits.
    assert "a player request was refused or the server was unreachable" in flat
    assert "unknown command or flag (usage)" in flat
    assert "stop kills the PulseAudio daemon" in flat
    assert "player stop ends playback" in flat


def test_help_names_the_environment_variables_it_reads(capsys):
    out = _help(capsys).split("\nenvironment:\n", 1)[1]
    for name in ("NO_COLOR", "TERM", "AUDIODRIVER"):
        assert name in out


@pytest.mark.parametrize(
    "command, says",
    [
        ("install", ["Does not start the daemon"]),
        ("validate", ["Exits 1 when a component is missing"]),
        ("start", ["the microphone source voicein", "the speaker sink voiceout"]),
        ("stop", ["Kill the PulseAudio daemon", "cannot be undone without start"]),
        (
            "player",
            ["play, pause, resume, stop, clear and status", "player stop ends playback"],
        ),
    ],
)
def test_command_help_says_what_it_does_and_shows_examples(capsys, command, says):
    out = _help(capsys, command)
    flat = " ".join(out.split())  # the descriptions break their lines by hand
    for phrase in says:
        assert phrase in flat
    assert f"examples:\n  jupyterlab_audio {command}" in out


# ------------------------------------------------------------------- player CLI (HTTP)

_JUPYTER_VARS = (
    "JUPYTER_SERVER_URL",
    "JUPYTER_SERVER_ROOT",
    "JUPYTERHUB_SERVICE_PREFIX",
    "JUPYTER_PORT",
    "JUPYTERHUB_API_TOKEN",
    "JPY_API_TOKEN",
    "JUPYTER_TOKEN",
)

_STATE = {
    "paused": False,
    "stopped": False,
    "playing": [{"id": 1, "path": "/work/a.wav", "position_s": 1.5}],
    "queue": [{"id": 2, "path": "/work/b.wav"}],
    "sink": {"state": "ready"},
    "capture": "/run/voice/pulseaudio.fifo",
}


@pytest.fixture(autouse=True)
def _clear_jupyter_environment(monkeypatch):
    """No test may inherit the workstation's lab address or token."""
    for name in _JUPYTER_VARS:
        monkeypatch.delenv(name, raising=False)


def _record(port, base_url="/", root_dir="/work", token="record-token", secure=False):
    return {
        "port": port,
        "base_url": base_url,
        "root_dir": root_dir,
        "token": token,
        "secure": secure,
    }


def _fake_jupyter(tmp_path, monkeypatch, records=(), exit_code=0):
    """Put a fake `jupyter` first on PATH, so discovery never reaches the live lab."""
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    script = bindir / "jupyter"
    lines = "\n".join(json.dumps(record) for record in records)
    script.write_text(
        "#!/bin/sh\ncat <<'EOF'\n" + lines + ("\n" if lines else "") + "EOF\nexit "
        + str(exit_code) + "\n"
    )
    script.chmod(0o755)
    monkeypatch.setenv("PATH", str(bindir) + os.pathsep + os.environ.get("PATH", ""))
    return bindir


def _capture(monkeypatch, payload=None):
    """Record the request the CLI builds instead of sending it; return the recorded list."""
    seen = []
    text = json.dumps(_STATE if payload is None else payload)

    def fake_open(request):
        seen.append(request)
        return text

    monkeypatch.setattr(cli, "_open", fake_open)
    return seen


def _env_url_and_token(monkeypatch, base="http://127.0.0.1:8888"):
    monkeypatch.setenv("JUPYTER_SERVER_URL", base)
    monkeypatch.setenv("JUPYTER_TOKEN", "env-token")


@pytest.mark.parametrize(
    "argv, body",
    [
        (["player", "play", "a.wav"], {"action": "play", "path": "a.wav", "mode": "queue"}),
        (["player", "play", "a.wav", "--now"], {"action": "play", "path": "a.wav", "mode": "now"}),
        (["player", "pause"], {"action": "pause"}),
        (["player", "resume"], {"action": "resume"}),
        (["player", "stop"], {"action": "stop"}),
        (["player", "clear"], {"action": "clear"}),
        (["player", "status"], {"action": "status"}),
    ],
)
def test_player_each_action_posts_its_url_header_and_body(monkeypatch, argv, body):
    _env_url_and_token(monkeypatch)
    seen = _capture(monkeypatch)

    assert cli.main(argv) == 0

    request = seen[-1]
    assert request.get_method() == "POST"
    assert request.full_url == "http://127.0.0.1:8888/jupyterlab-audio-extension/player"
    assert request.get_header("Authorization") == "token env-token"
    assert json.loads(request.data) == body


@pytest.mark.parametrize(
    "base, path",
    [
        ("http://127.0.0.1:8888/user/alice/", "/user/alice/jupyterlab-audio-extension/player"),
        ("http://127.0.0.1:8888", "/jupyterlab-audio-extension/player"),
        ("http://127.0.0.1:8888/", "/jupyterlab-audio-extension/player"),
    ],
)
def test_player_url_keeps_the_hub_prefix_and_uses_one_slash(monkeypatch, base, path):
    _env_url_and_token(monkeypatch, base)
    seen = _capture(monkeypatch)

    assert cli.main(["player", "status"]) == 0

    after_authority = seen[-1].full_url.split("://", 1)[1]
    assert after_authority == "127.0.0.1:8888" + path
    assert "//" not in after_authority


def test_player_discovery_prefers_jupyter_server_url(tmp_path, monkeypatch):
    # The decoy record is a different port and token, and the fake jupyter fails: a CLI
    # that consults it instead of the environment URL fails this test.
    _env_url_and_token(monkeypatch, "http://127.0.0.1:7777/user/alice/")
    _fake_jupyter(
        tmp_path, monkeypatch, [_record(9999, "/decoy/", token="decoy-token")], exit_code=1
    )
    seen = _capture(monkeypatch)

    assert cli.main(["player", "status"]) == 0

    assert (
        seen[-1].full_url
        == "http://127.0.0.1:7777/user/alice/jupyterlab-audio-extension/player"
    )
    assert seen[-1].get_header("Authorization") == "token env-token"


def test_player_discovers_the_single_server_matching_the_root(tmp_path, monkeypatch):
    # A dead decoy record comes first; only the record whose root_dir matches is the lab.
    monkeypatch.setenv("JUPYTER_SERVER_ROOT", "/work")
    _fake_jupyter(
        tmp_path,
        monkeypatch,
        [
            _record(9, "/dead/", root_dir="/somewhere-else", token=""),
            _record(8899, "/user/bob/", root_dir="/work", token="record-token"),
        ],
    )
    seen = _capture(monkeypatch)

    assert cli.main(["player", "status"]) == 0

    assert (
        seen[-1].full_url
        == "http://127.0.0.1:8899/user/bob/jupyterlab-audio-extension/player"
    )
    assert seen[-1].get_header("Authorization") == "token record-token"


@pytest.mark.parametrize("secure, scheme", [(False, "http"), (True, "https")])
def test_player_record_base_honours_secure(tmp_path, monkeypatch, secure, scheme):
    _fake_jupyter(tmp_path, monkeypatch, [_record(8899, "/user/bob/", secure=secure)])
    seen = _capture(monkeypatch)

    assert cli.main(["player", "status"]) == 0

    assert (
        seen[-1].full_url
        == f"{scheme}://127.0.0.1:8899/user/bob/jupyterlab-audio-extension/player"
    )


def test_player_refuses_several_servers(tmp_path, capsys, monkeypatch):
    _fake_jupyter(
        tmp_path,
        monkeypatch,
        [
            _record(9999, "/decoy/", token=""),
            _record(8899, "/user/bob/", token="other-token"),
        ],
    )
    seen = _capture(monkeypatch)

    assert cli.main(["player", "status"]) == 1

    out, err = capsys.readouterr()
    assert seen == []  # no HTTP request after a discovery refusal
    assert out == ""
    assert "9999/decoy/" in err and "8899/user/bob/" in err
    assert "(no token)" in err


def test_player_refuses_when_no_record_matches_the_root(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("JUPYTER_SERVER_ROOT", "/work")
    _fake_jupyter(
        tmp_path, monkeypatch, [_record(9999, "/decoy/", root_dir="/elsewhere")]
    )
    seen = _capture(monkeypatch)

    assert cli.main(["player", "status"]) == 1

    out, err = capsys.readouterr()
    assert seen == []
    assert out == ""
    assert "9999/decoy/" in err


def test_player_no_server_found_exits_1(tmp_path, capsys, monkeypatch):
    _fake_jupyter(tmp_path, monkeypatch, [])
    seen = _capture(monkeypatch)

    assert cli.main(["player", "status"]) == 1

    out, err = capsys.readouterr()
    assert seen == []
    assert out == ""
    assert "Running: none" in err


def test_player_server_list_failure_exits_1(tmp_path, capsys, monkeypatch):
    _fake_jupyter(tmp_path, monkeypatch, [], exit_code=3)
    seen = _capture(monkeypatch)

    assert cli.main(["player", "status"]) == 1

    out, err = capsys.readouterr()
    assert seen == []
    assert out == ""
    assert "jupyter server list" in err


def test_player_missing_jupyter_command_exits_1(tmp_path, capsys, monkeypatch):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    monkeypatch.setenv("PATH", str(bindir))
    _capture(monkeypatch)

    assert cli.main(["player", "status"]) == 1

    out, err = capsys.readouterr()
    assert out == ""
    assert "jupyter server list" in err


def test_player_server_list_timeout_exits_1(capsys, monkeypatch):
    def timing_out(*args, **kwargs):
        raise cli.subprocess.TimeoutExpired(cmd=args[0], timeout=5)

    monkeypatch.setattr(cli.subprocess, "run", timing_out)
    _capture(monkeypatch)

    assert cli.main(["player", "status"]) == 1

    out, err = capsys.readouterr()
    assert out == ""
    assert "jupyter server list" in err


@pytest.mark.parametrize(
    "environment, expected",
    [
        (
            {
                "JUPYTERHUB_API_TOKEN": "hub-token",
                "JPY_API_TOKEN": "jpy-token",
                "JUPYTER_TOKEN": "jwt-token",
            },
            "hub-token",
        ),
        ({"JPY_API_TOKEN": "jpy-token", "JUPYTER_TOKEN": "jwt-token"}, "jpy-token"),
        ({"JUPYTER_TOKEN": "jwt-token"}, "jwt-token"),
        ({}, "record-token"),
    ],
)
def test_player_token_precedence(tmp_path, capsys, monkeypatch, environment, expected):
    monkeypatch.setenv("JUPYTER_SERVER_URL", "http://127.0.0.1:8899")
    monkeypatch.setenv("JUPYTER_SERVER_ROOT", "/work")
    for name, value in environment.items():
        monkeypatch.setenv(name, value)
    _fake_jupyter(
        tmp_path, monkeypatch, [_record(8899, "/", root_dir="/work", token="record-token")]
    )
    seen = _capture(monkeypatch)

    assert cli.main(["player", "status"]) == 0

    assert seen[-1].get_header("Authorization") == f"token {expected}"
    out, err = capsys.readouterr()
    assert expected not in out and expected not in err


class _PlayerRequestHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        self.server.requests.append(
            {"path": self.path, "body": body, "auth": self.headers.get("Authorization")}
        )
        status, text, content_type = self.server.responder(self)
        self.server.replies.append(text)
        data = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass  # a test server writes no access log


class _FakePlayerServer(http.server.ThreadingHTTPServer):
    def __init__(self, responder):
        super().__init__(("127.0.0.1", 0), _PlayerRequestHandler)
        self.responder = responder
        self.requests = []
        self.replies = []


@pytest.fixture
def player_server(monkeypatch):
    """A local HTTP stand-in for the player route, with a fake token and a fixed state."""

    def accept(handler):
        if handler.headers.get("Authorization") != "token test-token":
            return 403, json.dumps({"message": "Authentication required"}), "application/json"
        return 200, json.dumps(_STATE, indent=2), "application/json"

    server = _FakePlayerServer(accept)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv(
        "JUPYTER_SERVER_URL", f"http://127.0.0.1:{server.server_address[1]}"
    )
    monkeypatch.setenv("JUPYTER_TOKEN", "test-token")
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_player_against_a_local_http_server(player_server, capsys):
    calls = [
        (["player", "play", "a.wav"], {"action": "play", "path": "a.wav", "mode": "queue"}),
        (["player", "play", "a.wav", "--now"], {"action": "play", "path": "a.wav", "mode": "now"}),
        (["player", "pause"], {"action": "pause"}),
        (["player", "resume"], {"action": "resume"}),
        (["player", "stop"], {"action": "stop"}),
        (["player", "clear"], {"action": "clear"}),
        (["player", "status"], {"action": "status"}),
    ]

    for argv, _body in calls:
        assert cli.main(argv) == 0
        assert capsys.readouterr().out == (
            "playing 1 queue 1 paused no stopped no sink ready\n"
        )

    assert [json.loads(entry["body"]) for entry in player_server.requests] == [
        body for _argv, body in calls
    ]
    assert all(
        entry["path"] == "/jupyterlab-audio-extension/player"
        for entry in player_server.requests
    )
    assert all(entry["auth"] == "token test-token" for entry in player_server.requests)


def test_player_status_json_prints_the_route_object_verbatim(player_server, capsys):
    assert cli.main(["player", "status", "--json"]) == 0

    out = capsys.readouterr().out
    assert out == player_server.replies[-1] + "\n"
    assert json.loads(out) == _STATE
    assert "\x1b[" not in out


def test_player_400_refusal_prints_the_server_message_and_exits_1(player_server, capsys):
    player_server.responder = lambda handler: (
        400,
        json.dumps({"message": "Cannot play a.wav: no such file"}),
        "application/json",
    )

    assert cli.main(["player", "play", "a.wav"]) == 1

    out, err = capsys.readouterr()
    assert out == ""
    assert "Cannot play a.wav: no such file" in err


@pytest.mark.parametrize(
    "status, body, said",
    [
        (400, '{"reason": "no such file"}', "no such file"),
        (400, "<html><body>Bad Request</body></html>", "HTTP 400 Bad Request"),
    ],
)
def test_player_http_error_falls_back_to_reason_then_http_status(
    player_server, capsys, status, body, said
):
    player_server.responder = lambda handler: (
        status,
        body,
        "application/json" if body.startswith("{") else "text/html",
    )

    assert cli.main(["player", "status"]) == 1

    out, err = capsys.readouterr()
    assert out == ""
    assert said in err


def test_player_403_exits_1_without_printing_the_token(player_server, capsys):
    player_server.responder = lambda handler: (
        403,
        json.dumps({"message": "Authentication required"}),
        "application/json",
    )

    assert cli.main(["player", "status"]) == 1

    out, err = capsys.readouterr()
    assert "Authentication" in err
    assert "test-token" not in out and "test-token" not in err


def test_player_unreachable_server_exits_1(capsys, monkeypatch):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    _env_url_and_token(monkeypatch, base)

    assert cli.main(["player", "status"]) == 1

    out, err = capsys.readouterr()
    assert out == ""
    assert base in err


@pytest.mark.parametrize(
    "argv",
    [
        ["player"],
        ["player", "play"],
        ["player", "play", "a.wav", "extra"],
        ["player", "play", "a.wav", "--nope"],
        ["player", "pause", "--now"],
    ],
)
def test_player_usage_exits_2(capsys, argv):
    with pytest.raises(SystemExit) as exited:
        cli.main(argv)
    assert exited.value.code == 2


@pytest.mark.parametrize(
    "state, line",
    [
        (
            {
                "paused": False,
                "stopped": False,
                "playing": [{"id": 1}],
                "queue": [{"id": 2}],
                "sink": {"state": "ready"},
            },
            "playing 1 queue 1 paused no stopped no sink ready",
        ),
        (
            {
                "paused": True,
                "stopped": True,
                "playing": [{"id": 1}],
                "queue": [],
                "sink": {"state": "off"},
            },
            "playing 1 queue 0 paused yes stopped yes sink off",
        ),
    ],
)
def test_player_summary_is_one_line(monkeypatch, capsys, state, line):
    _env_url_and_token(monkeypatch)
    _capture(monkeypatch, state)

    assert cli.main(["player", "status"]) == 0

    assert capsys.readouterr().out == line + "\n"


@pytest.mark.parametrize("path", ["a.wav", "../a.wav", "/tmp/a.wav"])
def test_player_does_not_resolve_the_path(monkeypatch, path):
    _env_url_and_token(monkeypatch)
    seen = _capture(monkeypatch)

    assert cli.main(["player", "play", path]) == 0

    assert json.loads(seen[-1].data)["path"] == path


def test_player_stop_and_top_level_stop_are_distinct(monkeypatch):
    _env_url_and_token(monkeypatch)
    seen = _capture(monkeypatch)

    def never(_args=None):
        raise AssertionError("player stop must not kill the PulseAudio daemon")

    monkeypatch.setattr(cli, "_stop_daemon", never)

    assert cli.main(["player", "stop"]) == 0

    assert json.loads(seen[-1].data) == {"action": "stop"}


def test_cli_never_imports_the_player_and_never_names_paplay():
    source = pathlib.Path(cli.__file__).read_text(encoding="utf-8")
    tree = ast.parse(source)

    assert "paplay" not in source
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.level:
                assert node.module == "speaker", node.module
            else:
                root = (node.module or "").split(".")[0]
                assert root in sys.stdlib_module_names, root
                assert root != "player"
        elif isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                assert root in sys.stdlib_module_names, root
                assert root != "player"


def test_player_help_lists_every_action_with_an_example(capsys):
    actions = ("play", "pause", "resume", "stop", "clear", "status")

    out = _help(capsys, "player")
    for action in actions:
        assert action in out

    for action in actions:
        action_help = _help(capsys, "player", action)
        assert "examples:" in action_help
        assert f"jupyterlab_audio player {action}" in action_help

    play_help = " ".join(_help(capsys, "player", "play").split())
    assert "0.2 s" in play_help
    assert "earliest queued file" in play_help
