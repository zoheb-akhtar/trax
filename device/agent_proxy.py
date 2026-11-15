#!/usr/bin/env python3
"""
Velo agent proxy.

The phone app's AI agent calls Claude through this server, so the Anthropic API key stays
on this machine and is never bundled into the app. It forwards exactly one thing:
POST /v1/messages -> https://api.anthropic.com/v1/messages, adding the key.

It also turns speech into text for the app's microphone button: POST /v1/transcribe with a
short recording returns the words. That runs on this machine with the Whisper model (nothing
is sent anywhere), and needs one extra package:

    pip install faster-whisper     # already in device/.venv

Run (the key comes from your environment; it is never printed or logged):

    export ANTHROPIC_API_KEY=...            # in your own terminal
    export VELO_PROXY_TOKEN=some-words      # optional: the app must send this to use the proxy
    device/.venv/bin/python device/agent_proxy.py

Then enter this machine's address and port 8787 in the app's Device tab, under AI agent.
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import socket
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = "https://api.anthropic.com/v1/messages"
DEFAULT_VERSION = "2023-06-01"
MAX_BODY_BYTES = 12 * 1024 * 1024  # room for one camera picture
UPSTREAM_TIMEOUT_S = 120

# Speech to text. "base.en" is small and quick on a laptop; "small.en" is more accurate, slower.
WHISPER_MODEL = os.environ.get("VELO_WHISPER_MODEL", "base.en")
MAX_AUDIO_BYTES = 8 * 1024 * 1024
# Words the model should expect, so "Velo" is not heard as "fellow".
SPEECH_HINT = "Velo. Arm the bike. Disarm the bike. Anything behind me? Show the rear camera."


class Transcriber:
    """Loads the Whisper model in the background and turns recordings into text."""

    def __init__(self) -> None:
        self.model = None
        self.problem: str | None = None
        self.lock = threading.Lock()
        threading.Thread(target=self._load, daemon=True).start()

    def _load(self) -> None:
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            self.problem = "faster-whisper is not installed (run the proxy with device/.venv/bin/python)"
            print(f"  Speech to text: off, {self.problem}")
            return
        try:
            self.model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
            print(f"  Speech to text: ready ({WHISPER_MODEL})")
        except Exception as error:  # e.g. the first-run model download failed
            self.problem = f"could not load the speech model ({type(error).__name__})"
            print(f"  Speech to text: off, {self.problem}")

    @property
    def state(self) -> str:
        return "ready" if self.model else ("off" if self.problem else "loading")

    def transcribe(self, audio: bytes) -> str:
        with tempfile.NamedTemporaryFile(suffix=".m4a") as file:
            file.write(audio)
            file.flush()
            with self.lock:  # one recording at a time
                segments, _ = self.model.transcribe(
                    file.name, language="en", beam_size=1, vad_filter=True, initial_prompt=SPEECH_HINT
                )
                return " ".join(segment.text.strip() for segment in segments).strip()


TRANSCRIBER: Transcriber | None = None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # request lines only; never bodies or headers
        pass

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def _send(self, status: int, body: bytes, content_type: str = "application/json", extra=None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        # Shaped like an Anthropic API error so the SDK in the app reports it cleanly.
        body = {"type": "error", "error": {"type": "proxy_error", "message": message}}
        # The request body may not have been read, so the connection cannot be reused:
        # the unread bytes would be taken for the start of the next request.
        self.close_connection = True
        self._send(status, json.dumps(body).encode(), extra={"Connection": "close"})
        print(f"{self.command} {self.path.split('?')[0]} -> {status} ({message})")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            ready = bool(os.environ.get("ANTHROPIC_API_KEY"))
            speech = TRANSCRIBER.state if TRANSCRIBER else "off"
            self._send(200, json.dumps({"ok": True, "key_configured": ready, "speech": speech}).encode())
        else:
            self._error(404, "not found")

    def _transcribe(self) -> None:
        started = time.time()
        token = os.environ.get("VELO_PROXY_TOKEN")
        if token and not hmac.compare_digest(self.headers.get("x-api-key", ""), token):
            return self._error(401, "Wrong proxy token. Check the token in the app's Device tab.")
        if TRANSCRIBER is None or TRANSCRIBER.state == "off":
            return self._error(501, "Speech to text is not set up on the proxy.")
        if TRANSCRIBER.state == "loading":
            return self._error(503, "The speech model is still loading. Try again in a moment.")
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_AUDIO_BYTES:
            return self._error(413, "recording missing or too large")
        audio = self.rfile.read(length)
        try:
            text = TRANSCRIBER.transcribe(audio)
        except Exception as error:  # an unreadable recording
            print(f"POST /v1/transcribe -> could not read the recording ({type(error).__name__})")
            return self._error(422, "The recording could not be read.")
        self._send(200, json.dumps({"text": text}).encode())
        # The words themselves are never logged.
        print(f"POST /v1/transcribe -> 200 in {time.time() - started:.1f}s ({len(audio)} bytes in)")

    def do_POST(self):
        started = time.time()
        if self.path.split("?")[0] == "/v1/transcribe":
            return self._transcribe()
        if self.path.split("?")[0] != "/v1/messages":
            return self._error(404, "this proxy only handles POST /v1/messages and POST /v1/transcribe")

        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            return self._error(503, "The proxy has no API key. Set ANTHROPIC_API_KEY and restart it.")

        token = os.environ.get("VELO_PROXY_TOKEN")
        if token and not hmac.compare_digest(self.headers.get("x-api-key", ""), token):
            return self._error(401, "Wrong proxy token. Check the token in the app's Device tab.")

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            return self._error(413, "request body missing or too large")
        body = self.rfile.read(length)

        headers = {
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": self.headers.get("anthropic-version", DEFAULT_VERSION),
        }
        if self.headers.get("anthropic-beta"):
            headers["anthropic-beta"] = self.headers["anthropic-beta"]

        request = urllib.request.Request(UPSTREAM, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT_S) as response:
                status, payload = response.status, response.read()
                reply_headers = response.headers
        except urllib.error.HTTPError as error:  # an API error: pass it through unchanged
            status, payload, reply_headers = error.code, error.read(), error.headers
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            print(f"POST /v1/messages -> upstream unreachable ({type(error).__name__})")
            return self._error(502, "The proxy could not reach the Anthropic API.")

        extra = {name: reply_headers[name] for name in ("request-id", "retry-after") if reply_headers.get(name)}
        self._send(status, payload, reply_headers.get("content-type", "application/json"), extra)
        print(f"POST /v1/messages -> {status} in {time.time() - started:.1f}s ({len(body)} bytes in)")


def lan_address() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # no packet is sent; just picks the outgoing interface
            return s.getsockname()[0]
    except OSError:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Velo agent proxy")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()

    global TRANSCRIBER
    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    server.daemon_threads = True
    print(f"Velo agent proxy on port {args.port}")
    address = lan_address()
    if address:
        print(f"  In the app's Device tab, AI agent address:  {address}:{args.port}")
    print(f"  From the iOS simulator on this Mac:           localhost:{args.port}")
    print("  API key: " + ("configured" if os.environ.get("ANTHROPIC_API_KEY") else "NOT SET (export ANTHROPIC_API_KEY, then restart)"))
    print("  Proxy token: " + ("required" if os.environ.get("VELO_PROXY_TOKEN") else "not set (anyone on this network can use the proxy)"))
    TRANSCRIBER = Transcriber()  # prints its own "Speech to text" line once the model has loaded
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
