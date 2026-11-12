import json
import os
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
    assert (
        "a command that install runs failed, or install found a required package missing and no "
        "apt-get on PATH" in " ".join(out.split())
    )


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
    ],
)
def test_command_help_says_what_it_does_and_shows_examples(capsys, command, says):
    out = _help(capsys, command)
    flat = " ".join(out.split())  # the descriptions break their lines by hand
    for phrase in says:
        assert phrase in flat
    assert f"examples:\n  jupyterlab_audio {command}" in out
