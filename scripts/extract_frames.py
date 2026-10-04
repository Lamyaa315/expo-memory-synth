"""
Extract frames from a capture video for 3D reconstruction.

Example:
    python scripts/extract_frames.py data/museum.mp4 --out data/scene/images --fps 3
    python scripts/extract_frames.py data/yt.mp4 --start 00:02:15 --end 00:02:45
"""
import argparse
import shutil
import subprocess
from pathlib import Path


def main():
    p = argparse.ArgumentParser(description="Video -> frames (needs ffmpeg)")
    p.add_argument("video", help="Path to the input video")
    p.add_argument("--out", default="data/scene/images", help="Output folder for frames")
    p.add_argument("--fps", type=float, default=3, help="Frames per second to keep (2-4 is usually enough)")
    p.add_argument("--width", type=int, default=1600, help="Max frame width in pixels")
    p.add_argument("--start", help="Start time, e.g. 00:02:15 (optional)")
    p.add_argument("--end", help="End time, e.g. 00:02:45 (optional)")
    args = p.parse_args()

    if shutil.which("ffmpeg") is None:
        raise SystemExit("ffmpeg not found. Install it first (Colab: apt-get install ffmpeg).")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if args.start:
        cmd += ["-ss", args.start]
    if args.end:
        cmd += ["-to", args.end]
    cmd += [
        "-i", args.video,
        "-vf", f"fps={args.fps},scale='min({args.width},iw)':-2",
        "-q:v", "2",
        str(out / "frame_%04d.jpg"),
    ]
    subprocess.run(cmd, check=True)

    n = len(list(out.glob("*.jpg")))
    print(f"Saved {n} frames to {out}")
    if n < 60:
        print("Tip: fewer than ~60 frames often makes COLMAP fail. Try a higher --fps or a longer clip.")
    if n > 300:
        print("Tip: more than ~300 frames slows COLMAP a lot on Colab. Try a lower --fps.")


if __name__ == "__main__":
    main()
