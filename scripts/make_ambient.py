"""
Makes web/audio/ambient.wav: a soft music bed for the trip film (and the page's audio tour), 32 seconds that
loop without a seam. Warm chords with a light plucked melody in maqam Hijaz on D. No samples, no licence:
everything is synthesised here.

    python scripts/make_ambient.py
"""
import wave
from pathlib import Path

import numpy as np

RATE = 22050
LOOP = 32.0          # seconds; the tail past this is folded back onto the start, so the loop is seamless
OUT = Path("web/audio/ambient.wav")

t_total = LOOP + 6
n = int(RATE * t_total)
mix = np.zeros(n)
rng = np.random.default_rng(7)


def add(start, dur, wave_fn, gain):
    i0, i1 = int(start * RATE), int((start + dur) * RATE)
    t = np.arange(i1 - i0) / RATE
    mix[i0:i1] += gain * wave_fn(t)


def pad(freq):
    def f(t):
        dur = t[-1] if len(t) else 1
        env = np.minimum(1, t / 1.6) * np.minimum(1, (dur - t) / 2.2)
        tone = sum(np.sin(2 * np.pi * freq * (1 + d) * t) for d in (-0.003, 0, 0.003)) / 3
        return env * (tone + 0.25 * np.sin(2 * np.pi * freq * 2 * t))
    return f


def pluck(freq):
    def f(t):
        env = np.exp(-t * 5.5) * np.minimum(1, t / 0.004)
        return env * (np.sin(2 * np.pi * freq * t) + 0.35 * np.sin(2 * np.pi * freq * 2 * t) + 0.12 * np.sin(2 * np.pi * freq * 3 * t))
    return f


# four chords, 8 s each: D minor-ish, C, D (Hijaz colour, F#), Bb
chords = [[146.8, 220.0, 293.7], [130.8, 196.0, 261.6], [146.8, 185.0, 220.0], [116.5, 174.6, 233.1]]
for bar, chord in enumerate(chords):
    for f in chord:
        add(bar * 8, 9.5, pad(f), 0.10)

# D Hijaz: D Eb F# G A Bb C D
scale = [293.7, 311.1, 370.0, 392.0, 440.0, 466.2, 523.3, 587.3]
melody = [0, 2, 3, 4, None, 3, 2, 1, 0, None, 4, 5, 4, 3, None, 2, 3, 1, 0, None]
step = 0.8
for i in range(int(LOOP / step)):
    note = melody[i % len(melody)]
    if note is None or rng.random() < 0.15:
        continue
    add(i * step + rng.uniform(-0.02, 0.02), 1.6, pluck(scale[note]), 0.09)

# fold the tail onto the start, so the end flows into the beginning
loop = mix[: int(LOOP * RATE)].copy()
tail = mix[int(LOOP * RATE):]
loop[: len(tail)] += tail
loop /= np.max(np.abs(loop)) * 1.25          # headroom
pcm = (loop * 32767).astype("<i2")

OUT.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(OUT), "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(pcm.tobytes())
print(f"Saved {OUT} ({LOOP:.0f} s, {OUT.stat().st_size // 1024} KB)")
