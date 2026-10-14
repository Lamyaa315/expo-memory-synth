"""
Voice cloning for the trip film: the visitor records a short sample (with their consent) and the film's story is
read in their own voice. Runs XTTS-v2 (Coqui, non-commercial licence) on this computer, so the sample never
leaves it, and deletes the sample as soon as the clip is made.

It lives in its own environment because of its heavy dependencies:
    python -m venv .venv-voice
    .venv-voice\\Scripts\\python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
    .venv-voice\\Scripts\\python -m pip install coqui-tts

Run it next to scripts/server.py (which forwards /api/film/voice here):
    .venv-voice\\Scripts\\python scripts/voice_clone.py          # http://127.0.0.1:8765

The first start downloads the model (about 1.9 GB) and asks to accept its licence; set COQUI_TOS_AGREED=1 once
you have read it (https://coqui.ai/cpml).
"""
import argparse
import base64
import json
import os
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_TEXT = 1500           # characters of story
MAX_SAMPLE = 6_000_000    # bytes of WAV (about 30 s at 48 kHz)
# The languages XTTS-v2 speaks (the page's code -> the model's)
LANGS = {c: c for c in ("ar", "en", "es", "fr", "de", "it", "pt", "pl", "tr", "ru", "nl", "ja", "ko", "hi")} | {"zh": "zh-cn"}

tts = None
lock = threading.Lock()   # one clip at a time: the model is not thread safe and the CPU is busy anyway


def read_wav(path, *args, **kwargs):
    """torchaudio.load for the plain 16-bit WAV the page sends. Recent torchaudio reads audio through torchcodec,
    which needs FFmpeg's DLLs on Windows; a WAV doesn't need any of that."""
    import wave

    import numpy as np
    import torch
    with wave.open(str(path), "rb") as w:
        channels, rate = w.getnchannels(), w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
    return torch.from_numpy(pcm.reshape(-1, channels).T.copy()), rate


def load_model():
    global tts
    import torch
    import torchaudio
    torchaudio.load = read_wav
    from TTS.api import TTS
    # Laptop chips mix fast and slow cores: a thread per fast core is quicker than one per logical core
    torch.set_num_threads(int(os.getenv("VOICE_THREADS", "0")) or max(1, min(8, (os.cpu_count() or 4) // 2)))
    t = time.time()
    tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
    print(f"XTTS-v2 ready in {time.time() - t:.0f}s")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass   # no request logs: they would only show timings, but keep the console quiet

    def send(self, code, body, kind="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self.send(200, json.dumps({"ready": tts is not None}).encode())
        self.send(404, b"{}")

    def do_POST(self):
        if self.path != "/clone":
            return self.send(404, b"{}")
        if tts is None:
            return self.send(503, b'{"error": "loading"}')
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            text = str(body.get("text", "")).strip()[:MAX_TEXT]
            lang = LANGS.get(body.get("lang"), "ar")
            sample = base64.b64decode(body.get("sample", ""))
        except (ValueError, TypeError):
            return self.send(400, b'{"error": "bad_request"}')
        if not text or not sample.startswith(b"RIFF") or len(sample) > MAX_SAMPLE:
            return self.send(400, b'{"error": "missing_text_or_sample"}')

        folder = Path(tempfile.mkdtemp(prefix="film-voice-"))
        ref, out = folder / "sample.wav", folder / "story.wav"
        try:
            ref.write_bytes(sample)
            with lock:
                t = time.time()
                tts.tts_to_file(text=text, speaker_wav=str(ref), language=lang, file_path=str(out))
                print(f"clip: {len(text)} chars in {time.time() - t:.0f}s")
            audio = out.read_bytes()
        except Exception as e:   # noqa: BLE001 - report any model failure to the page
            print("clone failed:", e)
            return self.send(500, b'{"error": "clone_failed"}')
        finally:
            # The visitor's voice is not kept: sample and clip are deleted right away
            for f in (ref, out):
                f.unlink(missing_ok=True)
            folder.rmdir()
        self.send(200, audio, "audio/wav")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8765)
    args = p.parse_args()
    threading.Thread(target=load_model, daemon=True).start()   # answer /health while the model loads
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Voice cloning on http://127.0.0.1:{args.port} (model loading…)")
    server.serve_forever()


if __name__ == "__main__":
    main()
