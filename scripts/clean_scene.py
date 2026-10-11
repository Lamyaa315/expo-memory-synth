"""
Clean a Gaussian Splatting .ply: drop the blurry "floaters" around the subject.
Removes splats that are nearly transparent, oversized, or outside a sphere around the subject.
A quick alternative to cleaning by hand in SuperSplat.

The original is kept next to the output as <name>_full.ply, so you can rerun with other values.
--splat also writes a light copy (web/scene.splat, ~7x smaller) that the site loads first: much faster
on phones and small enough for GitHub Pages, without the view-dependent shine.

Example:
    python scripts/clean_scene.py web/scene.ply                  # defaults
    python scripts/clean_scene.py web/scene.ply --radius 2.5     # keep more of the surroundings
    python scripts/clean_scene.py web/scene.ply --center -0.77 0.8 0.06 --radius 1.3 --splat
    python scripts/clean_scene.py web/scene.ply --min any -0.9 any     # crop box: drop everything with y < -0.9
    python scripts/clean_scene.py web/scene.ply --near-cameras data/hall/sparse --near-radius 0.05
        # drop the blurry blobs training leaves right in front of the lens along the path you filmed
"""
import argparse
import shutil
from pathlib import Path

import numpy as np


def read_ply(path):
    with open(path, "rb") as f:
        header = b""
        while not header.endswith(b"end_header\n"):
            line = f.readline()
            if not line:
                raise SystemExit(f"{path} is not a PLY file")
            header += line
        text = header.decode("ascii")
        if "binary_little_endian" not in text:
            raise SystemExit("Only binary little-endian PLY is supported (the notebook's output). "
                             "Compressed PLY from SuperSplat is already cleaned: use the file from the notebook.")
        props = [l.split()[-1] for l in text.splitlines() if l.startswith("property")]
        if any(l.split()[1] != "float" for l in text.splitlines() if l.startswith("property")):
            raise SystemExit("Expected float properties only")
        count = int(next(l for l in text.splitlines() if l.startswith("element vertex")).split()[-1])
        data = np.fromfile(f, dtype="<f4", count=count * len(props)).reshape(count, len(props))
    return text, props, data


def write_ply(path, header, data):
    lines = [f"element vertex {len(data)}" if l.startswith("element vertex") else l for l in header.splitlines()]
    with open(path, "wb") as f:
        f.write(("\n".join(lines) + "\n").encode("ascii"))
        data.astype("<f4").tofile(f)


def write_splat(path, props, data):
    """antimatter15 .splat: 32 bytes per splat (position, size, RGBA, rotation), biggest splats first."""
    col = {name: i for i, name in enumerate(props)}
    xyz = data[:, [col["x"], col["y"], col["z"]]].astype("<f4")
    scale = np.exp(data[:, [col["scale_0"], col["scale_1"], col["scale_2"]]]).astype("<f4")
    rgb = 0.5 + 0.28209479177387814 * data[:, [col["f_dc_0"], col["f_dc_1"], col["f_dc_2"]]]
    alpha = 1 / (1 + np.exp(-data[:, col["opacity"]]))
    rgba = (np.clip(np.column_stack([rgb, alpha]), 0, 1) * 255).round().astype(np.uint8)
    q = data[:, [col["rot_0"], col["rot_1"], col["rot_2"], col["rot_3"]]]
    q = q / np.linalg.norm(q, axis=1, keepdims=True)
    rot = np.clip(q * 128 + 128, 0, 255).astype(np.uint8)
    order = np.argsort(-(scale.prod(axis=1) * alpha))
    rec = np.zeros(len(data), dtype=[("xyz", "<f4", 3), ("scale", "<f4", 3), ("rgba", "u1", 4), ("rot", "u1", 4)])
    rec["xyz"], rec["scale"], rec["rgba"], rec["rot"] = xyz[order], scale[order], rgba[order], rot[order]
    rec.tofile(path)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("ply", help="Scene to clean, e.g. web/scene.ply")
    p.add_argument("--radius", type=float, default=1.6,
                   help="Keep splats this far from the subject's center (scene units). Bigger = more surroundings")
    p.add_argument("--center", type=float, nargs=3, metavar=("X", "Y", "Z"),
                   help="Subject center. Default: the middle of the solid splats")
    p.add_argument("--min-opacity", type=float, default=0.1, help="Drop splats more transparent than this (0-1)")
    p.add_argument("--max-scale", type=float, default=99.0,
                   help="Drop the largest splats above this percentile of size (blurry streaks)")
    p.add_argument("--min", nargs=3, metavar=("X", "Y", "Z"), default=["any"] * 3,
                   help="Crop box: drop splats below these coordinates (\"any\" = no limit on that axis)")
    p.add_argument("--max", nargs=3, metavar=("X", "Y", "Z"), default=["any"] * 3,
                   help="Crop box: drop splats above these coordinates (\"any\" = no limit on that axis)")
    p.add_argument("--near-cameras", metavar="SPARSE",
                   help="COLMAP model folder (sparse/0): drop splats stuck to the camera path")
    p.add_argument("--near-radius", type=float, default=0.05,
                   help="How close to the camera path counts as stuck (scene units). Too big erases real pieces")
    p.add_argument("--splat", action="store_true", help="Also write a light .splat copy next to the output")
    args = p.parse_args()
    box_min = np.array([-np.inf if v == "any" else float(v) for v in args.min])
    box_max = np.array([np.inf if v == "any" else float(v) for v in args.max])

    src = Path(args.ply)
    full = src.with_name(src.stem + "_full.ply")
    if not full.exists():
        shutil.copy(src, full)          # keep the untouched original once
    header, props, data = read_ply(full)
    col = {name: i for i, name in enumerate(props)}

    xyz = data[:, [col["x"], col["y"], col["z"]]]
    opacity = 1 / (1 + np.exp(-data[:, col["opacity"]]))
    size = np.exp(data[:, [col["scale_0"], col["scale_1"], col["scale_2"]]]).max(axis=1)

    center = np.array(args.center) if args.center else np.median(xyz[opacity > 0.5], axis=0)
    keep = (
        (opacity >= args.min_opacity)
        & (size <= np.percentile(size, args.max_scale))
        & (np.linalg.norm(xyz - center, axis=1) <= args.radius)
        & np.all(xyz >= box_min, axis=1)
        & np.all(xyz <= box_max, axis=1)
    )
    if args.near_cameras:
        from scipy.spatial import cKDTree
        from camera_path import camera_positions
        dist, _ = cKDTree(camera_positions(args.near_cameras)).query(xyz)
        keep &= dist >= args.near_radius
    write_ply(src, header, data[keep])

    print(f"Center: {[round(float(c), 3) for c in center]}  radius: {args.radius}")
    print(f"Kept {keep.sum():,} of {len(data):,} splats ({keep.mean():.0%}). "
          f"{src} is now {src.stat().st_size / 1e6:.0f} MB. Original: {full}")
    if args.splat:
        light = src.with_suffix(".splat")
        write_splat(light, props, data[keep])
        print(f"Light copy: {light} ({light.stat().st_size / 1e6:.0f} MB). The site loads it before {src.name}.")


if __name__ == "__main__":
    main()
