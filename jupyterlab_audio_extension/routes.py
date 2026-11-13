"""Server routes for the audio-capture extension.

Registers three authenticated endpoints under the Jupyter base URL: ``/stream`` receives
binary PCM frames from the browser and forwards them, in order, to the FIFO sink;
``/speaker`` sends the speaker FIFO's PCM to every listening tab; ``/player`` drives the
virtual player. No new externally exposed port is opened - the endpoints inherit Jupyter
token auth.
"""

import functools
import os
import stat

import tornado.web
from jupyter_server.auth.decorator import ws_authenticated
from jupyter_server.base.handlers import APIHandler, JupyterHandler
from jupyter_server.base.websocket import WebSocketMixin
from jupyter_server.utils import url_path_join
from tornado.ioloop import IOLoop
from tornado.routing import PathMatches, RuleRouter
from tornado.websocket import WebSocketClosedError, WebSocketHandler

from .speaker import STOP_MARKER_NAME

# Close code sent to a producer that a newer connection replaced (D3). The frontend stops
# capture on it instead of reconnecting, so two tabs never take the stream back and forth.
SUPERSEDED_CLOSE_CODE = 4001

# Close code (Going Away) sent to every connection when the extension unloads or loads
# again; the frontend reconnects on it, so tabs move to the new handlers.
RECONNECT_CLOSE_CODE = 1001

# Key of the set in web_app.settings that holds every open /stream and /speaker connection.
CONNECTIONS_KEY = "audio_capture_connections"

# 0.5 s of 48 kHz stereo s16le: while more than this waits unsent, new speaker data is dropped.
MAX_PENDING_SPEAKER_BYTES = 96000


class AudioCaptureWebSocketHandler(WebSocketMixin, WebSocketHandler, JupyterHandler):
    """Receives binary PCM frames and writes them to the FIFO sink.

    Auth is enforced by ``@ws_authenticated`` on ``get`` (C1). Only one producer streams
    at a time: a new connection takes over and closes the previous one (last-writer-wins,
    D3).
    """

    # Class-level reference to the currently streaming handler (single producer).
    _active: "AudioCaptureWebSocketHandler | None" = None

    def initialize(self, sink=None):
        self._sink = sink

    def set_default_headers(self):
        """Undo JupyterHandler's default headers, which are meaningless for websockets."""

    @ws_authenticated
    async def get(self, *args, **kwargs):
        return await super().get(*args, **kwargs)

    def open(self, *args, **kwargs):
        # Last-writer takeover (D3): close any existing producer before taking over.
        existing = AudioCaptureWebSocketHandler._active
        if existing is not None and existing is not self:
            try:
                existing.close(SUPERSEDED_CLOSE_CODE, "superseded by a new producer")
            except Exception:  # noqa: BLE001 - never let a stale socket block the new one
                pass
        AudioCaptureWebSocketHandler._active = self
        self.settings[CONNECTIONS_KEY].add(self)
        # super().open() starts the keep-alive ping-pong loop (WebSocketMixin).
        super().open()
        self.log.info("audio-capture: producer connected")

    def on_message(self, message):
        # Only binary PCM frames are expected (B4); ignore any text message.
        if isinstance(message, (bytes, bytearray, memoryview)) and self._sink is not None:
            self._sink.write(bytes(message))

    def on_close(self):
        if AudioCaptureWebSocketHandler._active is self:
            AudioCaptureWebSocketHandler._active = None
        self.settings[CONNECTIONS_KEY].discard(self)
        self.log.info("audio-capture: producer disconnected")


class SpeakerWebSocketHandler(WebSocketMixin, WebSocketHandler, JupyterHandler):
    """Sends the speaker FIFO's PCM to every listening tab as binary messages.

    Every connection listens; none closes another, and none closes a /stream producer.
    """

    # Connected listeners; touched only on the IOLoop.
    _listeners: "set[SpeakerWebSocketHandler]" = set()

    def initialize(self, reader):
        self._reader = reader
        self._pending = 0  # bytes in unfinished write_message futures

    def set_default_headers(self):
        """Undo JupyterHandler's default headers, which are meaningless for websockets."""

    @ws_authenticated
    async def get(self, *args, **kwargs):
        return await super().get(*args, **kwargs)

    def open(self, *args, **kwargs):
        SpeakerWebSocketHandler._listeners.add(self)
        self.settings[CONNECTIONS_KEY].add(self)
        loop = IOLoop.current()
        # Runs on the reader thread; write_message must run on the IOLoop.
        self._reader.listener = lambda data: loop.add_callback(self._broadcast, data)
        super().open()
        self.log.info("audio-capture: speaker listener connected")

    @classmethod
    def _broadcast(cls, data):
        for listener in cls._listeners:
            listener._send(data)

    def _send(self, data):
        if self._pending > MAX_PENDING_SPEAKER_BYTES:
            return
        try:
            future = self.write_message(data, binary=True)
        except WebSocketClosedError:
            return
        self._pending += len(data)
        future.add_done_callback(functools.partial(self._sent, len(data)))

    def _sent(self, size, future):
        self._pending -= size
        if not future.cancelled():
            future.exception()  # retrieve a closed-stream error so asyncio does not log it

    def on_message(self, message):
        pass  # the tab only listens

    def on_close(self):
        SpeakerWebSocketHandler._listeners.discard(self)
        self.settings[CONNECTIONS_KEY].discard(self)
        if not SpeakerWebSocketHandler._listeners:
            self._reader.listener = None
        self.log.info("audio-capture: speaker listener disconnected")


