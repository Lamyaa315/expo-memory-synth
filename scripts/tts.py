"""
Text to speech for the site: Gemini's natural voices first (needs GEMINI_API_KEY), edge-tts as a backup.
Used by scripts/server.py (live answers) and scripts/make_audio.py (files for hotspots).

Settings (.env):
    GEMINI_TTS_MODEL   default gemini-3.8-flash-tts
    GEMINI_VOICE       default Algieba (male). Others: Kore (female), Charon (male, calm), Aoede, Leda...
    GEMINI_TTS_FALLBACKS  voice models to use when the main one is over its daily quota (see TTS_FALLBACKS)
    TTS_STYLE          the accent line in the director's notes (default: Saudi Najdi for Arabic)
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


# Each voice model has its own small free quota (10 clips a day each): when one runs out, the next one speaks.
# They all have the same voices, so Saad sounds the same.
TTS_FALLBACKS = "gemini-3.8-flash-lite-tts,gemini-3.1-flash-tts-preview,gemini-2.5-flash-preview-tts,gemini-2.5-pro-preview-tts"

# How Saad sounds, as "director's notes" above a marked transcript: the model reads only the transcript.
# (A plain "Read this in a Saudi accent: ..." line before the words was sometimes read out loud.)
# For other languages the notes don't say "Saudi": the model then spoke English lines in Arabic. They say the
# language by name and forbid translating.
DIRECTED = """# AUDIO PROFILE: Saad
{profile}

### DIRECTOR'S NOTES
Language: {language}. Say the transcript exactly as written, word for word, in {language}. Never translate it.
Accent: {accent}
Style: warm, calm, talking to one visitor.
Read only the transcript below, nothing else.

