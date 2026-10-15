"""
Local server for the web viewer, with "ask about this piece", automatic descriptions and natural voices.
Serves web/ like `python -m http.server`, plus:
    GET  /api/health    -> {"ask": bool, "describe": bool, "tts": bool}
    POST /api/ask       -> {"answer": "..."}
         body: {"scene": "corner", "id": "h1", "question": "...", "lang": "ar", "history": [{"role": "user"|"assistant", "content": "..."}]}
    POST /api/describe  -> {"title", "title_en", "text_ar", "text_en", "label_text"}   (editor only)
         body: {"scene": "corner", "id": "h1", "image": "data:image/jpeg;base64,...", "label_image": "data:...", "notes": "..."}
         Also saves the view as web/scenes/<scene>/photos/<id>.jpg so answers can see the piece.
    "scene" is the pavilion folder in web/scenes/ (its hotspots.json); without it, web/ itself.
    POST /api/guide     -> {"answer": "..."}   the tour guide: questions about whatever the visitor is looking at
         body: {"scene": "corner", "scene_title": "...", "image": "data:image/jpeg;base64,...", "question": "...",
                "lang": "ar", "history": [...]}   (uses the view, labels visible in it, and the pavilion's hotspots)
    POST /api/film/story -> {"title", "story", "captions": [...]}   the trip film: the model looks at the visitor's
         photos and writes a short story in the first person (only with the visitor's consent)
         body: {"photos": ["data:image/jpeg;base64,...", ...], "place": "...", "name": "...", "lang": "ar", "consent": true}
    POST /api/film/voice -> audio/wav   the story read in the visitor's own voice (scripts/voice_clone.py, XTTS-v2)
         body: {"text": "...", "sample": "<base64 WAV>", "lang": "ar", "consent": true}
    POST /api/tour/say  -> {"say": ["...", ...]}   what the guide says at each tour stop (web/scenes/<id>/story.json),
         in the visitor's language. body: {"scene": "corner", "lang": "fr"}   (kept in memory once translated)
    POST /api/tts       -> audio/wav|mpeg  body: {"text": "...", "lang": "fr"}   (Gemini voices, edge-tts as backup: see tts.py)

Keys stay here on the server, never in the page. Put ONE of these in a .env file at the repo root:
    GEMINI_API_KEY=...        Google Gemini, free tier (key from https://aistudio.google.com/apikey); also the voice
    OPENROUTER_API_KEY=...    OpenRouter, free models (key from https://openrouter.ai/keys)
    ANTHROPIC_API_KEY=...     Claude (paid)
    LLM_BASE_URL=http://localhost:11434/v1   any OpenAI-compatible server, e.g. Ollama on this computer
Set LLM_PROVIDER=gemini|openrouter|claude|openai to choose when more than one is set.
Voice settings are in tts.py (GEMINI_VOICE, TTS_STYLE...).

Run:
    python scripts/server.py            # http://localhost:8000
"""
import argparse
import base64
import hashlib
import json
import os
import re
import tempfile
import time
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import gemini_client
import tts

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
MAX_QUESTION = 300
MAX_HISTORY = 12          # messages kept from the conversation (6 questions + 6 answers)
MAX_BODY = 32_000
MAX_DESCRIBE_BODY = 12_000_000
MAX_TTS_TEXT = 1500
MAX_ANSWER_TOKENS = 500
MAX_FILM_PHOTOS = 12
CLONE_URL = os.getenv("VOICE_CLONE_URL", "http://127.0.0.1:8765")   # scripts/voice_clone.py
SPOT_ID = re.compile(r"^h\d{1,4}$")
SCENE_ID = re.compile(r"^[a-z0-9_-]{1,32}$")

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

