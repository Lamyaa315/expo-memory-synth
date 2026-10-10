"""
Local server for the web viewer, with "ask about this piece".
Serves web/ like `python -m http.server`, plus:
    GET  /api/health  -> {"ask": true} when an API key is set
    POST /api/ask     -> {"answer": "..."}
         body: {"id": "h1", "question": "...", "lang": "ar", "history": [{"role": "user"|"assistant", "content": "..."}]}

The API key stays here on the server, never in the page. It comes from ANTHROPIC_API_KEY
or from a .env file at the repo root (ANTHROPIC_API_KEY=sk-...).

Claude answers from the hotspot's text and "facts" in web/hotspots.json, plus an optional
photo of the piece at web/photos/<id>.jpg (or .png).

Run:
    python scripts/server.py            # http://localhost:8000
"""
import argparse
import base64
import json
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
MAX_QUESTION = 300
MAX_HISTORY = 12          # messages kept from the conversation (6 questions + 6 answers)
MAX_BODY = 32_000

SYSTEM = """You are a museum guide answering a remote visitor's questions about ONE piece in a museum in Riyadh.
The visitor is looking at a 3D scan of it and cannot travel there.

What the museum team wrote about this piece:
<piece>
{piece}
</piece>
{photo_note}
Rules:
- Answer in {language}, in 2-4 short sentences that sound natural when read aloud. No lists, no markdown, no emojis.
- Specific facts about THIS piece (date, origin, who made it, what it means) may only come from the information above.
- You may describe what is visible in the photo, and give widely known general background about this kind of object,
  but say clearly that it is general background and not information about this exact piece.
- If the answer is not available, say so plainly and suggest asking the museum staff. Never guess or invent details.
- If the question is not about the piece or the museum, answer briefly and gently bring the visitor back to the piece.
"""


def load_env():
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def find_hotspot(spot_id):
    data = json.loads((WEB / "hotspots.json").read_text(encoding="utf-8"))
    return next((h for h in data.get("hotspots", []) if h.get("id") == spot_id), None)


def piece_info(h):
    parts = [
        ("Title", h.get("title")), ("Title (English)", h.get("title_en")),
        ("Explanation", h.get("text_ar")), ("Explanation (English)", h.get("text_en")),
        ("Extra facts", h.get("facts")),
    ]
    lines = [f"{name}: {value.strip()}" for name, value in parts if value and value.strip()]
    return "\n".join(lines) or "(The team has not written anything about this piece yet.)"


def photo_block(spot_id):
    for ext, media in ((".jpg", "image/jpeg"), (".jpeg", "image/jpeg"), (".png", "image/png")):
        path = WEB / "photos" / f"{spot_id}{ext}"
        if path.exists():
            data = base64.b64encode(path.read_bytes()).decode()
            return {"type": "image", "source": {"type": "base64", "media_type": media, "data": data}}
    return None


def clean_history(history):
    if not isinstance(history, list):
        return []
    out = []
    for m in history[-MAX_HISTORY:]:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant"):
            continue
        content = str(m.get("content", ""))[:2000].strip()
        if not content:
            continue
        if out and out[-1]["role"] == m["role"]:
            continue  # keep turns alternating
        out.append({"role": m["role"], "content": content})
    while out and out[0]["role"] != "user":
        out.pop(0)
    if out and out[-1]["role"] == "user":
        out.pop()  # the new question is appended separately
    return out


class Handler(SimpleHTTPRequestHandler):
    client = None
    model = None

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/health":
            return self.send_json(200, {"ask": self.client is not None})
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/ask":
            return self.send_json(404, {"error": "not found"})
        if self.client is None:
            return self.send_json(503, {"error": "no_key"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > MAX_BODY:
                return self.send_json(413, {"error": "too_large"})
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self.send_json(400, {"error": "bad_json"})

        question = str(body.get("question", "")).strip()[:MAX_QUESTION]
        lang = "en" if body.get("lang") == "en" else "ar"
        spot = find_hotspot(str(body.get("id", "")))
        if not question or spot is None:
            return self.send_json(400, {"error": "missing_question_or_piece"})

        photo = photo_block(spot["id"])
        system = SYSTEM.format(
            piece=piece_info(spot),
            photo_note="A photo of the piece is attached to the first message.\n" if photo else "",
            language="English" if lang == "en" else "simple Modern Standard Arabic",
        )
        messages = clean_history(body.get("history")) + [{"role": "user", "content": question}]
        if photo:
            first = messages[0]
            first["content"] = [photo, {"type": "text", "text": first["content"]}]

        try:
            msg = self.client.messages.create(model=self.model, max_tokens=500, system=system, messages=messages)
        except Exception as e:  # network, auth, rate limit: the page shows a friendly message
            self.log_error("Claude request failed: %s", e)
            return self.send_json(502, {"error": "upstream"})
        answer = "".join(b.text for b in msg.content if b.type == "text").strip()
        return self.send_json(200, {"answer": answer})


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--model", default=os.getenv("NARRATION_MODEL", "claude-sonnet-5-5"))
    args = p.parse_args()

    load_env()
    Handler.model = args.model
    if os.getenv("ANTHROPIC_API_KEY"):
        import anthropic
        Handler.client = anthropic.Anthropic()
        print(f"Questions: on (model {args.model})")
    else:
        print("Questions: off. Set ANTHROPIC_API_KEY or put it in .env to turn them on.")

    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, directory=str(WEB)))
    print(f"Serving web/ at http://localhost:{args.port}  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
