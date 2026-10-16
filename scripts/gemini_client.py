"""
Small Gemini API client that keeps HTTPS connections open and reuses them (one per server thread, so
Saad's answer never waits behind a voice clip or a translation being made at the same time).
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

_local = threading.local()   # .conn: this thread's open connection


class GeminiError(Exception):
    def __init__(self, status, body):
        super().__init__(f"Gemini {status}: {body[:300]}")
        self.status, self.body = status, body


def _connect():
    return http.client.HTTPSConnection(HOST, timeout=120, context=ssl.create_default_context())


def generate(model, payload, key=None, fallbacks=()):
    """POST models/<model>:generateContent and return the parsed JSON reply.
    When a model is busy (503) or over its limit (429), the next one in `fallbacks` answers instead of waiting."""
    key = key or os.environ["GEMINI_API_KEY"]
    headers = {"Content-Type": "application/json", "x-goog-api-key": key}
    models = [model, *[m for m in fallbacks if m and m != model]]
    last = None
    for i, name in enumerate(models):
        busy = 0
        sent = payload
        for attempt in range(TRIES):
            body = json.dumps(sent).encode("utf-8")
            try:
                if getattr(_local, "conn", None) is None:
                    _local.conn = _connect()
                _local.conn.request("POST", f"/v1beta/models/{name}:generateContent", body, headers)
                res = _local.conn.getresponse()
                data = res.read().decode("utf-8")
            except (OSError, http.client.HTTPException) as e:   # dropped or reset: open a new one and retry
                last = e
                if getattr(_local, "conn", None) is not None:
                    _local.conn.close()
                _local.conn = None
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
                if has_next:
                    break                           # another model answers now rather than wait for this one
                if busy >= 4:
                    raise last
                time.sleep(2 + 2 * attempt)
                continue
            last = GeminiError(res.status, data)
            config = sent.get("generationConfig", {})
            if res.status == 400 and "thinkingConfig" in config and "hink" in data:
                # this model doesn't take that thinking setting: ask it again without one
                sent = {**sent, "generationConfig": {k: v for k, v in config.items() if k != "thinkingConfig"}}
                continue
            if res.status in (400, 403, 404) and i < len(models) - 1:
                break                               # this model can't take the request: try the next one
            raise last
    raise last or RuntimeError("Gemini request failed")


def text_of(reply):
    parts = reply.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    return "".join(p.get("text", "") for p in parts if not p.get("thought"))