#### TRANSCRIPT
{text}"""
PROFILE_AR = "A friendly young Saudi man from Riyadh, a museum guide."
PROFILE_OTHER = "A friendly young man, a museum guide, talking to a visitor in their own language."
ACCENT_AR = "natural Saudi Najdi (Riyadh) Arabic, never Modern Standard Arabic."
ACCENT_OTHER = "a natural native {language} speaker."
LANG_NAMES = {
    "ar": "Arabic", "en": "English", "fr": "French", "es": "Spanish", "pt": "Portuguese", "de": "German",
    "it": "Italian", "nl": "Dutch", "ru": "Russian", "uk": "Ukrainian", "pl": "Polish", "el": "Greek",
    "sv": "Swedish", "tr": "Turkish", "fa": "Persian", "ur": "Urdu", "hi": "Hindi", "bn": "Bengali",
    "zh": "Mandarin Chinese", "ja": "Japanese", "ko": "Korean", "id": "Indonesian", "ms": "Malay", "th": "Thai",
    "vi": "Vietnamese", "fil": "Filipino", "sw": "Swahili", "am": "Amharic", "so": "Somali", "uz": "Uzbek",
    "kk": "Kazakh",
}


def _gemini(text, lang=None):
    model = os.getenv("GEMINI_TTS_MODEL", "gemini-3.8-flash-tts")
    voice = os.getenv("GEMINI_VOICE", DEFAULT_VOICE)
    if lang not in LANG_NAMES:
        lang = "ar" if re.search(r"[؀-ۿ]", text) else "en"
    language = LANG_NAMES[lang]
    arabic = lang == "ar"
    prompt = DIRECTED.format(
        profile=PROFILE_AR if arabic else PROFILE_OTHER, language=language, text=text,
        accent=os.getenv("TTS_STYLE") or (ACCENT_AR if arabic else ACCENT_OTHER.format(language=language)))
    fallbacks = [m.strip() for m in os.getenv("GEMINI_TTS_FALLBACKS", TTS_FALLBACKS).split(",")]
    reply = generate(model, {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
        },
    }, fallbacks=fallbacks)
    part = reply["candidates"][0]["content"]["parts"][0]["inlineData"]
    audio = base64.b64decode(part["data"])
    mime = part.get("mimeType", "")
    if audio[:4] == b"RIFF":
        return audio                                   # already a WAV file
    rate = int(re.search(r"rate=(\d+)", mime).group(1)) if "rate=" in mime else 24000
    return _pcm_to_wav(audio, rate)                    # raw 16-bit PCM


# edge-tts backup voices (male, like Saad) for the languages the page offers
EDGE_VOICES = {
    "ar": "ar-SA-HamedNeural", "en": "en-US-AndrewNeural", "fr": "fr-FR-HenriNeural", "es": "es-ES-AlvaroNeural",
    "pt": "pt-BR-AntonioNeural", "de": "de-DE-ConradNeural", "it": "it-IT-DiegoNeural", "nl": "nl-NL-MaartenNeural",
    "ru": "ru-RU-DmitryNeural", "uk": "uk-UA-OstapNeural", "pl": "pl-PL-MarekNeural", "el": "el-GR-NestorasNeural",
    "sv": "sv-SE-MattiasNeural", "tr": "tr-TR-AhmetNeural", "fa": "fa-IR-FaridNeural", "ur": "ur-PK-AsadNeural",
    "hi": "hi-IN-MadhurNeural", "bn": "bn-BD-PradeepNeural", "zh": "zh-CN-YunxiNeural", "ja": "ja-JP-KeitaNeural",
    "ko": "ko-KR-InJoonNeural", "id": "id-ID-ArdiNeural", "ms": "ms-MY-OsmanNeural", "th": "th-TH-NiwatNeural",
    "vi": "vi-VN-NamMinhNeural", "fil": "fil-PH-AngeloNeural", "sw": "sw-KE-RafikiNeural", "am": "am-ET-AmehaNeural",
    "so": "so-SO-MuuseNeural", "uz": "uz-UZ-SardorNeural", "kk": "kk-KZ-DauletNeural",
}


def _edge(text, lang=None):
    import edge_tts
    if lang not in EDGE_VOICES:
        lang = "ar" if re.search(r"[؀-ۿ]", text) else "en"
    voice = {"ar": os.getenv("TTS_VOICE_AR"), "en": os.getenv("TTS_VOICE_EN")}.get(lang) or EDGE_VOICES[lang]
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


def _gemini_patient(text, lang=None, tries=4):
    """The free Gemini voice allows only a few clips a minute: wait as long as Google asks, then retry."""
    for attempt in range(tries):
        try:
            return _gemini(text, lang)
        except Exception as e:
            msg = str(e)
            if "429" not in msg or "per day" in msg.lower() or attempt == tries - 1:
                raise
            m = re.search(r'retryDelay"?:\s*"(\d+)', msg)
            wait = int(m.group(1)) + 2 if m else 30
            print(f"  voice limit: waiting {wait}s")
            time.sleep(wait)


def synthesize(text, wait=False, lang=None, only=None):
    """(audio bytes, mime type, file extension) for text. Cached on disk.
    wait=True (batch scripts): on Gemini's per-minute limit, wait and retry instead of falling back.
    only: the engines allowed (e.g. ["gemini"] so recorded clips all have Saad's voice)."""
    errors = []
    for engine in engines():
        if only and engine not in only:
            continue
        voice = os.getenv("GEMINI_VOICE", DEFAULT_VOICE) if engine == "gemini" else f"edge-{lang}"
        ext, mime = (".wav", "audio/wav") if engine == "gemini" else (".mp3", "audio/mpeg")
        key = hashlib.sha1(f"{engine}|{voice}|directed2|{lang}|{os.getenv('TTS_STYLE', '')}|{text}".encode("utf-8")).hexdigest()
        cached = CACHE / (key + ext)
        if cached.exists():
            return cached.read_bytes(), mime, ext
        try:
            if engine == "gemini":
                audio = _gemini_patient(text, lang) if wait else _gemini(text, lang)
            else:
                audio = _edge(text, lang)
        except Exception as e:     # e.g. the free Gemini voice quota ran out: try the next engine
            errors.append(f"{engine}: {e}")
            continue
        CACHE.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(audio)
        return audio, mime, ext
    raise RuntimeError("; ".join(errors) or "no voice engine (set GEMINI_API_KEY or pip install edge-tts)")