class PlayerHandler(APIHandler):
    """Drives the virtual player: one authenticated POST with a JSON body.

    The body is ``{action, mode?, path?}`` and the answer is the JSON player state. A
    refused request answers 400 with a message naming the problem.
    """

    def initialize(self, player=None, speaker=None):
        self._player = player
        self._speaker = speaker

    @tornado.web.authenticated
    async def post(self, *args, **kwargs):
        body = self.get_json_body() or {}
        if not isinstance(body, dict):
            raise tornado.web.HTTPError(400, "The player request must be a JSON object")
        action = body.get("action")
        try:
            if action == "play":
                # play() waits START_GRACE_S on paplay; off the loop, the sockets keep moving.
                state = await IOLoop.current().run_in_executor(
                    None, self._player.play, body.get("path"), body.get("mode", "queue")
                )
            elif action in ("pause", "resume", "stop", "clear", "status"):
                state = getattr(self._player, action)()
            else:
                raise ValueError(f"Unknown action {action!r}")
        except ValueError as exc:
            raise tornado.web.HTTPError(400, str(exc)) from exc
        state["sink"] = _sink_state(self._speaker.path)
        self.write(state)


def _sink_state(path):
    """Report the speaker sink: off after a stop, ready for a FIFO, missing otherwise."""
    if os.path.exists(os.path.join(os.path.dirname(path), STOP_MARKER_NAME)):
        return {"state": "off"}
    try:
        mode = os.stat(path).st_mode
    except OSError:
        return {"state": "missing"}
    if not stat.S_ISFIFO(mode):
        return {"state": "missing"}
    return {"state": "ready"}


def _remove_previous_routes(web_app, prefix):
    """Remove the rules a previous load added under prefix; a soft reload leaves them behind
    the new ones. First close the producer a removed handler class still holds, so its tab
    reconnects: 1.0.18 keeps it only in the class attribute _active, not in the settings."""
    for router in (web_app.default_router, web_app.wildcard_router):
        for host_rule in list(router.rules):
            rules = host_rule.target.rules if isinstance(host_rule.target, RuleRouter) else []
            old = [
                rule
                for rule in rules
                if isinstance(rule.matcher, PathMatches)
                and rule.matcher.regex.pattern.startswith(prefix)
            ]
            for rule in old:
                active = getattr(rule.target, "_active", None)
                if active is not None:
                    active.close(RECONNECT_CLOSE_CODE, "audio-capture server extension closed")
                rules.remove(rule)
            if old and not rules:
                router.rules.remove(host_rule)


def setup_route_handlers(web_app, sink, reader, player):
    host_pattern = ".*$"
    base_url = web_app.settings["base_url"]

    _remove_previous_routes(
        web_app, url_path_join(base_url, "jupyterlab-audio-extension") + "/"
    )
    _remove_previous_routes(
        web_app, url_path_join(base_url, "jupyterlab-voice-capture-extension") + "/"
    )
    stream_route = url_path_join(
        base_url, "jupyterlab-audio-extension", "stream"
    )
    speaker_route = url_path_join(
        base_url, "jupyterlab-audio-extension", "speaker"
    )
    player_route = url_path_join(
        base_url, "jupyterlab-audio-extension", "player"
    )
    handlers = [
        (stream_route, AudioCaptureWebSocketHandler, {"sink": sink}),
        (speaker_route, SpeakerWebSocketHandler, {"reader": reader}),
        (player_route, PlayerHandler, {"player": player, "speaker": reader}),
    ]
    web_app.add_handlers(host_pattern, handlers)
