"""Server configuration for integration tests.

!! Never use this configuration in production because it
opens the server to the world and provide access to JupyterLab
JavaScript objects through the global window variable.
"""
import json
import os
from tempfile import mkdtemp

from jupyterlab.commands import get_app_dir
from jupyterlab.galata import configure_jupyter_server

configure_jupyter_server(c)

# `or`, not a get() default: an exported-but-empty value must fall back too.
c.ServerApp.port = int(os.environ.get("JUPYTER_TEST_PORT") or "8888")

# The specs create this FIFO and read it, standing in for PulseAudio's module-pipe-source.
c.AudioCapture.sink_path = os.environ["VOICE_TEST_SINK"]

# The sandbox sees /opt/conda's dictation extension, whose frontend adds a pill item, a
# divider and a settings card the specs assert absent. JupyterLab reads page_config.json
# from app_settings_dir, so a scratch dir holding the disabling page config keeps that
# frontend out of the test lab without changing any assertion. The image's own page config
# is copied in first, so its overrides survive the move.
original_app_settings_dir = c.LabApp.get("app_settings_dir", "") or os.path.join(
    get_app_dir(), "settings"
)
app_settings_dir = mkdtemp(prefix="galata-app-settings-")
page_config = {}
original_page_config = os.path.join(original_app_settings_dir, "page_config.json")
if os.path.exists(original_page_config):
    with open(original_page_config, encoding="utf-8") as fp:
        page_config = json.load(fp)
disabled_extensions = page_config.get("disabledExtensions") or {}
if isinstance(disabled_extensions, list):
    disabled_extensions = dict.fromkeys(disabled_extensions, True)
disabled_extensions["@stellarshenson/jupyterlab-dictation-extension"] = True
page_config["disabledExtensions"] = disabled_extensions
with open(os.path.join(app_settings_dir, "page_config.json"), "w", encoding="utf-8") as fp:
    json.dump(page_config, fp)
c.LabApp.app_settings_dir = app_settings_dir

# /files/ from the test root, jupyter_server's default; a lab image may pin it to its own root.
c.ContentsManager.files_handler_params = {"path": c.ServerApp.root_dir}

# Uncomment to set server log level to debug level
# c.ServerApp.log_level = "DEBUG"
