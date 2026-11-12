try:
    from ._version import __version__
except ImportError:
    # Fallback when using the package in dev mode without installing
    # in editable mode with pip. It is highly recommended to install
    # the package from a stable release or in editable mode: https://pip.pypa.io/en/stable/topics/local-project-installs/#editable-installs
    import warnings
    warnings.warn("Importing 'jupyterlab_audio_extension' outside a proper installation.")
    __version__ = "dev"
import os

from traitlets import Unicode
from traitlets.config import Configurable

from .player import Player
from .routes import CONNECTIONS_KEY, RECONNECT_CLOSE_CODE, setup_route_handlers
from .sink import FifoSink
from .speaker import SPEAKER_FIFO_NAME, SpeakerReader


class AudioCapture(Configurable):
    """Configuration for the audio-capture server extension."""

    sink_path = Unicode(
        "/run/voice/pulseaudio.fifo",
        config=True,
        help="Path to the FIFO sink that receives raw PCM audio frames.",
    )


def _jupyter_labextension_paths():
    return [{
        "src": "labextension",
        "dest": "@stellarshenson/jupyterlab-audio-extension"
    }]


def _jupyter_server_extension_points():
    return [{
        "module": "jupyterlab_audio_extension"
    }]


def _sink_path(config):
    """The sink path: AudioCapture.sink_path wins over a saved 1.1.8 VoiceCapture.sink_path."""
    section = config.get("AudioCapture", {})
    if "sink_path" in section:
        return section["sink_path"]
    return config.get("VoiceCapture", {}).get(
        "sink_path", AudioCapture.sink_path.default_value
    )


def _close_load(settings):
    """Close what a load keeps in web_app.settings: every open /stream and /speaker
    connection, the FIFO sink, the speaker reader and the player. A 1.0.18 load kept only
    the sink; the 1.1.8 package used the voice_capture_* keys."""
    for key in (CONNECTIONS_KEY, "voice_capture_connections"):
        for connection in list(settings.get(key, ())):
            connection.close(RECONNECT_CLOSE_CODE, "audio-capture server extension closed")
    for key in (
        "audio_capture_sink",
        "audio_capture_speaker",
        "audio_capture_player",
        "voice_capture_sink",
        "voice_capture_speaker",
        "voice_capture_player",
    ):
        owned = settings.pop(key, None)
        if owned is not None:
            owned.close()


def _load_jupyter_server_extension(server_app):
    """Registers the API handler to receive HTTP requests from the frontend extension.

    Parameters
    ----------
    server_app: jupyterlab.labapp.LabApp
        JupyterLab application instance
    """
    settings = server_app.web_app.settings
    # A soft reload loads again in the same server without calling the unload hook.
    _close_load(settings)
    config = AudioCapture(config=server_app.config)
    config.sink_path = _sink_path(server_app.config)
    sink = FifoSink(config.sink_path, server_app.log)
    sink.start()
    speaker_path = os.path.join(os.path.dirname(config.sink_path), SPEAKER_FIFO_NAME)
    reader = SpeakerReader(speaker_path, server_app.log)
    reader.start()
    settings["audio_capture_sink"] = sink
    settings["audio_capture_speaker"] = reader
    player = Player(settings["contents_manager"].root_dir, server_app.log)
    settings["audio_capture_player"] = player
    settings[CONNECTIONS_KEY] = set()
    setup_route_handlers(server_app.web_app, sink, reader, player)
    name = "jupyterlab_audio_extension"
    server_app.log.info(f"Registered {name} server extension (sink={config.sink_path})")


def _unload_jupyter_server_extension(server_app):
    """Stop the FIFO sink and the speaker reader, and close every open connection."""
    _close_load(server_app.web_app.settings)
