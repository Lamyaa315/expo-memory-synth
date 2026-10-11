"""
Text to speech for the site: Gemini's natural voices first (needs GEMINI_API_KEY), edge-tts as a backup.
Used by scripts/server.py (live answers) and scripts/make_audio.py (files for hotspots).

Settings (.env):
    GEMINI_TTS_MODEL   default gemini-3.8-flash-tts
    GEMINI_VOICE       default Kore (female). Others: Charon (male, calm), Aoede, Puck, Zephyr...
    TTS_STYLE          how to read, e.g. "Read in a warm, calm voice, like a museum guide telling a story"
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
DEFAULT_STYLE = "Read this in a warm, calm voice, like a museum guide telling a story to a visitor"


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
    voice = os.getenv("GEMINI_VOICE", "Kore")
    style = os.getenv("TTS_STYLE", DEFAULT_STYLE)
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
    voice = os.getenv("TTS_VOICE_AR", "ar-SA-ZariyahNeural") if arabic else os.getenv("TTS_VOICE_EN", "en-US-AriaNeural")
    path = Path(tempfile.mkstemp(suffix=".mp3")[1])
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


def synthesize(text):
    """(audio bytes, mime type, file extension) for text. Cached on disk."""
    errors = []
    for engine in engines():
        voice = os.getenv("GEMINI_VOICE", "Kore") if engine == "gemini" else os.getenv("TTS_VOICE_AR", "")
        ext, mime = (".wav", "audio/wav") if engine == "gemini" else (".mp3", "audio/mpeg")
        key = hashlib.sha1(f"{engine}|{voice}|{os.getenv('TTS_STYLE', '')}|{text}".encode("utf-8")).hexdigest()
        cached = CACHE / (key + ext)
        if cached.exists():
            return cached.read_bytes(), mime, ext
        try:
            audio = _gemini(text) if engine == "gemini" else _edge(text)
        except Exception as e:     # e.g. the free Gemini voice quota ran out: try the next engine
            errors.append(f"{engine}: {e}")
            continue
        CACHE.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(audio)
        return audio, mime, ext
    raise RuntimeError("; ".join(errors) or "no voice engine (set GEMINI_API_KEY or pip install edge-tts)")
