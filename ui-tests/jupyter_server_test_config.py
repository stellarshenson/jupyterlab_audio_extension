"""Server configuration for integration tests.

!! Never use this configuration in production because it
opens the server to the world and provide access to JupyterLab
JavaScript objects through the global window variable.
"""
import json
import os
from tempfile import mkdtemp

from jupyterlab.galata import configure_jupyter_server

configure_jupyter_server(c)

# `or`, not a get() default: an exported-but-empty value must fall back too.
c.ServerApp.port = int(os.environ.get("JUPYTER_TEST_PORT") or "8888")

# The specs create this FIFO and read it, standing in for PulseAudio's module-pipe-source.
c.AudioCapture.sink_path = os.environ["VOICE_TEST_SINK"]

# The sandbox sees /opt/conda's dictation extension, whose frontend adds a pill item, a
# divider and a settings card the specs assert absent. JupyterLab reads page_config.json
# from app_settings_dir, so a scratch dir holding the disabling page config keeps that
# frontend out of the test lab without changing any assertion.
app_settings_dir = mkdtemp(prefix="galata-app-settings-")
with open(os.path.join(app_settings_dir, "page_config.json"), "w", encoding="utf-8") as fp:
    json.dump(
        {"disabledExtensions": {"@stellarshenson/jupyterlab-dictation-extension": True}},
        fp,
    )
c.LabApp.app_settings_dir = app_settings_dir

# /files/ from the test root, jupyter_server's default; a lab image may pin it to its own root.
c.ContentsManager.files_handler_params = {"path": c.ServerApp.root_dir}

# Uncomment to set server log level to debug level
# c.ServerApp.log_level = "DEBUG"
