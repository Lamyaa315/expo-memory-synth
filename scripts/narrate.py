"""
Ask a vision LLM to describe the scene and write a cultural narration,
plus a text prompt for generating ambient sound.

Output: web/narration.json (read by the web viewer).

Example:
    export ANTHROPIC_API_KEY=sk-...
    python scripts/narrate.py data/scene/images --place "المتحف الوطني، الرياض"
"""
import argparse
import base64
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import anthropic

PROMPT = """You are a cultural guide for visitors who cannot travel to Riyadh.
These frames were captured by an on-site visitor at: {place}.

Return ONLY a JSON object (no markdown, no preamble) with these keys:
- "title": short Arabic title for this spot
- "narration_ar": 80-120 word narration in warm, natural Saudi dialect (the everyday Riyadh/Najdi way of speaking that any Arab understands), written in Arabic script,
   describing what the visitor sees and its cultural meaning. Only state what is
   visible or widely known; if unsure about a specific object, describe it generally.
- "narration_en": English version of the same narration
- "highlights": list of 3 short Arabic phrases naming things worth looking at
- "ambient_prompt": one English sentence describing the ambient soundscape
   that fits this place (for a text-to-audio model)
"""


def pick_frames(folder: Path, n: int):
    files = sorted([f for f in folder.iterdir() if f.suffix.lower() in {".jpg", ".jpeg", ".png"}])
    if not files:
        raise SystemExit(f"No images found in {folder}")
    if len(files) <= n:
        return files
    step = len(files) / n
    return [files[int(i * step)] for i in range(n)]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("images", help="Folder with frames")
    p.add_argument("--place", default="جناح تراثي في الرياض", help="Where the frames were captured")
    p.add_argument("--frames", type=int, default=5, help="How many frames to send")
    p.add_argument("--out", default="web/narration.json")
    p.add_argument("--model", default=os.getenv("NARRATION_MODEL", "claude-sonnet-5-5"))
    args = p.parse_args()

    content = []
    for f in pick_frames(Path(args.images), args.frames):
        media = "image/png" if f.suffix.lower() == ".png" else "image/jpeg"
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": media,
                       "data": base64.b64encode(f.read_bytes()).decode()},
        })
    content.append({"type": "text", "text": PROMPT.format(place=args.place)})

    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY
    msg = client.messages.create(model=args.model, max_tokens=1500,
                                 messages=[{"role": "user", "content": content}])
    text = "".join(b.text for b in msg.content if b.type == "text")
    text = text.replace("```json", "").replace("```", "").strip()
    data = json.loads(text)

    data["place"] = args.place
    data["captured_at"] = datetime.now(timezone.utc).isoformat(timespec="minutes")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved narration to {out}")
    print("Ambient prompt:", data.get("ambient_prompt"))


if __name__ == "__main__":
    main()
