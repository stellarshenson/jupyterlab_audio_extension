"""Scope limits (acceptance group F): the server extension starts no process except the
virtual player's playback client, drives no audio tool, and does no speech-to-text. The
operator CLI (cli.py) is a separate tool that manages PulseAudio on purpose, so it is
exempt. ACC-SCOPE-25 is amended for the player: the extension may play audio files through
PulseAudio, and still never starts, stops or configures the daemon, never records and never
transcribes."""

import ast
import pathlib
import re

PACKAGE = pathlib.Path(__file__).resolve().parent.parent
EXTENSION_MODULES = sorted(p for p in PACKAGE.glob("*.py") if p.name != "cli.py")
AUDIO_TOOLS = re.compile(r"\b(pactl|pacmd|sox|rec|parec|arecord|paplay)\b")
SPEECH_TO_TEXT = {"whisper", "faster_whisper", "vosk", "speech_recognition", "deepgram"}
# The player spawns paplay, its playback client; no other module may start a process or
# name an audio tool.
PLAYBACK_MODULE = "player.py"


def _trees():
    return [(p.name, ast.parse(p.read_text())) for p in EXTENSION_MODULES]


def _imported(tree):
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module.split(".")[0])
    return names


def test_scan_covers_the_server_modules():
    assert {"__init__.py", "routes.py", "sink.py"} <= {p.name for p in EXTENSION_MODULES}


def test_extension_starts_no_processes():
    # F1/F2: no subprocess import outside the player, no os.system / os.exec* / os.spawn* /
    # os.popen call anywhere.
    for name, tree in _trees():
        if name != PLAYBACK_MODULE:
            assert "subprocess" not in _imported(tree), name
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Attribute)
                and isinstance(node.value, ast.Name)
                and node.value.id == "os"
            ):
                assert not re.match(r"(system|exec|spawn|popen)", node.attr), (
                    f"{name}: os.{node.attr}"
                )


def test_extension_names_no_audio_tool():
    # F1/F2: no string in the code names a PulseAudio or recorder command.
    for name, tree in _trees():
        docstrings = {
            id(node.body[0].value)
            for node in ast.walk(tree)
            if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
            and node.body
            and isinstance(node.body[0], ast.Expr)
            and isinstance(node.body[0].value, ast.Constant)
        }
        allowed = {"paplay"} if name == PLAYBACK_MODULE else set()
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and id(node) not in docstrings
            ):
                found = set(AUDIO_TOOLS.findall(node.value))
                assert not (found - allowed), f"{name}: {node.value!r}"


def test_extension_imports_no_speech_to_text():
    # F3: no speech-to-text library is imported.
    for name, tree in _trees():
        assert not (_imported(tree) & SPEECH_TO_TEXT), name
