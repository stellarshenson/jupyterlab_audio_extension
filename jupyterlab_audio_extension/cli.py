"""Operator CLI for the audio-capture container plumbing.

The extension itself never starts or configures PulseAudio or SoX - per the acceptance
criteria (group F) that plumbing is out of scope of the browser + bridge halves. This CLI
is a separate operator convenience for provisioning and verifying that plumbing inside the
container, exactly as documented in ``docs/jupyterlab-enable-claude-voice.md``.

Commands:
  install   - install packages, provision the lab-owned FIFO directory, write the PulseAudio
              client config and the extension's sink_path; does not start the daemon
  start     - start the userspace PulseAudio daemon and load the pipe-source (which creates
              the FIFO) as the default source and the pipe-sink (which creates the speaker
              FIFO) as the default sink
  stop      - kill the userspace PulseAudio daemon
  validate  - check every component is in place and print how to configure what is missing,
              including the AUDIODRIVER=pulseaudio setting the claude process needs
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import subprocess
import sys

from .speaker import SPEAKER_FIFO_NAME, STOP_MARKER_NAME

DEFAULT_SINK_PATH = "/run/voice/pulseaudio.fifo"
SOURCE_NAME = "voicein"
SPEAKER_SINK_NAME = "voiceout"
SPEAKER_RATE = 48000
SPEAKER_CHANNELS = 2
PULSE_RUNTIME_PATH = "/tmp/pulse-lab"
PULSE_SOCKET = f"{PULSE_RUNTIME_PATH}/native"
PULSE_CLIENT_CONF = "/etc/pulse/client.conf"
RATE = 16000
CHANNELS = 1
SAMPLE_FORMAT = "s16le"
APT_PACKAGES = ["pulseaudio", "pulseaudio-utils", "sox", "libsox-fmt-pulse"]

# ------------------------------------------------------------------------------ colour

# conservative palette: status only - success / failure / warning
_ANSI = {"green": "32", "red": "31", "yellow": "33"}
# colour only when the terminal is capable: a real TTY, not a dumb terminal, and NO_COLOR
# unset (https://no-color.org); machine consumers should use --json, which never colours
_COLOR = (
    sys.stdout.isatty()
    and os.environ.get("TERM") != "dumb"
    and os.environ.get("NO_COLOR") is None
)


def _color(enabled: bool) -> None:
    """Override colour output (used to silence colour in --json mode)."""
    global _COLOR
    _COLOR = enabled


def _c(text: str, name: str) -> str:
    return f"\033[{_ANSI[name]}m{text}\033[0m" if _COLOR else text


def _ok() -> str:
    return _c("[ OK ]", "green")


def _miss() -> str:
    return _c("[MISS]", "red")


def _current_user() -> str:
    import getpass

    return getpass.getuser()


def _pulse_env() -> dict:
    env = dict(os.environ)
    env["PULSE_RUNTIME_PATH"] = PULSE_RUNTIME_PATH
    return env


def _run(cmd, *, dry: bool = False, sudo: bool = False) -> int:
    if sudo and os.geteuid() != 0:
        cmd = ["sudo", *cmd]
    print(f"  $ {' '.join(cmd)}")
    if dry:
        return 0
    return subprocess.run(cmd, env=_pulse_env()).returncode


def _pactl(*args) -> tuple[int, str]:
    try:
        res = subprocess.run(
            ["pactl", *args],
            env=_pulse_env(),
            capture_output=True,
            text=True,
            timeout=10,
        )
        return res.returncode, (res.stdout or "")
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return 1, ""


def _sox_has_pulse() -> bool:
    try:
        res = subprocess.run(
            ["sox", "-h"], capture_output=True, text=True, timeout=10
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    return "pulseaudio" in (res.stdout + res.stderr).lower()


def _package_checks() -> list:
    return [
        ("pulseaudio on PATH", shutil.which("pulseaudio") is not None,
         "apt install pulseaudio"),
        ("pactl on PATH", shutil.which("pactl") is not None,
         "apt install pulseaudio-utils"),
        ("sox / rec on PATH", shutil.which("rec") is not None,
         "apt install sox"),
        ("sox pulseaudio driver", _sox_has_pulse(),
         "apt install libsox-fmt-pulse"),
    ]


def _client_conf_has_default_server() -> bool:
    try:
        with open(PULSE_CLIENT_CONF, encoding="utf-8") as handle:
            return any(
                line.strip().startswith("default-server")
                and "default-server" in line
                and not line.strip().startswith(";")
                and not line.strip().startswith("#")
                for line in handle
            )
    except OSError:
        return False


def _is_fifo(path: str) -> bool:
    try:
        return stat.S_ISFIFO(os.stat(path).st_mode)
    except OSError:
        return False


def _daemon_running() -> bool:
    rc, _ = _pactl("info")
    return rc == 0


def _source_loaded() -> bool:
    _, sources = _pactl("list", "short", "sources")
    return SOURCE_NAME in sources


def _sink_loaded() -> bool:
    _, sinks = _pactl("list", "short", "sinks")
    return SPEAKER_SINK_NAME in sinks


def _suspend_on_idle_loaded() -> bool:
    _, modules = _pactl("list", "short", "modules")
    return "module-suspend-on-idle" in modules


def _start_pulse_and_source(sink: str, dry: bool) -> None:
    """Start the userspace PulseAudio daemon (if needed) and expose the pipe-source and the
    pipe-sink."""
    if not dry and _daemon_running():
        print("  PulseAudio already running")
    else:
        if not dry:
            os.makedirs(PULSE_RUNTIME_PATH, exist_ok=True)
            os.chmod(PULSE_RUNTIME_PATH, 0o700)
        _run(
            [
                "pulseaudio",
                "--daemonize=yes",
                "--exit-idle-time=-1",
                "-n",
                "--load=module-native-protocol-unix",
            ],
            dry=dry,
        )
    if not dry and _source_loaded():
        print(f"  source '{SOURCE_NAME}' already loaded")
    else:
        # A FIFO with no voicein loaded was left by a daemon killed without unloading the
        # source; module-pipe-source refuses an existing path.
        if _is_fifo(sink):
            _run(["rm", "-f", sink], dry=dry)
        _run(
            [
                "pactl",
                "load-module",
                "module-pipe-source",
                f"source_name={SOURCE_NAME}",
                f"file={sink}",
                f"format={SAMPLE_FORMAT}",
                f"rate={RATE}",
                f"channels={CHANNELS}",
            ],
            dry=dry,
        )
        # The loopback keeps voicein reading the FIFO while nothing records, so no old
        # audio waits in the pipe for the next /voice recording.
        _run(["pactl", "load-module", "module-null-sink", "sink_name=voicedrain"], dry=dry)
        _run(
            ["pactl", "load-module", "module-loopback", f"source={SOURCE_NAME}", "sink=voicedrain"],
            dry=dry,
        )
    _run(["pactl", "set-default-source", SOURCE_NAME], dry=dry)
    speaker = os.path.join(os.path.dirname(sink), SPEAKER_FIFO_NAME)
    if not dry and _sink_loaded():
        print(f"  sink '{SPEAKER_SINK_NAME}' already loaded")
    else:
        # module-pipe-sink reuses an existing FIFO but on unload removes only one it created.
        if _is_fifo(speaker):
            _run(["rm", "-f", speaker], dry=dry)
        _run(
            [
                "pactl",
                "load-module",
                "module-pipe-sink",
                f"sink_name={SPEAKER_SINK_NAME}",
                f"file={speaker}",
                f"format={SAMPLE_FORMAT}",
                f"rate={SPEAKER_RATE}",
                f"channels={SPEAKER_CHANNELS}",
                "use_system_clock_for_timing=yes",
            ],
            dry=dry,
        )
    _run(["pactl", "set-default-sink", SPEAKER_SINK_NAME], dry=dry)
    # A new default sink also takes the voicein loopback off voicedrain, which would play the
    # microphone in the tab and keep voiceout from going idle; move it back.
    if not dry:
        _, inputs = _pactl("list", "short", "sink-inputs")
        for ln in inputs.splitlines():
            if "module-loopback.c" in ln:
                _run(["pactl", "move-sink-input", ln.split()[0], "voicedrain"])
    # An idle sink is suspended after 5 s, so the pipe-sink writes nothing while nothing plays.
    if dry or not _suspend_on_idle_loaded():
        _run(["pactl", "load-module", "module-suspend-on-idle"], dry=dry)


def _stop_daemon() -> int:
    return _run(["pulseaudio", "--kill"])


# --------------------------------------------------------------------------- install


def _install_packages(dry: bool) -> bool:
    """Install the audio stack via apt (``apt-get update`` + ``install``), using sudo when
    not already root. Returns True when an apt-get command failed, or when apt-get is
    missing and a package is not installed.

    conda is intentionally not used: the conda-forge ``sox`` build ships without the
    pulseaudio I/O driver, so a sox that can record from pulse must come from the Debian
    ``sox`` + ``libsox-fmt-pulse`` build. When apt needs root, sudo prompts the operator
    for a password interactively; this CLI does not capture stdio, so the prompt passes
    straight through to the user's terminal.
    """
    if not dry and shutil.which("apt-get") is None:
        if all(ok for _label, ok, _fix in _package_checks()):
            print("  apt-get not found - every package is already installed")
            return False
        print("  apt-get not found - install these with your platform's package manager:")
        print(f"    {' '.join(APT_PACKAGES)}")
        print("    (sox must include the pulseaudio driver; Debian: libsox-fmt-pulse)")
        return True

    need_sudo = os.geteuid() != 0
    if need_sudo and not dry:
        print("  apt needs root - sudo will prompt for your password")
    failed = _run(["apt-get", "update"], dry=dry, sudo=need_sudo) != 0
    rc = _run(["apt-get", "install", "-y", *APT_PACKAGES], dry=dry, sudo=need_sudo)
    if not dry and rc != 0:
        print("  apt install failed - install these another way:")
        print(f"    {' '.join(APT_PACKAGES)}")
        print("    (sox must include the pulseaudio driver; Debian: libsox-fmt-pulse)")
    return failed or rc != 0


def cmd_install(args) -> int:
    sink = args.sink_path
    sink_dir = os.path.dirname(sink) or "/"
    dry = args.dry_run
    user = _current_user()

    print("Provisioning audio-capture plumbing (operator tool; the extension never does this).")
    if dry:
        print(_c("DRY RUN - nothing will be executed.", "yellow") + "\n")

    print("1) Install packages")
    failed = _install_packages(dry)

    print(f"\n2) Provision runtime dir {sink_dir}")
    if os.path.isdir(sink_dir):
        print(f"  {sink_dir} already exists - leaving ownership unchanged")
    else:
        failed |= _run(
            ["install", "-d", "-m", "0755", "-o", user, "-g", user, sink_dir],
            dry=dry,
            sudo=True,
        ) != 0

    print(f"\n3) Make the daemon discoverable in {PULSE_CLIENT_CONF}")
    line = f"default-server = unix:{PULSE_SOCKET}"
    failed |= _run(
        [
            "sh",
            "-c",
            f'grep -qF "{line}" {PULSE_CLIENT_CONF} 2>/dev/null '
            f'|| echo "{line}" >> {PULSE_CLIENT_CONF}',
        ],
        dry=dry,
        sudo=True,
    ) != 0

    cfg = _jupyter_server_config()
    print(f"\n4) Point the extension at the sink in {cfg}")
    _write_sink_config(cfg, sink, dry)

    if failed:
        print("\n" + _c("install failed - fix the errors above and run install again.", "red"))
        return 1

    print("\nDone. install does not start the daemon. Next steps:\n")
    print("  1) start the bridge (also re-run after every container restart):")
    print("       jupyterlab_audio start -d")
    print("  2) set the SoX driver in the shell that launches claude:")
    print("       bash:  export AUDIODRIVER=pulseaudio")
    print("       fish:  set -gx AUDIODRIVER pulseaudio")
    print(
        "\nThen verify with:\n"
        "  jupyterlab_audio validate"
    )
    return 0


# -------------------------------------------------------------------------- validate


def cmd_validate(args) -> int:
    sink = args.sink_path
    sink_dir = os.path.dirname(sink) or "/"
    speaker = os.path.join(os.path.dirname(sink), SPEAKER_FIFO_NAME)
    rc_info, info = _pactl("info")
    _, sources = _pactl("list", "short", "sources")
    _, sinks = _pactl("list", "short", "sinks")

    default_source = ""
    default_sink = ""
    for ln in info.splitlines():
        if ln.startswith("Default Source:"):
            default_source = ln.split(":", 1)[1].strip()
        if ln.startswith("Default Sink:"):
            default_sink = ln.split(":", 1)[1].strip()

    # The source is only functionally connected when its backing FIFO is a real FIFO; a
    # loaded module against a missing or non-FIFO path must never read green.
    fifo_ok = _is_fifo(sink)
    speaker_ok = _is_fifo(speaker)

    checks = [
        *_package_checks(),
        (f"runtime dir {sink_dir}", os.path.isdir(sink_dir),
         f"sudo install -d -m 0755 -o $(id -un) -g $(id -gn) {sink_dir}"),
        (f"FIFO {sink}", fifo_ok,
         "created by module-pipe-source: jupyterlab_audio start"),
        ("PulseAudio daemon reachable", rc_info == 0,
         "jupyterlab_audio start"),
        (f"source '{SOURCE_NAME}' connected", (SOURCE_NAME in sources) and fifo_ok,
         "jupyterlab_audio start"),
        (f"default source is '{SOURCE_NAME}'", default_source == SOURCE_NAME and fifo_ok,
         f"jupyterlab_audio start  (or: pactl set-default-source {SOURCE_NAME})"),
        (f"speaker FIFO {speaker}", speaker_ok,
         "created by module-pipe-sink: jupyterlab_audio start"),
        (f"sink '{SPEAKER_SINK_NAME}' connected", (SPEAKER_SINK_NAME in sinks) and speaker_ok,
         "jupyterlab_audio start"),
        (f"default sink is '{SPEAKER_SINK_NAME}'", default_sink == SPEAKER_SINK_NAME and speaker_ok,
         f"jupyterlab_audio start  (or: pactl set-default-sink {SPEAKER_SINK_NAME})"),
        ("default-server in client.conf", _client_conf_has_default_server(),
         f'echo "default-server = unix:{PULSE_SOCKET}" | sudo tee -a {PULSE_CLIENT_CONF}'),
        ("AUDIODRIVER=pulseaudio in this env", os.environ.get("AUDIODRIVER") == "pulseaudio",
         "export AUDIODRIVER=pulseaudio  (must be set in the claude process)"),
    ]

    missing = [(label, fix) for label, ok, fix in checks if not ok]
    ok_all = not missing
    sink_line = f'c.AudioCapture.sink_path = "{sink}"'

    if args.json:
        _color(False)
        payload = {
            "ok": ok_all,
            "sink_path": sink,
            "checks": [
                {"name": label, "ok": ok, "fix": (None if ok else fix)}
                for label, ok, fix in checks
            ],
            "missing": [{"name": label, "fix": fix} for label, fix in missing],
            "config": {
                "sink_path_line": sink_line,
                "audiodriver": "AUDIODRIVER=pulseaudio",
            },
        }
        print(json.dumps(payload, indent=2))
        return 0 if ok_all else 1

    print("Audio-capture component check\n")
    for label, ok, _fix in checks:
        print(f"  {_ok() if ok else _miss()}  {label}")

    if missing:
        print("\n" + _c("How to configure what is missing:", "yellow"))
        for label, fix in missing:
            print(f"  - {label}:")
            print(f"      {fix}")

    print("\nExtension sink path (set in jupyter_server_config.py, then restart the server):")
    print(f"  {sink_line}")

    print("\nMake PulseAudio the SoX driver in the shell that launches claude:")
    print("  bash:  export AUDIODRIVER=pulseaudio")
    print("  fish:  set -gx AUDIODRIVER pulseaudio")

    if ok_all:
        print("\n" + _c("All components in place.", "green"))
    else:
        print("\n" + _c("Some components are missing (see above).", "yellow"))
    return 0 if ok_all else 1


# ----------------------------------------------------------------------- start / stop


def _stop_marker(sink: str) -> str:
    """The stop marker file beside the sink FIFO."""
    return os.path.join(os.path.dirname(sink) or "/", STOP_MARKER_NAME)


def _record_shutdown(sink: str) -> None:
    """Record a deliberate shutdown so the player reports the sink off."""
    marker = _stop_marker(sink)
    if os.path.isdir(os.path.dirname(marker)):
        with open(marker, "w", encoding="utf-8"):
            pass
        print("Recorded the audio output as shut down.")


def cmd_start(args) -> int:
    sink = args.sink_path
    print(f"Starting PulseAudio voice bridge (source '{SOURCE_NAME}' -> {sink})")
    _start_pulse_and_source(sink, dry=False)
    if not _daemon_running() or not _source_loaded() or not _sink_loaded():
        print(
            f"Failed to start the PulseAudio daemon or load source '{SOURCE_NAME}' "
            f"or sink '{SPEAKER_SINK_NAME}' - run: jupyterlab_audio validate"
        )
        return 1
    try:
        os.unlink(_stop_marker(sink))
    except FileNotFoundError:
        pass  # no stop marker to clear
    if args.detached:
        print(
            "Daemon running (detached). Stop it with: "
            "jupyterlab_audio stop"
        )
        return 0
    print("Daemon running. Press Ctrl-C to stop.")
    try:
        import time

        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("\nStopping...")
        if _stop_daemon() == 0:
            _record_shutdown(sink)
    return 0


def cmd_stop(args) -> int:
    if not _daemon_running():
        print("PulseAudio daemon is not running.")
        _record_shutdown(args.sink_path)
        return 0
    print("Stopping PulseAudio daemon...")
    rc = _stop_daemon()
    print("Stopped." if rc == 0 else "Stop command returned non-zero.")
    if rc == 0:
        _record_shutdown(args.sink_path)
    return rc


def _jupyter_server_config() -> str:
    return os.path.join(os.path.expanduser("~"), ".jupyter", "jupyter_server_config.py")


def _config_has_sink_path(path: str) -> bool:
    try:
        with open(path, encoding="utf-8") as handle:
            for raw in handle:
                stripped = raw.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                if (
                    "c.AudioCapture.sink_path" in stripped
                    or "c.VoiceCapture.sink_path" in stripped
                ):
                    return True
    except OSError:
        pass
    return False


def _write_sink_config(cfg: str, sink: str, dry: bool) -> None:
    """Write the `c.AudioCapture.sink_path` line into the Jupyter server config if absent."""
    setting = f'c.AudioCapture.sink_path = "{sink}"'
    if not dry and _config_has_sink_path(cfg):
        print(f"  sink_path already set in {cfg} - leaving it")
        return
    if dry:
        print(f"  $ printf '\\n{setting}\\n' >> {cfg}")
        return
    os.makedirs(os.path.dirname(cfg), exist_ok=True)
    with open(cfg, "a", encoding="utf-8") as handle:
        handle.write(f"\n{setting}\n")
    print(f"  wrote {setting}")
    print("  restart the Jupyter server for it to take effect")


# ------------------------------------------------------------------------------ main


def main(argv=None) -> int:
    raw = argparse.RawDescriptionHelpFormatter
    parser = argparse.ArgumentParser(
        prog="jupyterlab_audio",
        description="Provision and verify the audio-capture container plumbing\n"
        "(PulseAudio + SoX bridge for the FIFO the extension writes).",
        epilog="exit codes:\n"
        "  0  success\n"
        "  1  validate found a missing component, start did not load voicein or voiceout,\n"
        "     stop failed, or a command that install runs failed, or install found a\n"
        "     required package missing and no apt-get on PATH\n"
        "  2  unknown command or flag\n"
        "\n"
        "environment:\n"
        "  NO_COLOR, TERM  no status colour when NO_COLOR is set, TERM is dumb or the output\n"
        "                  is not a terminal\n"
        "  AUDIODRIVER     validate checks that it is pulseaudio",
        formatter_class=raw,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_install = sub.add_parser(
        "install",
        help="install and configure the audio plumbing",
        description="Install pulseaudio, pulseaudio-utils, sox and libsox-fmt-pulse with apt-get\n"
        "(through sudo when not root, which asks for a password), create the directory of\n"
        "--sink-path, and add default-server to /etc/pulse/client.conf and\n"
        "c.AudioCapture.sink_path to ~/.jupyter/jupyter_server_config.py where missing.\n"
        "Does not start the daemon. Prints each command it runs, then the next steps when no\n"
        "step failed.",
        epilog="examples:\n"
        "  jupyterlab_audio install --dry-run\n"
        "  jupyterlab_audio install",
        formatter_class=raw,
    )
    p_install.add_argument(
        "--sink-path", default=DEFAULT_SINK_PATH, help="FIFO path (default: %(default)s)"
    )
    p_install.add_argument(
        "--dry-run", action="store_true", help="print the commands without running them"
    )
    p_install.set_defaults(func=cmd_install)

    p_validate = sub.add_parser(
        "validate",
        help="verify components and print how to configure them",
        description="Check every component of the audio bridge and change nothing: the programs, the\n"
        "directory and FIFO of --sink-path, the microphone source voicein, the speaker FIFO\n"
        "and sink voiceout, the default source and sink, default-server in\n"
        "/etc/pulse/client.conf and AUDIODRIVER=pulseaudio in this environment. Prints\n"
        "[ OK ] or [MISS] per check, how to fix each missing one and the\n"
        "c.AudioCapture.sink_path line. Exits 1 when a component is missing.",
        epilog="examples:\n"
        "  jupyterlab_audio validate\n"
        "  jupyterlab_audio validate --json",
        formatter_class=raw,
    )
    p_validate.add_argument(
        "--sink-path", default=DEFAULT_SINK_PATH, help="FIFO path (default: %(default)s)"
    )
    p_validate.add_argument(
        "--json", action="store_true", help="emit the component check as JSON (no colour)"
    )
    p_validate.set_defaults(func=cmd_validate)

    p_start = sub.add_parser(
        "start",
        help="start the PulseAudio daemon and expose the pipe-source and pipe-sink",
        description="Start the userspace PulseAudio daemon unless it runs, then load what is missing:\n"
        "the microphone source voicein, which reads the FIFO at --sink-path, and the speaker\n"
        "sink voiceout, which writes speaker.fifo in the same directory and plays in every\n"
        "open JupyterLab tab; both become the defaults. Run it again after every container\n"
        "restart. Without -d it waits until Ctrl-C, which stops the daemon. Prints each\n"
        "command it runs; exits 1 when voicein or voiceout did not load.",
        epilog="examples:\n"
        "  jupyterlab_audio start -d\n"
        "  jupyterlab_audio start -d --sink-path /run/voice/pulseaudio.fifo",
        formatter_class=raw,
    )
    p_start.add_argument(
        "--sink-path", default=DEFAULT_SINK_PATH, help="FIFO path (default: %(default)s)"
    )
    p_start.add_argument(
        "-d",
        "--detached",
        action="store_true",
        help="leave the daemon running in the background and return immediately",
    )
    p_start.set_defaults(func=cmd_start)

    p_stop = sub.add_parser(
        "stop",
        help="kill the running PulseAudio daemon",
        description="Kill the PulseAudio daemon. The microphone source voicein and the speaker sink\n"
        "voiceout go with it: programs in the container record and play nothing. This cannot\n"
        "be undone without start. Prints whether the daemon was running.",
        epilog="examples:\n  jupyterlab_audio stop",
        formatter_class=raw,
    )
    p_stop.add_argument(
        "--sink-path", default=DEFAULT_SINK_PATH, help="FIFO path (default: %(default)s)"
    )
    p_stop.set_defaults(func=cmd_stop)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