GUIDE = """You are a friendly tour guide in a museum in Riyadh, walking a remote visitor through the pavilion
"{scene_title}". The visitor cannot travel there and is looking at a 3D scan of it. The attached image is exactly
what they see right now (the edges of a scan can be blurry).

What the museum team wrote about this pavilion and its pieces (may be empty):
<pieces>
{pieces}
</pieces>

Rules:
- Answer in {language}, in 2-4 short sentences that sound natural when spoken. No lists, no markdown, no emojis.
- Work out which piece they mean: the one in the middle of the view, unless the question says otherwise.
- Facts about a specific piece (which civilization, how old, date, origin, who made it, what an inscription says)
  may only come from the team's notes above or from a museum label you can clearly read in the image.
- If neither has the answer, say plainly that you don't know it for sure. You may then add widely known general
  background about this kind of object, framed as general ("غالباً"، "عادةً في الجزيرة العربية"), never as a fact
  about this exact piece. Never guess numbers, dates, names or a civilization.
- Cultural links (this guide is about cultural heritage): when asked what a piece resembles, or when it helps, connect
  it to similar objects from other cultures that are widely known (for example inscribed stelae in Egypt, Aksum or
  Mesopotamia, Nabataean inscriptions, tombstones in Al-Andalus or Anatolia). Say what is alike (shape, purpose,
  script, carving) and what is different. Present it as a likeness between traditions, never as a proven link or
  shared origin, and use the pavilion notes for such links when they have them.
- If the piece is not clearly visible, say so and suggest moving to the next stop or tapping its point.
- If the question is not about the museum, answer briefly and gently bring the visitor back to the pieces.
"""

TOUR_SAY = """Translate what a friendly Saudi museum guide says at each stop of a tour into {language}.
Keep it warm, spoken and short, like he is talking to the visitor; keep names of places and civilizations.
Return ONLY a JSON array of strings, one per line below, same order and count.

{lines}
"""

FILM_STORY = """You help a visitor turn the photos of their visit into a short film they will keep as a memory.
The images are their photos, in the order they chose. Visit: {place}. The visitor's name: {name}.

Write the film's narration as the visitor, in the first person ("زرت…"، "وقفت قدام…"), as if they are telling a
friend about the day: warm, personal, a little poetic, and short enough to read aloud in about {seconds} seconds.
Follow the photos in order. Describe only what you can see and what the visitor plausibly felt; do not invent
names, dates, people or facts about the objects.

Return ONLY a JSON object (no markdown) with these keys:
- "title": a short film title (2-5 words)
- "story": the narration ({words} words at most), in {language}
- "captions": one short line per photo (3-7 words each), same order and count as the photos, in {language}
"""

DESCRIBE = """You are writing the spoken guide for ONE piece in a museum in Riyadh, for visitors who cannot travel there.
The first image is a view of the piece from its 3D scan.{label_note}

Notes from the museum team (may be empty):
<notes>
{notes}
</notes>

Write like a storyteller standing next to the visitor: warm, vivid, makes them look closer and feel curious.
Rules:
- Facts about this piece (dates, names, origin, meaning) may only come from the museum label or the notes.
- Without them, describe what is visible (shapes, carvings, material, colors, size) and you may add widely known general
  context, phrased as general ("غالباً"، "عادةً في الجزيرة العربية"), never as a fact about this exact piece.
- Never invent numbers, dates or names.
- It will be read aloud: short sentences, no lists, no brackets, no abbreviations, no emojis.

Return ONLY a JSON object (no markdown, no preamble) with these keys:
- "title": short Arabic title (2-5 words)
- "title_en": the same title in English
- "text_ar": 70-110 words of narration in warm, natural Saudi dialect (the everyday Riyadh/Najdi way of speaking that any Arab understands), written in Arabic script
- "text_en": the same narration in English
- "label_text": the text you can read on the museum label image, or "" if there is none
"""


