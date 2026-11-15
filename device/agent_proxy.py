#!/usr/bin/env python3
"""
Trax agent proxy.

The phone app's AI agent calls Claude through this server, so the Anthropic API key stays
on this machine and is never bundled into the app. It forwards exactly one thing:
POST /v1/messages -> https://api.anthropic.com/v1/messages, adding the key.

It also turns speech into text for the app's microphone button: POST /v1/transcribe with a
short recording returns the words. That runs on this machine with the Whisper model (nothing
is sent anywhere), and needs one extra package:

    pip install faster-whisper     # already in device/.venv

Run (the key comes from your environment; it is never printed or logged):

    export ANTHROPIC_API_KEY=...            # in your own terminal
    export TRAX_PROXY_TOKEN=some-words      # optional: the app must send this to use the proxy
    device/.venv/bin/python device/agent_proxy.py

Then enter this machine's address and port 8787 in the app's Device tab, under AI agent.
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import re
import secrets
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
# Only Trax's own requests are forwarded: these models, and no huge answers.
ALLOWED_MODELS = {"claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"}
MAX_OUTPUT_TOKENS = 16000
# The password other devices on the network must send. Kept in a file beside this script so it
# survives restarts (and isn't committed); TRAX_PROXY_TOKEN overrides it.
# Speech to text. "base.en" is small and quick on a laptop; "small.en" is more accurate, slower.
WHISPER_MODEL = os.environ.get("TRAX_WHISPER_MODEL") or os.environ.get("VELO_WHISPER_MODEL") or "base.en"
MAX_AUDIO_BYTES = 8 * 1024 * 1024
# Words the model should expect, so "Trax" is not heard as "tracks".
SPEECH_HINT = "Trax. Arm the bike. Disarm the bike. Anything behind me? Show the rear camera."

TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".proxy-token")
LOCAL_ADDRESSES = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}


def proxy_token() -> str:
    token = (os.environ.get("TRAX_PROXY_TOKEN") or os.environ.get("VELO_PROXY_TOKEN") or "").strip()
    if token:
        return token
    try:
        with open(TOKEN_FILE) as file:
            token = file.read().strip()
    except OSError:
        token = ""
    if not token:
        token = f"trax-{secrets.randbelow(9000) + 1000}"
        with open(TOKEN_FILE, "w") as file:
            file.write(token + "\n")
    return token


TOKEN = ""

# ---- Push notifications -----------------------------------------------------------------
# The phone registers its push address and the bike's address; this server then watches the
# bike and pushes a notification when it is moved, so it reaches a locked phone.
EXPO_PUSH = "https://exp.host/--/api/v2/push/send"
WATCH_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".watch.json")
WATCH_EVERY_S = 1.5


class Watcher:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.token: str | None = None
        self.device: str | None = None
        self.seen: set[str] = set()
        self.primed = False
        try:
            with open(WATCH_FILE) as file:
                saved = json.load(file)
            self.token, self.device = saved.get("token"), saved.get("device")
        except (OSError, ValueError):
            pass
        threading.Thread(target=self._run, daemon=True).start()

    def register(self, token: str, device: str) -> None:
        with self.lock:
            if (token, device) != (self.token, self.device):
                self.token, self.device = token, device
                self.seen, self.primed = set(), False
                print("  Push notifications: watching the bike for this phone")
            try:
                with open(WATCH_FILE, "w") as file:
                    json.dump({"token": token, "device": device}, file)
            except OSError:
                pass

    def push(self, title: str, body: str, kind: str) -> str | None:
        """Sends a push notification. Returns None on success, or what went wrong."""
        token = self.token
        if not token:
            return "No phone has registered for push notifications yet."
        message = {
            "to": token, "title": title, "body": body, "sound": "default",
            "priority": "high", "interruptionLevel": "time-sensitive", "data": {"kind": kind},
        }
        request = urllib.request.Request(
            EXPO_PUSH, data=json.dumps(message).encode(), method="POST",
            headers={"content-type": "application/json", "accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                reply = json.loads(response.read())
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
            return f"Couldn't reach Expo's push service ({type(error).__name__})."
        ticket = (reply.get("data") or [{}])
        ticket = ticket[0] if isinstance(ticket, list) else ticket
        if ticket.get("status") == "ok":
            return None
        return str(ticket.get("message") or reply.get("errors") or "the push was refused")[:200]

    def _run(self) -> None:
        while True:
            time.sleep(WATCH_EVERY_S)
            with self.lock:
                device, token = self.device, self.token
            if not device or not token:
                continue
            try:
                with urllib.request.urlopen(f"{device}/state", timeout=3) as response:
                    state = json.loads(response.read())
            except (urllib.error.URLError, TimeoutError, OSError, ValueError):
                continue
            events = state.get("events") if isinstance(state, dict) else None
            if not isinstance(events, list):
                continue
            fresh = []
            with self.lock:
                for event in events:
                    if not isinstance(event, dict):
                        continue
                    key = f"{event.get('id')}@{event.get('ts')}"
                    if key not in self.seen:
                        self.seen.add(key)
                        if self.primed:
                            fresh.append(event)
                self.primed = True
            for event in fresh:
                if event.get("kind") == "tamper":
                    problem = self.push(
                        "Trax: bike moved",
                        "Your bike was moved and its alarm is sounding. Open Trax to see the camera.",
                        "tamper",
                    )
                    print(f"  Push notification -> {'sent' if not problem else 'not sent: ' + problem}")


WATCHER: Watcher | None = None


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

    def _authorised(self) -> bool:
        """This Mac (the iOS simulator) is trusted; anything else on the network needs the token."""
        if self.client_address[0] in LOCAL_ADDRESSES:
            return True
        sent = self.headers.get("x-api-key", "")
        if not sent:
            # The Anthropic SDK may send the key as a bearer token instead.
            bearer = self.headers.get("authorization", "")
            sent = bearer[7:].strip() if bearer.lower().startswith("bearer ") else ""
        try:
            return hmac.compare_digest(sent.encode(), TOKEN.encode())
        except Exception:
            return False

    def _length(self, limit: int) -> int | None:
        """The request's body length, or None if it is missing, unreadable or too large."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        return length if 0 < length <= limit else None

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            ready = bool(os.environ.get("ANTHROPIC_API_KEY"))
            speech = TRANSCRIBER.state if TRANSCRIBER else "off"
            self._send(200, json.dumps({"ok": True, "key_configured": ready, "speech": speech, "push": bool(WATCHER and WATCHER.token)}).encode())
        else:
            self._error(404, "not found")

    def _transcribe(self) -> None:
        started = time.time()
        if not self._authorised():
            return self._error(401, "Wrong proxy token. Check the token in the app's Device tab.")
        if TRANSCRIBER is None or TRANSCRIBER.state == "off":
            return self._error(501, "Speech to text is not set up on the proxy.")
        if TRANSCRIBER.state == "loading":
            return self._error(503, "The speech model is still loading. Try again in a moment.")
        length = self._length(MAX_AUDIO_BYTES)
        if length is None:
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

    def _watch(self) -> None:
        """POST /v1/watch {pushToken, device} registers this phone; {test: true} sends a test push."""
        if not self._authorised():
            return self._error(401, "Wrong proxy token. Check the token in the app's Device tab.")
        length = self._length(64 * 1024)
        try:
            message = json.loads(self.rfile.read(length)) if length else {}
        except ValueError:
            return self._error(400, "request body is not JSON")
        if not isinstance(message, dict) or WATCHER is None:
            return self._error(400, "request body is not an object")
        if message.get("test"):
            problem = WATCHER.push("Trax", "This is a test notification. Alerts will look like this.", "test")
            if problem:
                return self._error(502, problem)
            return self._send(200, json.dumps({"ok": True}).encode())
        token = str(message.get("pushToken") or "")
        device = str(message.get("device") or "").rstrip("/")
        if not re.match(r"^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,}\]$", token):
            return self._error(400, "not an Expo push token")
        if not re.match(r"^https?://[A-Za-z0-9.:\[\]-]{1,100}$", device):
            return self._error(400, "device must be the bike's address, like http://192.168.1.20:8000")
        WATCHER.register(token, device)
        self._send(200, json.dumps({"ok": True}).encode())

    def do_POST(self):
        started = time.time()
        if self.path.split("?")[0] == "/v1/watch":
            return self._watch()
        if self.path.split("?")[0] == "/v1/transcribe":
            return self._transcribe()
        if self.path.split("?")[0] != "/v1/messages":
            return self._error(404, "this proxy only handles POST /v1/messages, /v1/transcribe and /v1/watch")

        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            return self._error(503, "The proxy has no API key. Set ANTHROPIC_API_KEY and restart it.")

        if not self._authorised():
            return self._error(401, "Wrong proxy token. Check the token in the app's Device tab.")

        length = self._length(MAX_BODY_BYTES)
        if length is None:
            return self._error(413, "request body missing or too large")
        body = self.rfile.read(length)
        # Forward only what Trax itself would send, so the key can't be used for anything else.
        try:
            message = json.loads(body)
        except ValueError:
            return self._error(400, "request body is not JSON")
        if not isinstance(message, dict) or message.get("model") not in ALLOWED_MODELS:
            return self._error(400, "this proxy only forwards requests for Trax's models")
        if message.get("stream"):
            return self._error(400, "this proxy does not forward streaming requests")
        message["max_tokens"] = min(int(message.get("max_tokens") or 1024), MAX_OUTPUT_TOKENS)
        body = json.dumps(message).encode()

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
    parser = argparse.ArgumentParser(description="Trax agent proxy")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()

    global TRANSCRIBER, TOKEN, WATCHER
    TOKEN = proxy_token()
    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    server.daemon_threads = True
    print(f"Trax agent proxy on port {args.port}")
    address = lan_address()
    if address:
        print(f"  In the app's Device tab, AI agent address:  {address}:{args.port}")
    print(f"  From the iOS simulator on this Mac:           localhost:{args.port}")
    print("  API key: " + ("configured" if os.environ.get("ANTHROPIC_API_KEY") else "NOT SET (export ANTHROPIC_API_KEY, then restart)"))
    print(f"  Proxy token: {TOKEN}   (enter it in the app's Device tab on a phone; the simulator doesn't need it)")
    WATCHER = Watcher()
    if WATCHER.token:
        print("  Push notifications: watching the bike for the last registered phone")
    TRANSCRIBER = Transcriber()  # prints its own "Speech to text" line once the model has loaded
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
