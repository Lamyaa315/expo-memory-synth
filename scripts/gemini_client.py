"""
Small Gemini API client that keeps one HTTPS connection open and reuses it.
Some networks reset new connections to Google's AI endpoint now and then, but a connection that got
through stays up, so reusing it (and retrying on a fresh one when it drops) makes requests reliable.

    from gemini_client import generate
    reply = generate("gemini-flash-latest", {"contents": [...]})
"""
import http.client
import json
import os
import ssl
import threading
import time

HOST = "generativelanguage.googleapis.com"
TRIES = 8

_lock = threading.Lock()
_conn = None


class GeminiError(Exception):
    def __init__(self, status, body):
        super().__init__(f"Gemini {status}: {body[:300]}")
        self.status, self.body = status, body


def _connect():
    return http.client.HTTPSConnection(HOST, timeout=120, context=ssl.create_default_context())


def generate(model, payload, key=None):
    """POST models/<model>:generateContent and return the parsed JSON reply."""
    global _conn
    key = key or os.environ["GEMINI_API_KEY"]
    body = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json", "x-goog-api-key": key}
    last = None
    with _lock:   # one request at a time over the shared connection
        for attempt in range(TRIES):
            try:
                if _conn is None:
                    _conn = _connect()
                _conn.request("POST", f"/v1beta/models/{model}:generateContent", body, headers)
                res = _conn.getresponse()
                data = res.read().decode("utf-8")
            except (OSError, http.client.HTTPException) as e:   # dropped or reset: open a new one and retry
                last = e
                if _conn is not None:
                    _conn.close()
                _conn = None
                time.sleep(min(1 + attempt, 4))
                continue
            if res.status == 200:
                return json.loads(data)
            if res.status in (429, 500, 503) and attempt < TRIES - 1:
                last = GeminiError(res.status, data)
                time.sleep(3 + 2 * attempt)    # busy or rate-limited: wait a little longer
                continue
            raise GeminiError(res.status, data)
    raise last or RuntimeError("Gemini request failed")


def text_of(reply):
    parts = reply.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    return "".join(p.get("text", "") for p in parts if not p.get("thought"))
