"""
Turn the Arabic narration into speech (gTTS, free) for the web viewer.
Ambient sound: generate it from narration.json["ambient_prompt"] with any
text-to-audio tool (e.g. Stable Audio) and save it as web/audio/ambient.mp3.

Example:
    python scripts/make_audio.py
"""
import argparse
import json
from pathlib import Path

from gtts import gTTS


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--narration", default="web/narration.json")
    p.add_argument("--out", default="web/audio/narration.mp3")
    p.add_argument("--lang", default="ar", choices=["ar", "en"])
    args = p.parse_args()

    data = json.loads(Path(args.narration).read_text(encoding="utf-8"))
    text = data["narration_ar"] if args.lang == "ar" else data["narration_en"]

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    gTTS(text=text, lang=args.lang).save(str(out))
    print(f"Saved narration audio to {out}")

    ambient = out.parent / "ambient.mp3"
    if not ambient.exists():
        print("\nNo ambient.mp3 yet. Generate it from this prompt and save it to", ambient)
        print(" ->", data.get("ambient_prompt"))


if __name__ == "__main__":
    main()
