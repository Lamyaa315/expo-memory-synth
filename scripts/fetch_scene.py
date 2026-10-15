"""The deployed site's 3D scene is in Git LFS. A host that checks out the repo without LFS gets small pointer
files instead; this replaces them with the real files from GitHub (used by the Dockerfile).

    python scripts/fetch_scene.py Lamyaa315/expo-memory-synth main
"""
import sys
import urllib.request
from pathlib import Path

FILES = ["web/scenes/corner/scene.splat", "web/scenes/corner/kingdoms.splat",
         "web/scenes/corner/scene-lite.splat", "web/scenes/corner/kingdoms-lite.splat"]   # -lite: for phones


def main(repo, ref):
    for rel in FILES:
        f = Path(rel)
        if f.exists() and f.stat().st_size > 1024:   # already the real file
            continue
        url = f"https://media.githubusercontent.com/media/{repo}/{ref}/{rel}"
        print("fetching", url)
        f.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(url, f)
        print(f"{rel}: {f.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main(*sys.argv[1:3])
