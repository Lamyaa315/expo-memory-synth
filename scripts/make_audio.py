"""
Turn the narration into speech for the web viewer, with the same voice as the site (see tts.py):
Gemini's natural voices when GEMINI_API_KEY is set (in .env), else edge-tts, else gTTS.
Pick another Gemini voice with GEMINI_VOICE in .env (e.g. Charon for a male voice).
Ambient sound: generate it from narration.json["ambient_prompt"] with any
text-to-audio tool (e.g. Stable Audio), or record 30 s of the real room,
and save it as web/audio/ambient.mp3.

Example:
    python scripts/make_audio.py              # the scene's narration
    python scripts/make_audio.py --hotspots --scene corner   # one clip per hotspot of a pavilion (Arabic + English)
    python scripts/make_audio.py --story --scene corner      # the guide's line at each tour stop (story.json)
"""
import argparse
import json
from pathlib import Path

import tts
from server import load_env


def say(text, lang, path):
    """Write the audio for text next to path (the extension follows the engine). Returns the file written."""
    try:
        audio, _, ext = tts.synthesize(text, wait=True)
        out = Path(path).with_suffix(ext)
        out.write_bytes(audio)
        return out
    except Exception as e:
        print(f"  natural voice failed ({e}), using gTTS")
    from gtts import gTTS
    out = Path(path).with_suffix(".mp3")
    gTTS(text=text, lang=lang).save(str(out))
    return out


def scene_narration(args):
    data = json.loads(Path(args.narration).read_text(encoding="utf-8"))
    text = data["narration_ar"] if args.lang == "ar" else data["narration_en"]

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out = say(text, args.lang, out)
    print(f"Saved narration audio to {out}")

    ambient = out.parent / "ambient.mp3"
    if not ambient.exists():
        print("\nNo ambient.mp3 yet. Generate it from this prompt and save it to", ambient)
        print(" ->", data.get("ambient_prompt"))


def hotspot_audio(args):
    path = Path(args.hotspots_file or f"web/scenes/{args.scene}/hotspots.json")
    web = Path("web")                              # audio paths are relative to the page (web/tour.html)
    data = json.loads(path.read_text(encoding="utf-8"))
    out_dir = path.parent / "audio" / "hotspots"   # next to the pavilion's hotspots.json
    out_dir.mkdir(parents=True, exist_ok=True)

    made = 0
    for h in data.get("hotspots", []):
        for lang, key in (("ar", "text_ar"), ("en", "text_en")):
            text = (h.get(key) or "").strip()
            field = f"audio_{lang}"
            if not text:
                h.pop(field, None)
                continue
            if h.get(field) and (web / h[field]).exists() and not args.force:
                continue  # already made for this text (editing the text in ?edit clears it)
            written = say(text, lang, out_dir / f"{h['id']}_{lang}")
            rel = written.resolve().relative_to(web.resolve()).as_posix()
            h[field] = rel
            made += 1
            print(f"  {h['id']} ({lang}) -> {rel}")

    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Made {made} clip(s). Updated {path}.")


def story_audio(args):
    """The guide's line at each stop of the automatic tour, in the site's natural voice. A stop whose clip can't
    be made keeps no "audio" and is spoken live instead (no robotic fallback voice here)."""
    path = Path(f"web/scenes/{args.scene}/story.json")
    web = Path("web")
    data = json.loads(path.read_text(encoding="utf-8"))
    out_dir = path.parent / "audio" / "story"
    out_dir.mkdir(parents=True, exist_ok=True)
    made = 0
    for i, stop in enumerate(data.get("stops", [])):
        text = (stop.get("say") or "").strip()
        if not text:
            stop.pop("audio", None)
            continue
        if stop.get("audio") and (web / stop["audio"]).exists() and not args.force:
            continue
        try:
            audio, _, ext = tts.synthesize(text, wait=True, only=["gemini"])   # one voice for the whole tour
        except Exception as e:
            print(f"  stop {i + 1}: no clip ({str(e)[:120]})")
            stop.pop("audio", None)
            continue
        out = out_dir / f"stop_{i + 1:02d}{ext}"
        for old in out_dir.glob(f"stop_{i + 1:02d}.*"):
            old.unlink()   # an older clip, maybe in another format
        out.write_bytes(audio)
        stop["audio"] = out.resolve().relative_to(web.resolve()).as_posix()
        made += 1
        print(f"  stop {i + 1} -> {stop['audio']}")
        path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")   # keep progress
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Made {made} clip(s). Updated {path}.")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--narration", default="web/narration.json")
    p.add_argument("--out", default="web/audio/narration.mp3")
    p.add_argument("--lang", default="ar", choices=["ar", "en"])
    p.add_argument("--hotspots", action="store_true", help="Make one clip per hotspot instead")
    p.add_argument("--story", action="store_true", help="Make the guide's clip for each tour stop (story.json)")
    p.add_argument("--scene", default="corner", help="Pavilion folder in web/scenes/ (see web/scene-config.js)")
    p.add_argument("--hotspots-file", help="Default: web/scenes/<scene>/hotspots.json")
    p.add_argument("--force", action="store_true", help="Remake hotspot clips that already exist")
    args = p.parse_args()
    load_env()

    if args.story:
        story_audio(args)
    elif args.hotspots:
        hotspot_audio(args)
    else:
        scene_narration(args)


if __name__ == "__main__":
    main()
