"""
Text to speech for the site: Gemini's natural voices first (needs GEMINI_API_KEY), edge-tts as a backup.
Used by scripts/server.py (live answers) and scripts/make_audio.py (files for hotspots).

Settings (.env):
    GEMINI_TTS_MODEL   default gemini-3.8-flash-tts
    GEMINI_VOICE       default Algieba (male). Others: Kore (female), Charon (male, calm), Aoede, Leda...
    TTS_STYLE          how to read Arabic, default: a Saudi (Najdi) accent, like a friendly Saudi museum guide
    TTS_STYLE_EN       how to read English
    TTS_VOICE_AR / TTS_VOICE_EN   edge-tts backup voices
"""
import asyncio
import base64
import hashlib
import io
import os
import re
import tempfile
import time
import wave
from pathlib import Path

from gemini_client import generate

CACHE = Path(tempfile.gettempdir()) / "expo-memory-synth-tts"
DEFAULT_VOICE = "Algieba"
DEFAULT_STYLE = ("Read this in a natural Saudi Arabic accent (Najdi, from Riyadh), warm and calm, "
                 "like a friendly Saudi museum guide telling a visitor a story")
DEFAULT_STYLE_EN = "Read this in a warm, calm voice, like a museum guide telling a story to a visitor"


def _style(text):
    if re.search(r"[؀-ۿ]", text):
        return os.getenv("TTS_STYLE", DEFAULT_STYLE)
    return os.getenv("TTS_STYLE_EN", DEFAULT_STYLE_EN)


def engines():
    """Engines that can run here, best first."""
    out = []
    if os.getenv("GEMINI_API_KEY"):
        out.append("gemini")
    try:
        import edge_tts  # noqa: F401
        out.append("edge")
    except ImportError:
        pass
    return out


def _pcm_to_wav(pcm, rate=24000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def _gemini(text):
    model = os.getenv("GEMINI_TTS_MODEL", "gemini-3.8-flash-tts")
    voice = os.getenv("GEMINI_VOICE", DEFAULT_VOICE)
    style = _style(text)
    reply = generate(model, {
        "contents": [{"parts": [{"text": f"{style}:\n{text}"}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
        },
    })
    part = reply["candidates"][0]["content"]["parts"][0]["inlineData"]
    audio = base64.b64decode(part["data"])
    mime = part.get("mimeType", "")
    if audio[:4] == b"RIFF":
        return audio                                   # already a WAV file
    rate = int(re.search(r"rate=(\d+)", mime).group(1)) if "rate=" in mime else 24000
    return _pcm_to_wav(audio, rate)                    # raw 16-bit PCM


def _edge(text):
    import edge_tts
    arabic = re.search(r"[؀-ۿ]", text) is not None
    voice = os.getenv("TTS_VOICE_AR", "ar-SA-HamedNeural") if arabic else os.getenv("TTS_VOICE_EN", "en-US-AndrewNeural")
    fd, name = tempfile.mkstemp(suffix=".mp3")
    os.close(fd)                 # Windows: an open handle blocks edge-tts from writing the file
    path = Path(name)
    try:
        for attempt in range(4):
            try:
                asyncio.run(edge_tts.Communicate(text, voice, rate="-5%").save(str(path)))
                return path.read_bytes()
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2)
    finally:
        path.unlink(missing_ok=True)


def _gemini_patient(text, tries=4):
    """The free Gemini voice allows only a few clips a minute: wait as long as Google asks, then retry."""
    for attempt in range(tries):
        try:
            return _gemini(text)
        except Exception as e:
            msg = str(e)
            if "429" not in msg or "per day" in msg.lower() or attempt == tries - 1:
                raise
            m = re.search(r'retryDelay"?:\s*"(\d+)', msg)
            wait = int(m.group(1)) + 2 if m else 30
            print(f"  voice limit: waiting {wait}s")
            time.sleep(wait)


def synthesize(text, wait=False):
    """(audio bytes, mime type, file extension) for text. Cached on disk.
    wait=True (batch scripts): on Gemini's per-minute limit, wait and retry instead of falling back."""
    errors = []
    for engine in engines():
        voice = os.getenv("GEMINI_VOICE", DEFAULT_VOICE) if engine == "gemini" else os.getenv("TTS_VOICE_AR", "")
        ext, mime = (".wav", "audio/wav") if engine == "gemini" else (".mp3", "audio/mpeg")
        key = hashlib.sha1(f"{engine}|{voice}|{_style(text)}|{text}".encode("utf-8")).hexdigest()
        cached = CACHE / (key + ext)
        if cached.exists():
            return cached.read_bytes(), mime, ext
        try:
            if engine == "gemini":
                audio = _gemini_patient(text) if wait else _gemini(text)
            else:
                audio = _edge(text)
        except Exception as e:     # e.g. the free Gemini voice quota ran out: try the next engine
            errors.append(f"{engine}: {e}")
            continue
        CACHE.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(audio)
        return audio, mime, ext
    raise RuntimeError("; ".join(errors) or "no voice engine (set GEMINI_API_KEY or pip install edge-tts)")