# The languages the page offers (web/languages.js): the main languages of the countries taking part in Expo 2030
LANGUAGES = {
    "ar": "warm, natural Saudi dialect (the everyday Riyadh/Najdi way of speaking that any Arab understands), written in Arabic script",
    "en": "English", "fr": "French", "es": "Spanish", "pt": "Portuguese", "de": "German", "it": "Italian",
    "nl": "Dutch", "ru": "Russian", "uk": "Ukrainian", "pl": "Polish", "el": "Greek", "sv": "Swedish",
    "tr": "Turkish", "fa": "Persian (Farsi)", "ur": "Urdu", "hi": "Hindi", "bn": "Bengali",
    "zh": "Simplified Chinese", "ja": "Japanese", "ko": "Korean", "id": "Indonesian", "ms": "Malay", "th": "Thai",
    "vi": "Vietnamese", "fil": "Filipino (Tagalog)", "sw": "Swahili", "am": "Amharic", "so": "Somali",
    "uz": "Uzbek", "kk": "Kazakh",
}


TOUR_CACHE = Path(tempfile.gettempdir()) / "expo-memory-synth-tour"   # <hash>.json: the tour's lines in one language


def pick_lang(body):
    lang = str(body.get("lang", ""))
    return lang if lang in LANGUAGES else "ar"


def language_name(lang):
    if lang == "ar":
        return LANGUAGES["ar"]
    return f"{LANGUAGES[lang]} (the visitor chose this language: answer only in it, keep names of places in it too)"


def load_env():
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            value = value.strip().strip("'\"")
            if value:
                os.environ.setdefault(key.strip(), value)


def scene_dir(body):
    """web/scenes/<id>/ for the pavilion the request is about (web/ for a site without pavilions)."""
    scene = str(body.get("scene", ""))
    if SCENE_ID.match(scene) and (WEB / "scenes" / scene).is_dir():
        return WEB / "scenes" / scene
    return WEB


def find_hotspot(folder, spot_id):
    path = folder / "hotspots.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    return next((h for h in data.get("hotspots", []) if h.get("id") == spot_id), None)


def piece_info(h):
    parts = [
        ("Title", h.get("title")), ("Title (English)", h.get("title_en")),
        ("Explanation", h.get("text_ar")), ("Explanation (English)", h.get("text_en")),
        ("Extra facts", h.get("facts")),
    ]
    lines = [f"{name}: {value.strip()}" for name, value in parts if value and value.strip()]
    return "\n".join(lines) or "(The team has not written anything about this piece yet.)"


def find_photo(folder, spot_id):
    """(media_type, base64 data) of <scene folder>/photos/<id>.jpg|png, or None."""
    for ext, media in ((".jpg", "image/jpeg"), (".jpeg", "image/jpeg"), (".png", "image/png")):
        path = folder / "photos" / f"{spot_id}{ext}"
        if path.exists():
            return media, base64.b64encode(path.read_bytes()).decode()
    return None


def parse_data_url(url):
    """'data:image/jpeg;base64,....' -> (media_type, base64) or None."""
    m = re.match(r"^data:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$", str(url or ""))
    return (m.group(1), m.group(2)) if m else None


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


def clone_ready():
    """True when scripts/voice_clone.py is running and its model has loaded."""
    try:
        with urllib.request.urlopen(f"{CLONE_URL}/health", timeout=0.5) as res:
            return json.loads(res.read()).get("ready") is True
    except (OSError, ValueError):
        return False


def parse_json_reply(text):
    text = text.replace("```json", "").replace("```", "").strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON in reply")
    return json.loads(text[start:end + 1])


