"""
Write a hotspot's explanation from a photo of the museum's label (the plaque next to the piece).
The text sticks to what the label says, so the content stays accurate.

Updates the hotspot with that id in web/hotspots.json (place hotspots first with index.html?edit).

Example:
    export ANTHROPIC_API_KEY=sk-...
    python scripts/hotspot_text.py --id h1 --label data/labels/rock.jpg
    python scripts/hotspot_text.py --id h2 --label data/labels/stela.jpg --photo data/labels/stela_detail.jpg
"""
import argparse
import base64
import json
import os
from pathlib import Path

import anthropic

PROMPT = """You are writing a short spoken explanation for one piece in a museum, for visitors who
cannot travel to Riyadh. The first image is the museum's own label for this piece.{photo_note}

Rules:
- Use ONLY facts written on the label. Do not add dates, names, places or meanings that are not on it.
- If the label is unreadable or missing information, say less rather than guess.
- It will be read aloud: short sentences, no lists, no brackets, no abbreviations.

Return ONLY a JSON object (no markdown, no preamble) with these keys:
- "title": short Arabic title (2-5 words)
- "title_en": the same title in English
- "text_ar": 40-80 words in warm, natural Saudi dialect (the everyday Riyadh/Najdi way of speaking that any Arab understands), written in Arabic script
- "text_en": the same explanation in English
"""


def image_block(path: Path):
    media = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    return {"type": "image", "source": {"type": "base64", "media_type": media,
                                        "data": base64.b64encode(path.read_bytes()).decode()}}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--id", required=True, help="Hotspot id, e.g. h1 (shown in hotspots.json)")
    p.add_argument("--label", required=True, help="Photo of the museum label (.jpg/.png)")
    p.add_argument("--photo", help="Optional photo of the piece itself, for context")
    p.add_argument("--hotspots", default="web/hotspots.json")
    p.add_argument("--model", default=os.getenv("NARRATION_MODEL", "claude-sonnet-5-5"))
    args = p.parse_args()

    path = Path(args.hotspots)
    data = json.loads(path.read_text(encoding="utf-8"))
    spot = next((h for h in data.get("hotspots", []) if h.get("id") == args.id), None)
    if spot is None:
        ids = ", ".join(h.get("id", "?") for h in data.get("hotspots", [])) or "none"
        raise SystemExit(f"No hotspot with id {args.id}. Ids in {path}: {ids}")

    content = [image_block(Path(args.label))]
    if args.photo:
        content.append(image_block(Path(args.photo)))
    note = " The second image shows the piece itself; use it only to describe what is visible." if args.photo else ""
    content.append({"type": "text", "text": PROMPT.format(photo_note=note)})

    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY
    msg = client.messages.create(model=args.model, max_tokens=1200,
                                 messages=[{"role": "user", "content": content}])
    text = "".join(b.text for b in msg.content if b.type == "text")
    result = json.loads(text.replace("```json", "").replace("```", "").strip())

    for key in ("title", "title_en", "text_ar", "text_en"):
        if result.get(key):
            spot[key] = result[key]
    # The text changed, so any old audio no longer matches
    spot.pop("audio_ar", None)
    spot.pop("audio_en", None)

    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Updated {args.id} in {path}:")
    print(" ", spot.get("title"), "|", spot.get("title_en"))
    print(" ", spot.get("text_ar"))
    print("Next: python scripts/make_audio.py --hotspots")


if __name__ == "__main__":
    main()
