try:
    from ._version import __version__
except ImportError:
    # Fallback when using the package in dev mode without installing
    # in editable mode with pip. It is highly recommended to install
    # the package from a stable release or in editable mode: https://pip.pypa.io/en/stable/topics/local-project-installs/#editable-installs
    import warnings
    warnings.warn("Importing 'jupyterlab_voice_capture_extension' outside a proper installation.")
    __version__ = "dev"
import os

from traitlets import Unicode
from traitlets.config import Configurable

from .player import Player
from .routes import CONNECTIONS_KEY, RECONNECT_CLOSE_CODE, setup_route_handlers
from .sink import FifoSink
from .speaker import SPEAKER_FIFO_NAME, SpeakerReader


class VoiceCapture(Configurable):
    """Configuration for the voice-capture server extension."""

    sink_path = Unicode(
        "/run/voice/pulseaudio.fifo",
        config=True,
        help="Path to the FIFO sink that receives raw PCM audio frames.",
    )


def _jupyter_labextension_paths():
    return [{
        "src": "labextension",
        "dest": "@stellarshenson/jupyterlab-voice-capture-extension"
    }]


def _jupyter_server_extension_points():
    return [{
        "module": "jupyterlab_voice_capture_extension"
    }]


def _close_load(settings):
    """Close what a load keeps in web_app.settings: every open /stream and /speaker
    connection, the FIFO sink, the speaker reader and the player. A 1.0.18 load kept only
    the sink."""
    for connection in list(settings.get(CONNECTIONS_KEY, ())):
        connection.close(RECONNECT_CLOSE_CODE, "voice-capture server extension closed")
    for key in ("voice_capture_sink", "voice_capture_speaker", "voice_capture_player"):
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
    config = VoiceCapture(config=server_app.config)
    sink = FifoSink(config.sink_path, server_app.log)
    sink.start()
    speaker_path = os.path.join(os.path.dirname(config.sink_path), SPEAKER_FIFO_NAME)
    reader = SpeakerReader(speaker_path, server_app.log)
    reader.start()
    settings["voice_capture_sink"] = sink
    settings["voice_capture_speaker"] = reader
    player = Player(settings["contents_manager"].root_dir, server_app.log)
    settings["voice_capture_player"] = player
    settings[CONNECTIONS_KEY] = set()
    setup_route_handlers(server_app.web_app, sink, reader, player)
    name = "jupyterlab_voice_capture_extension"
    server_app.log.info(f"Registered {name} server extension (sink={config.sink_path})")


def _unload_jupyter_server_extension(server_app):
    """Stop the FIFO sink and the speaker reader, and close every open connection."""
    _close_load(server_app.web_app.settings)