def post_json(url, payload, headers):
    data = json.dumps(payload).encode("utf-8")
    for attempt in range(3):   # some networks drop connections now and then
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", **headers}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=90) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < 2:
                time.sleep(2 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            if attempt < 2:
                time.sleep(1.5)
                continue
            raise


# ---------- Model providers ----------
# Each one takes the system prompt, alternating {"role", "content": str} messages ending with the
# question, and images [(media_type, base64)] attached to the first message. Returns the answer text.

class Claude:
    name = "Claude"

    def __init__(self):
        import anthropic
        self.client = anthropic.Anthropic()
        self.model = os.getenv("CLAUDE_MODEL", "claude-sonnet-5-5")

    def ask(self, system, messages, images=(), max_tokens=MAX_ANSWER_TOKENS):
        msgs = [dict(m) for m in messages]
        if images:
            blocks = [{"type": "image", "source": {"type": "base64", "media_type": t, "data": d}} for t, d in images]
            msgs[0]["content"] = blocks + [{"type": "text", "text": msgs[0]["content"]}]
        msg = self.client.messages.create(model=self.model, max_tokens=max_tokens, system=system, messages=msgs)
        return "".join(b.text for b in msg.content if b.type == "text")


class Gemini:
    name = "Gemini"

    def __init__(self):
        # "latest" follows Google's newest Flash model; set GEMINI_MODEL in .env to pin one
        self.model = os.getenv("GEMINI_MODEL", "gemini-flash-latest")
        # When that one is busy (it happens), these answer instead
        self.fallbacks = [m.strip() for m in os.getenv(
            "GEMINI_FALLBACK_MODELS", "gemini-3.8-flash,gemini-3.5-flash,gemini-flash-lite-latest").split(",")]
        self.name = f"Gemini {self.model}"

    def ask(self, system, messages, images=(), max_tokens=MAX_ANSWER_TOKENS):
        contents = [{"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]}
                    for m in messages]
        contents[0]["parts"][:0] = [{"inline_data": {"mime_type": t, "data": d}} for t, d in images]
        # Thinking models spend output tokens on thinking, so leave room for the answer itself
        res = gemini_client.generate(self.model, {
            "system_instruction": {"parts": [{"text": system}]},
            "contents": contents,
            "generationConfig": {"maxOutputTokens": max_tokens + 2000},
        }, fallbacks=self.fallbacks)
        return gemini_client.text_of(res)


class OpenAICompatible:
    """OpenRouter, Ollama, LM Studio, Groq... anything with /v1/chat/completions."""

    def __init__(self, base, model, key="", vision=False, headers=None, label=None):
        self.base, self.model, self.key, self.vision = base.rstrip("/"), model, key, vision
        self.headers = headers or {}
        self.name = label or f"{model} at {self.base}"

    def ask(self, system, messages, images=(), max_tokens=MAX_ANSWER_TOKENS):
        msgs = [{"role": "system", "content": system}] + [dict(m) for m in messages]
        if images and self.vision:
            msgs[1]["content"] = [{"type": "text", "text": msgs[1]["content"]}] + [
                {"type": "image_url", "image_url": {"url": f"data:{t};base64,{d}"}} for t, d in images]
        headers = {**self.headers, **({"Authorization": f"Bearer {self.key}"} if self.key else {})}
        res = post_json(f"{self.base}/chat/completions",
                        {"model": self.model, "messages": msgs, "max_tokens": max_tokens}, headers)
        if "error" in res:
            raise RuntimeError(res["error"])
        return res["choices"][0]["message"]["content"] or ""


def openrouter():
    model = os.getenv("OPENROUTER_MODEL", "google/gemma-4-31b-it:free")
    return OpenAICompatible("https://openrouter.ai/api/v1", model, os.environ["OPENROUTER_API_KEY"], vision=True,
                            headers={"X-Title": "Expo Memory Synth"}, label=f"OpenRouter {model}")


def local_llm():
    return OpenAICompatible(os.environ["LLM_BASE_URL"], os.getenv("LLM_MODEL", "qwen2.5:7b"),
                            os.getenv("LLM_API_KEY", ""), vision=os.getenv("LLM_VISION", "") == "1")


def pick_provider():
    options = {"gemini": ("GEMINI_API_KEY", Gemini), "openrouter": ("OPENROUTER_API_KEY", openrouter),
               "claude": ("ANTHROPIC_API_KEY", Claude), "openai": ("LLM_BASE_URL", local_llm)}
    choice = os.getenv("LLM_PROVIDER", "").lower()
    if choice in options:
        env, make = options[choice]
        return make() if os.getenv(env) else None
    for env, make in options.values():   # first one configured wins
        if os.getenv(env):
            return make()
    return None


class Handler(SimpleHTTPRequestHandler):
    provider = None
    tts = False

    def end_headers(self):
        # Make the browser check for a newer file every time (edits to scene-config.js, hotspots.json,
        # scene.ply show up on refresh). Unchanged files still come back as a quick 304.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self, limit):
        length = int(self.headers.get("Content-Length", 0))
        if length > limit:
            raise OverflowError
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        if self.path.split("?")[0] == "/api/health":
            on = self.provider is not None
            return self.send_json(200, {"ask": on, "describe": on, "guide": on, "tts": self.tts,
                                        "film_story": on, "clone": clone_ready()})
        return super().do_GET()

    def do_POST(self):
        route = {"/api/ask": self.ask, "/api/describe": self.describe, "/api/guide": self.guide,
                 "/api/film/story": self.film_story, "/api/film/voice": self.film_voice,
                 "/api/tour/say": self.tour_say, "/api/tts": self.speak}.get(self.path.split("?")[0])
        if route is None:
            return self.send_json(404, {"error": "not found"})
        try:
            big = route in (self.describe, self.guide, self.film_story, self.film_voice)   # pictures or a voice sample
            body = self.read_body(MAX_DESCRIBE_BODY if big else MAX_BODY)
        except OverflowError:
            return self.send_json(413, {"error": "too_large"})
        except (ValueError, json.JSONDecodeError):
            return self.send_json(400, {"error": "bad_json"})
        try:
            return route(body)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            self.log_error("%s request failed: %s %s", getattr(self.provider, "name", "model"), e.code, detail)
            return self.send_json(502, {"error": "upstream", "status": e.code})
        except gemini_client.GeminiError as e:
            self.log_error("Gemini failed: %s %s", e.status, e.body[:300])
            return self.send_json(502, {"error": "upstream", "status": e.status})
        except Exception as e:  # network, auth, rate limit, bad reply: the page shows a friendly message
            self.log_error("%s failed: %s: %s", self.path, type(e).__name__, e)
            return self.send_json(502, {"error": "upstream"})

    def ask(self, body):
        if self.provider is None:
            return self.send_json(503, {"error": "no_key"})
        question = str(body.get("question", "")).strip()[:MAX_QUESTION]
        lang = pick_lang(body)
        folder = scene_dir(body)
        spot = find_hotspot(folder, str(body.get("id", "")))
        if not question or spot is None:
            return self.send_json(400, {"error": "missing_question_or_piece"})

        photo = find_photo(folder, spot["id"])
        system = SYSTEM.format(
            piece=piece_info(spot),
            photo_note="A photo of the piece is attached to the first message.\n" if photo else "",
            language=language_name(lang),
        )
        messages = clean_history(body.get("history")) + [{"role": "user", "content": question}]
        answer = self.provider.ask(system, messages, [photo] if photo else []).strip()
        if not answer:
            return self.send_json(502, {"error": "empty"})
        return self.send_json(200, {"answer": answer})

    def guide(self, body):
        if self.provider is None:
            return self.send_json(503, {"error": "no_key"})
        question = str(body.get("question", "")).strip()[:MAX_QUESTION]
        view = parse_data_url(body.get("image"))   # may be missing: then he answers from the notes only
        if not question:
            return self.send_json(400, {"error": "missing_question"})
        lang = pick_lang(body)
        folder = scene_dir(body)
        try:
            spots = json.loads((folder / "hotspots.json").read_text(encoding="utf-8")).get("hotspots", [])
        except (OSError, ValueError):
            spots = []
        pieces = "\n\n".join(f"Piece {i + 1}:\n{piece_info(h)}" for i, h in enumerate(spots))
        try:   # notes about the whole pavilion (web/scenes/<id>/guide.json)
            notes = str(json.loads((folder / "guide.json").read_text(encoding="utf-8")).get("notes", "")).strip()
        except (OSError, ValueError, AttributeError):
            notes = ""
        if notes:
            pieces = f"About the pavilion:\n{notes[:6000]}" + (f"\n\n{pieces}" if pieces else "")
        system = GUIDE.format(
            scene_title=re.sub(r"[\r\n<>]", " ", str(body.get("scene_title", "")))[:80] or "the pavilion",
            pieces=pieces or "(nothing written yet)",
            language=language_name(lang),
        )
        messages = clean_history(body.get("history")) + [{"role": "user", "content": question}]
        answer = self.provider.ask(system, messages, [view] if view else []).strip()
        if not answer:
            return self.send_json(502, {"error": "empty"})
        return self.send_json(200, {"answer": answer})

    def tour_say(self, body):
        if self.provider is None:
            return self.send_json(503, {"error": "no_key"})
        lang = pick_lang(body)
        folder = scene_dir(body)
        try:
            stops = json.loads((folder / "story.json").read_text(encoding="utf-8")).get("stops", [])
        except (OSError, ValueError, AttributeError):
            stops = []
        lines = [str(s.get("say", "")).strip() for s in stops]
        if lang == "ar" or not any(lines):
            return self.send_json(200, {"say": lines})
        cached = TOUR_CACHE / (hashlib.sha1(f"{lang}|{'|'.join(lines)}".encode("utf-8")).hexdigest() + ".json")
        if cached.exists():
            return self.send_json(200, {"say": json.loads(cached.read_text(encoding="utf-8"))})
        prompt = TOUR_SAY.format(language=LANGUAGES[lang], lines="\n".join(f"{i + 1}. {t}" for i, t in enumerate(lines)))
        reply = self.provider.ask("You translate museum audio guides.", [{"role": "user", "content": prompt}],
                                  max_tokens=3000)
        m = re.search(r"\[.*\]", reply, re.S)
        said = json.loads(m.group(0)) if m else []
        if len(said) != len(lines):
            return self.send_json(502, {"error": "bad_translation"})
        said = [str(t).strip()[:MAX_TTS_TEXT] for t in said]
        TOUR_CACHE.mkdir(exist_ok=True)
        cached.write_text(json.dumps(said, ensure_ascii=False), encoding="utf-8")
        return self.send_json(200, {"say": said})

    def film_story(self, body):
        if self.provider is None:
            return self.send_json(503, {"error": "no_key"})
        if body.get("consent") is not True:   # the photos only go to the model if the visitor agreed
            return self.send_json(403, {"error": "no_consent"})
        photos = [v for v in (parse_data_url(u) for u in (body.get("photos") or [])[:MAX_FILM_PHOTOS]) if v]
        if not photos:
            return self.send_json(400, {"error": "missing_photos"})
        lang = pick_lang(body)
        clean = lambda v, n: re.sub(r"[\r\n<>]", " ", str(v or "")).strip()[:n]
        seconds = min(25, 8 + 3 * len(photos))   # short: the visitor's voice takes ~7x its length to make on a laptop
        prompt = FILM_STORY.format(
            place=clean(body.get("place"), 80) or "a museum in Riyadh", name=clean(body.get("name"), 30) or "(not given)",
            seconds=seconds, words=int(seconds * 2.2),
            language=language_name(lang))
        reply = self.provider.ask("You write short, warm travel-memory films.", [{"role": "user", "content": prompt}],
                                  photos, max_tokens=1500)
        try:
            result = parse_json_reply(reply)
        except ValueError:
            result = {"story": reply.strip()}
        captions = [str(c).strip()[:80] for c in (result.get("captions") or [])][:len(photos)]
        return self.send_json(200, {"title": str(result.get("title", "")).strip()[:60],
                                    "story": str(result.get("story", "")).strip()[:MAX_TTS_TEXT],
                                    "captions": captions})

    def film_voice(self, body):
        if body.get("consent") is not True:   # the visitor's voice is only used if they agreed
            return self.send_json(403, {"error": "no_consent"})
        text = str(body.get("text", "")).strip()[:MAX_TTS_TEXT]
        sample = str(body.get("sample", ""))
        if not text or not sample:
            return self.send_json(400, {"error": "missing_text_or_sample"})
        payload = json.dumps({"text": text, "sample": sample,
                              "lang": pick_lang(body)}).encode()
        req = urllib.request.Request(f"{CLONE_URL}/clone", data=payload, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=600) as res:   # a minute or two on a laptop CPU
                audio = res.read()
        except urllib.error.HTTPError as e:
            return self.send_json(502 if e.code >= 500 else e.code, {"error": "clone_failed"})
        except (urllib.error.URLError, OSError):
            return self.send_json(503, {"error": "clone_offline"})
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(audio)

    def describe(self, body):
        if self.provider is None:
            return self.send_json(503, {"error": "no_key"})
        spot_id = str(body.get("id", ""))
        view = parse_data_url(body.get("image"))
        if not SPOT_ID.match(spot_id) or view is None:
            return self.send_json(400, {"error": "missing_image"})
        label = parse_data_url(body.get("label_image"))
        notes = str(body.get("notes", "")).strip()[:4000]

        # Keep the view so answers to visitors' questions can see the piece too
        photos = scene_dir(body) / "photos"
        photos.mkdir(exist_ok=True)
        (photos / f"{spot_id}.jpg").write_bytes(base64.b64decode(view[1]))

        prompt = DESCRIBE.format(
            label_note=" The second image is the museum's label for this piece." if label else "",
            notes=notes or "(none)")
        images = [view] + ([label] if label else [])
        reply = self.provider.ask("You write museum audio guides.", [{"role": "user", "content": prompt}],
                                  images, max_tokens=1500)
        try:
            result = parse_json_reply(reply)
        except ValueError:
            result = {"text_ar": reply.strip()}   # model ignored the format: keep its text anyway
        keys = ("title", "title_en", "text_ar", "text_en", "label_text")
        return self.send_json(200, {k: str(result.get(k, "")).strip() for k in keys})

    def speak(self, body):
        if not self.tts:
            return self.send_json(503, {"error": "no_tts"})
        text = str(body.get("text", "")).strip()[:MAX_TTS_TEXT]
        if not text:
            return self.send_json(400, {"error": "missing_text"})
        audio, mime, _ = tts.synthesize(text, lang=pick_lang(body))
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(audio)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=int(os.getenv("PORT", "8000")))
    p.add_argument("--host", default=os.getenv("HOST", "127.0.0.1"),
                   help="0.0.0.0 on a host (Hugging Face Spaces, Docker); 127.0.0.1 keeps it on this computer")
    args = p.parse_args()

    load_env()
    Handler.provider = pick_provider()
    Handler.tts = bool(tts.engines())
    if Handler.provider:
        print(f"Questions + descriptions: on ({Handler.provider.name})")
    else:
        print("Questions: off. Put OPENROUTER_API_KEY (free), GEMINI_API_KEY, ANTHROPIC_API_KEY or LLM_BASE_URL in .env.")
    voices = {"gemini": f"Gemini {os.getenv('GEMINI_VOICE', 'Kore')}", "edge": "edge-tts"}
    print("Voice: " + " -> ".join(voices[e] for e in tts.engines()) if Handler.tts
          else "Voice: browser only (set GEMINI_API_KEY or pip install edge-tts)")

    server = ThreadingHTTPServer((args.host, args.port), partial(Handler, directory=str(WEB)))
    print(f"Serving web/ at http://localhost:{args.port}  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
