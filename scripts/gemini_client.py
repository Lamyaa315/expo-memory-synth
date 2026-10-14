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


def generate(model, payload, key=None, fallbacks=()):
    """POST models/<model>:generateContent and return the parsed JSON reply.
    When a model is busy (503) or over its limit (429), the next one in `fallbacks` answers instead of waiting."""
    global _conn
    key = key or os.environ["GEMINI_API_KEY"]
    body = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json", "x-goog-api-key": key}
    models = [model, *[m for m in fallbacks if m and m != model]]
    last = None
    with _lock:   # one request at a time over the shared connection
        for i, name in enumerate(models):
            busy = 0
            for attempt in range(TRIES):
                try:
                    if _conn is None:
                        _conn = _connect()
                    _conn.request("POST", f"/v1beta/models/{name}:generateContent", body, headers)
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
                if res.status in (429, 500, 503):
                    last = GeminiError(res.status, data)
                    busy += 1
                    has_next = i < len(models) - 1
                    if "PerDay" in data:                # used up for today: waiting won't help
                        if has_next:
                            break
                        raise last
                    if busy >= (2 if has_next else 4):
                        break                       # try the next model rather than keep waiting
                    time.sleep(2 if has_next else 3 + 2 * attempt)
                    continue
                last = GeminiError(res.status, data)
                if res.status in (400, 403, 404) and i < len(models) - 1:
                    break                           # this model can't take the request: try the next one
                raise last
    raise last or RuntimeError("Gemini request failed")


def text_of(reply):
    parts = reply.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    return "".join(p.get("text", "") for p in parts if not p.get("thought"))
