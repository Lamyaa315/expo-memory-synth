"""
Cut the tour guide out of a picture with a plain green (or other flat) background, for web/guide.png.
The page shows web/guide.png instead of the drawn guide when the file exists (web/guide.js).

    python scripts/cutout.py guide_green.png                 # writes web/guide.png
    python scripts/cutout.py photo.jpg --key 255 255 255     # a flat white background instead of green
    python scripts/cutout.py guide.jpg --keep-inside         # he wears something green (a logo): keep it

Ask the image tool for "a perfectly flat, uniform pure chroma green (#00FF00) background": a white background
is harder, because the white thobe touches it.
"""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


def cutout(src, key, tolerance, height, keep_inside=False):
    im = np.asarray(Image.open(src).convert("RGB")).astype(np.float32)
    key = np.array(key, dtype=np.float32)
    green = key[1] > key[0] + 60 and key[1] > key[2] + 60
    if green:
        # Green screens from image tools are rarely flat (lighter top, darker floor, shadows), so key on how much
        # greener than red and blue a pixel is: white cloth, skin and black shoes are not, any shade of the screen is
        ratio = im[..., 1] / (np.maximum(im[..., 0], im[..., 2]) + 4)
        alpha = np.clip((1.45 - ratio) / 0.3, 0, 1)
    else:
        dist = np.sqrt(((im - key) ** 2).sum(axis=2))
        # soft edge: fully clear near the key colour, fully solid a little further away
        alpha = np.clip((dist - tolerance) / (tolerance * 0.6), 0, 1)
    near = np.ones(alpha.shape, bool)
    if green and keep_inside:
        # Only the screen goes, not green that is part of him (a logo on his badge or book). The screen is the
        # green touching the picture's edges, plus enclosed patches of the same light green (the gap between an
        # arm and the body). A logo's green is darker and stays solid, with its colour.
        from scipy import ndimage
        patches, n = ndimage.label(alpha < 0.5)
        edge = set(np.unique(np.concatenate([patches[0], patches[-1], patches[:, 0], patches[:, -1]]))) - {0}
        screen_colour = np.median(im[np.isin(patches, list(edge))], axis=0)
        ids = np.arange(1, n + 1)
        size = ndimage.sum(np.ones_like(patches), patches, ids)
        colour = np.stack([ndimage.mean(im[..., c], patches, ids) for c in range(3)], axis=1)
        alike = np.linalg.norm(colour - screen_colour, axis=1) < 30
        light = (size >= 100) & (colour[:, 1] > 95)
        is_screen = np.zeros(n + 1, bool)
        is_screen[ids] = alike | light
        is_screen[list(edge)] = True
        screen = is_screen[patches] & (patches > 0)
        alpha = np.where((patches > 0) & ~screen, 1.0, alpha)            # green that is part of him: keep
        near = np.asarray(Image.fromarray((screen * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(9))) > 0
    if green:
        # green spill on the edges of white cloth and hair: pull green down to the other channels
        g_max = np.maximum(im[..., 0], im[..., 2])
        im[..., 1] = np.where(near, np.minimum(im[..., 1], g_max + 12), im[..., 1])
    rgba = np.dstack([im, alpha * 255]).astype(np.uint8)
    out = Image.fromarray(rgba, "RGBA")
    a = out.getchannel("A").filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
    out.putalpha(a)
    box = out.getchannel("A").point(lambda v: 255 if v > 24 else 0).getbbox()
    if box:
        pad = 6
        out = out.crop((max(0, box[0] - pad), max(0, box[1] - pad),
                        min(out.width, box[2] + pad), min(out.height, box[3] + pad)))
    if out.height > height:
        out = out.resize((round(out.width * height / out.height), height), Image.LANCZOS)
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("image")
    p.add_argument("--out", default="web/guide.png")
    p.add_argument("--key", type=int, nargs=3, default=[0, 255, 0], metavar=("R", "G", "B"),
                   help="Background colour to remove (default pure green)")
    p.add_argument("--tolerance", type=float, default=90, help="How far from the key colour still counts as background")
    p.add_argument("--height", type=int, default=640, help="Largest height in pixels (the page shows it small)")
    p.add_argument("--keep-inside", action="store_true",
                   help="Remove only the green around him, not green parts of his clothes (a logo)")
    args = p.parse_args()
    out = cutout(args.image, args.key, args.tolerance, args.height, args.keep_inside)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    out.save(args.out, optimize=True)
    print(f"Saved {args.out} ({out.width}x{out.height}, {Path(args.out).stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
