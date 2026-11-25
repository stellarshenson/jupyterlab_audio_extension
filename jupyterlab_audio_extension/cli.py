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
  status    - print one read-only report: the installed distribution, the required software
              with apt and conda examples for what is missing, and every bridge component
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import subprocess
import sys
import urllib.error
import urllib.request

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

PLAYER_ROUTE = "/jupyterlab-audio-extension/player"
TOKEN_ENV = ("JUPYTERHUB_API_TOKEN", "JPY_API_TOKEN", "JUPYTER_TOKEN")

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


def _pactl(*args, pin_server: bool = False) -> tuple[int, str]:
    env = _pulse_env()
    if pin_server:
        # status reads the CLI's socket, not a daemon autospawned from client.conf
        env["PULSE_SERVER"] = env.get("PULSE_SERVER") or f"unix:{PULSE_SOCKET}"
    try:
        res = subprocess.run(
            ["pactl", *args],
            env=env,
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


def _component_checks(sink: str, *, pin_server: bool = False) -> list:
    """The rows after the package checks: the runtime dir, both FIFOs, the daemon, its
    source and sink with the defaults, client.conf and AUDIODRIVER."""
    sink_dir = os.path.dirname(sink) or "/"
    speaker = os.path.join(os.path.dirname(sink), SPEAKER_FIFO_NAME)
    pin = {"pin_server": True} if pin_server else {}
    rc_info, info = _pactl("info", **pin)
    _, sources = _pactl("list", "short", "sources", **pin)
    _, sinks = _pactl("list", "short", "sinks", **pin)

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

    return [
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


def cmd_validate(args) -> int:
    sink = args.sink_path
    checks = [*_package_checks(), *_component_checks(sink)]

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


# --------------------------------------------------------------------------- status

# Required system packages: (row label, apt package, conda package), in _package_checks order.
SOFTWARE = [
    ("pulseaudio", "pulseaudio", "pulseaudio"),
    ("pulseaudio-utils (pactl)", "pulseaudio-utils", "pulseaudio"),
    ("sox (rec)", "sox", "sox"),
    ("libsox-fmt-pulse (SoX PulseAudio driver)", "libsox-fmt-pulse", "sox"),
]


def _distribution_check() -> tuple:
    """(row label, present, fix) for the installed distribution and its metadata version."""
    from importlib.metadata import PackageNotFoundError, version

    try:
        return (
            f"distribution jupyterlab_audio_extension {version('jupyterlab_audio_extension')}",
            True,
            "",
        )
    except PackageNotFoundError:
        return (
            "distribution jupyterlab_audio_extension (metadata unavailable)",
            False,
            "pip install jupyterlab-audio-extension",
        )


def _software_rows() -> list:
    """(label, present, apt example, conda example) per package; _package_checks and
    SOFTWARE are in the same order."""
    return [
        (label, ok, f"sudo apt-get install -y {apt}", f"conda install -c conda-forge {conda}")
        for (label, apt, conda), (_check, ok, _fix) in zip(SOFTWARE, _package_checks())
    ]


def cmd_status(args) -> int:
    sink = args.sink_path
    distribution = _distribution_check()
    software = _software_rows()
    checks = _component_checks(sink, pin_server=True)

    missing_software = [row for row in software if not row[1]]
    missing = [(label, fix) for label, ok, fix in checks if not ok]
    if not distribution[1]:
        missing.insert(0, (distribution[0], distribution[2]))
    ok_all = not missing and not missing_software

    if args.json:
        _color(False)
        payload = {
            "ok": ok_all,
            "sink_path": sink,
            "distribution": {
                "name": distribution[0],
                "ok": distribution[1],
                "fix": None if distribution[1] else distribution[2],
            },
            "software": [
                {"name": label, "ok": ok, "apt": apt, "conda": conda}
                for label, ok, apt, conda in software
            ],
            "checks": [
                {"name": label, "ok": ok, "fix": None if ok else fix}
                for label, ok, fix in checks
            ],
        }
        print(json.dumps(payload, indent=2))
        return 0 if ok_all else 1

    print("Audio extension status\n")
    print(f"  {_ok() if distribution[1] else _miss()}  {distribution[0]}")
    print("\nRequired software")
    for label, ok, _apt, _conda in software:
        print(f"  {_ok() if ok else _miss()}  {label}")
    if missing_software:
        print("\n" + _c("How to install what is missing:", "yellow"))
        for label, _present, apt, conda in missing_software:
            print(f"  - {label}:")
            print(f"      apt:   {apt}")
            print(f"      conda: {conda}")
        print(
            "\n  conda-forge SoX lacks the PulseAudio driver; install sox and\n"
            "  libsox-fmt-pulse with apt. The stack is installed with apt and these\n"
            "  conda lines are for reference; a conda pulseaudio can start a second\n"
            "  daemon that masks the bridge."
        )
    else:
        print("\n" + _c("All required software is present.", "green"))

    print("\nAudio bridge")
    for label, ok, _fix in checks:
        print(f"  {_ok() if ok else _miss()}  {label}")

    if missing:
        print("\n" + _c("How to fix what is missing:", "yellow"))
        for label, fix in missing:
            print(f"  - {label}:")
            print(f"      {fix}")
    if missing or missing_software:
        print("\n" + _c("Some components are missing (see above).", "yellow"))
        return 1

    print("\n" + _c("All components in place.", "green"))
    return 0


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


# --------------------------------------------------------------------- player (client)


class _PlayerRefused(Exception):
    """A player request the CLI refuses before sending it."""


def _env_token() -> str:
    for name in TOKEN_ENV:
        value = os.environ.get(name, "")
        if value:
            return value
    return ""


def _running_servers(records) -> str:
    listed = ", ".join(
        f"{record.get('port')}{record.get('base_url') or '/'}"
        + ("" if record.get("token") else " (no token)")
        for record in records
    )
    return listed or "none"


def _server_records() -> list:
    """One bounded `jupyter server list --json`; lines that are not JSON objects are skipped."""
    try:
        result = subprocess.run(
            ["jupyter", "server", "list", "--json"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise _PlayerRefused(f"cannot run `jupyter server list --json`: {exc}") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip() or "exit " + str(result.returncode)
        raise _PlayerRefused(f"`jupyter server list --json` failed: {detail}")
    records = []
    for line in result.stdout.splitlines():
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


def _matching_records(records) -> list:
    root = os.environ.get("JUPYTER_SERVER_ROOT", "")
    if not root:
        return list(records)
    wanted = os.path.abspath(root)
    return [
        record
        for record in records
        if os.path.abspath(str(record.get("root_dir", ""))) == wanted
    ]


def _record_base(record) -> str:
    scheme = "https" if record.get("secure") else "http"
    return f"{scheme}://127.0.0.1:{record.get('port')}{record.get('base_url') or '/'}"


def _record_token(record) -> str:
    token = record.get("token") if isinstance(record, dict) else None
    return token if isinstance(token, str) else ""


def _player_server() -> tuple:
    """The (base URL, token) of the player route; an ambiguous lab is refused."""
    base = os.environ.get("JUPYTER_SERVER_URL", "").strip()
    token = _env_token()
    if base and token:
        return base, token
    records = _server_records()
    matched = _matching_records(records)
    if base:
        # The record is needed only for its token; zero matches send no token and let the
        # route answer 403, several are refused rather than guessed.
        if len(matched) > 1:
            raise _PlayerRefused(
                "several running Jupyter servers match; cannot tell which is the lab. "
                f"Running: {_running_servers(records)}"
            )
        return base, token or _record_token(matched[0] if matched else None)
    if len(matched) != 1:
        reason = (
            "no running Jupyter server matched"
            if not matched
            else "several running Jupyter servers matched"
        )
        raise _PlayerRefused(
            f"{reason}; cannot tell which is the lab. Running: {_running_servers(records)}"
        )
    record = matched[0]
    return _record_base(record), token or _record_token(record)


def _player_request(base: str, token: str, body: dict) -> urllib.request.Request:
    """The POST that carries one action; the token appears only in its Authorization header."""
    request = urllib.request.Request(
        base.rstrip("/") + PLAYER_ROUTE,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
    )
    request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"token {token}")
    return request


def _open(request) -> str:
    """Send the request with proxies bypassed, so a loopback token never reaches a proxy."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=10) as response:
        return response.read().decode("utf-8")


def _http_error_message(exc) -> str:
    try:
        payload = json.loads(exc.read().decode("utf-8", "replace"))
    except (OSError, ValueError):
        payload = None
    if isinstance(payload, dict):
        for key in ("message", "reason"):
            value = payload.get(key)
            if isinstance(value, str) and value:
                return value
    return f"HTTP {exc.code} {exc.reason}"


def _summary(state: dict) -> str:
    return (
        f"playing {len(state.get('playing') or [])} "
        f"queue {len(state.get('queue') or [])} "
        f"paused {'yes' if state.get('paused') else 'no'} "
        f"stopped {'yes' if state.get('stopped') else 'no'} "
        f"sink {(state.get('sink') or {}).get('state', 'missing')}"
    )


def _player_action(body: dict, json_output: bool) -> int:
    try:
        base, token = _player_server()
    except _PlayerRefused as refusal:
        print(str(refusal), file=sys.stderr)
        return 1
    try:
        raw = _open(_player_request(base, token, body))
    except urllib.error.HTTPError as exc:
        print(_http_error_message(exc), file=sys.stderr)
        return 1
    except OSError as exc:
        print(
            f"cannot reach the Jupyter server at {base}: {getattr(exc, 'reason', exc)}",
            file=sys.stderr,
        )
        return 1
    try:
        state = json.loads(raw)
    except ValueError:
        state = None
    if not isinstance(state, dict):
        print("the player route returned no JSON object", file=sys.stderr)
        return 1
    if json_output:
        sys.stdout.write(raw if raw.endswith("\n") else raw + "\n")
    else:
        print(_summary(state))
    return 0


def cmd_player_play(args) -> int:
    return _player_action(
        {"action": "play", "path": args.path, "mode": "now" if args.now else "queue"},
        args.json,
    )


def cmd_player_action(args) -> int:
    return _player_action({"action": args.player_action}, args.json)


# ------------------------------------------------------------------------------ main


def main(argv=None) -> int:
    raw = argparse.RawDescriptionHelpFormatter
    parser = argparse.ArgumentParser(
        prog="jupyterlab_audio",
        description="Provision and verify the audio-capture container plumbing\n"
        "(PulseAudio + SoX bridge for the FIFO the extension writes).",
        epilog="exit codes:\n"
        "  0  success\n"
        "  1  validate found a missing component, status found a missing row, start did not\n"
        "     load voicein or voiceout, stop failed, or a command that install runs failed,\n"
        "     or install found a required package missing and no apt-get on PATH, or a\n"
        "     player request was refused or the server was unreachable\n"
        "  2  unknown command or flag (usage)\n"
        "\n"
        "stop kills the PulseAudio daemon; player stop ends playback and leaves the daemon;\n"
        "status only reads and changes nothing.\n"
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

    p_status = sub.add_parser(
        "status",
        help="print a read-only report of the distribution and the audio bridge",
        description="Print one read-only report and change nothing: the installed distribution and\n"
        "its version, the required software with an example apt and conda command for each\n"
        "missing package, the runtime dir, the sink and speaker FIFOs, the PulseAudio daemon,\n"
        "the voicein source and voiceout sink with the default source and sink, default-server\n"
        "in /etc/pulse/client.conf and AUDIODRIVER=pulseaudio. Prints [ OK ] or [MISS] per row\n"
        "and how to fix each missing one. Exits 1 when a row is missing; --json prints the\n"
        "same report as JSON.",
        epilog="examples:\n"
        "  jupyterlab_audio status\n"
        "  jupyterlab_audio status --json",
        formatter_class=raw,
    )
    p_status.add_argument(
        "--sink-path", default=DEFAULT_SINK_PATH, help="FIFO path (default: %(default)s)"
    )
    p_status.add_argument(
        "--json", action="store_true", help="emit the report as JSON (no colour)"
    )
    p_status.set_defaults(func=cmd_status)

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

    p_player = sub.add_parser(
        "player",
        help="control the virtual player: play, pause, resume, stop, clear and status",
        description="Control the virtual player through the running Jupyter server, which owns\n"
        "the files and the playback processes. Actions: play, pause, resume, stop, clear\n"
        "and status. Each action prints one line by default:\n"
        "  playing N queue M paused yes|no stopped yes|no sink ready|off|missing\n"
        "--json prints the server's state object verbatim. The command finds the server\n"
        "from JUPYTER_SERVER_URL, else from the one running server whose root_dir is\n"
        "JUPYTER_SERVER_ROOT, and authenticates with JUPYTERHUB_API_TOKEN, JPY_API_TOKEN,\n"
        "JUPYTER_TOKEN or that server's record. Audibility needs a connected JupyterLab\n"
        "tab. player stop ends playback and leaves the PulseAudio daemon; the top-level\n"
        "stop kills the daemon.",
        epilog="examples:\n"
        "  jupyterlab_audio player status\n"
        "  jupyterlab_audio player play a.wav\n"
        "  jupyterlab_audio player play a.wav --now\n"
        "  jupyterlab_audio player pause\n"
        "  jupyterlab_audio player resume\n"
        "  jupyterlab_audio player stop\n"
        "  jupyterlab_audio player clear\n"
        "  jupyterlab_audio player status --json",
        formatter_class=raw,
    )
    player_sub = p_player.add_subparsers(dest="player_action", required=True)

    p_play = player_sub.add_parser(
        "play",
        help="play a file, by default behind the current file",
        description="Queue PATH on the player. A queue play starts the earliest queued file\n"
        "when nothing plays; after a player stop the earliest queued file starts and PATH\n"
        "joins behind it, so PATH need not be the file that plays. The 0.2 s start grace\n"
        "delays the answer only when a file actually starts; a play that only joins the\n"
        "queue returns at once. PATH is sent as typed and resolved by the server against\n"
        "the Jupyter contents root; a missing file, a non-file or a path outside the root\n"
        "is refused with the server's message. Audibility needs a connected JupyterLab\n"
        "tab.",
        epilog="examples:\n"
        "  jupyterlab_audio player play a.wav\n"
        "  jupyterlab_audio player play a.wav --now\n"
        "  jupyterlab_audio player play a.wav --json",
        formatter_class=raw,
    )
    p_play.add_argument("path", help="audio file to play, sent as typed")
    p_play.add_argument(
        "--now", action="store_true", help="start PATH at once beside every playing file"
    )
    p_play.add_argument(
        "--json", action="store_true", help="print the server's state object verbatim"
    )
    p_play.set_defaults(func=cmd_player_play)

    action_help = {
        "pause": (
            "pause every playing file",
            "Send SIGSTOP to every playing file and freeze its reported position; queued\n"
            "files stay queued.",
        ),
        "resume": (
            "resume every paused file and start the queue head when idle",
            "Send SIGCONT to every paused file, clear the stop gate and start the queue head\n"
            "when nothing is active.",
        ),
        "stop": (
            "end every playing or paused file and keep the queue",
            "End every playing or paused file and set the stop gate, keeping the queue. This\n"
            "leaves the PulseAudio daemon alone; the top-level stop kills the daemon.",
        ),
        "clear": (
            "remove the queued files",
            "Remove the queued files only; playing and paused files keep playing.",
        ),
        "status": (
            "print the player and speaker sink state",
            "Print the player state as one line by default: playing and queue counts,\n"
            "paused and stopped flags and the speaker sink state. --json prints the\n"
            "server's state object verbatim.",
        ),
    }
    for name, (help_line, description) in action_help.items():
        action_parser = player_sub.add_parser(
            name,
            help=help_line,
            description=description,
            epilog=f"examples:\n  jupyterlab_audio player {name}",
            formatter_class=raw,
        )
        action_parser.add_argument(
            "--json", action="store_true", help="print the server's state object verbatim"
        )
        action_parser.set_defaults(func=cmd_player_action, player_action=name)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
