"""
Turn the walk you filmed into a guided tour for the site.
Reads COLMAP's camera positions (sparse/0 from the notebook) and puts them in the same space as the
trained scene (gsplat normalizes the world before training), then writes web/tour.json: stops along
the path you walked, each with where the phone was and what it was looking at.
The scene looks sharp from these spots, because that's where the photos were taken.

With several videos (the notebook puts each in its own folder: v1/, v2/... and photos/), the tour follows
the longest walk; pick another with --video v2. Each stop uses the sharpest frame around it (the one
COLMAP matched the most points in).

Example:
    python scripts/camera_path.py data/hall/sparse           # ~16 stops
    python scripts/camera_path.py data/hall/sparse --stops 24 --video v2
"""
import argparse
import json
import struct
from pathlib import Path

import numpy as np

# COLMAP camera model id -> number of parameters
CAMERA_PARAMS = {0: 3, 1: 4, 2: 4, 3: 5, 4: 8, 5: 8, 6: 12, 7: 5, 8: 4, 9: 5, 10: 12}


def read_cameras(path):
    cams = {}
    with open(path, "rb") as f:
        for _ in range(struct.unpack("<Q", f.read(8))[0]):
            cam_id, model = struct.unpack("<ii", f.read(8))
            width, height = struct.unpack("<QQ", f.read(16))
            params = struct.unpack(f"<{CAMERA_PARAMS[model]}d", f.read(8 * CAMERA_PARAMS[model]))
            cams[cam_id] = {"model": model, "width": width, "height": height, "params": params}
    return cams


def read_images(path):
    """[{name, qvec, tvec, point3D_ids}] in file order."""
    images = []
    with open(path, "rb") as f:
        for _ in range(struct.unpack("<Q", f.read(8))[0]):
            image_id = struct.unpack("<i", f.read(4))[0]
            qvec = np.array(struct.unpack("<4d", f.read(32)))
            tvec = np.array(struct.unpack("<3d", f.read(24)))
            camera_id = struct.unpack("<i", f.read(4))[0]
            name = b""
            while (ch := f.read(1)) != b"\x00":
                name += ch
            n = struct.unpack("<Q", f.read(8))[0]
            pts = np.frombuffer(f.read(24 * n), dtype=[("x", "<f8"), ("y", "<f8"), ("id", "<i8")])
            images.append({"id": image_id, "name": name.decode(), "camera_id": camera_id, "qvec": qvec, "tvec": tvec,
                           "point3D_ids": pts["id"][pts["id"] >= 0]})
    return images


def read_points(path):
    """(ids, xyz) of all 3D points."""
    ids, xyz = [], []
    with open(path, "rb") as f:
        for _ in range(struct.unpack("<Q", f.read(8))[0]):
            pid = struct.unpack("<Q", f.read(8))[0]
            xyz.append(struct.unpack("<3d", f.read(24)))
            f.read(3 + 8)                                     # rgb, error
            track = struct.unpack("<Q", f.read(8))[0]
            f.read(8 * track)                                 # (image id, point2D idx) pairs
            ids.append(pid)
    return np.array(ids), np.array(xyz)


def qvec_to_rotmat(q):
    w, x, y, z = q
    return np.array([
        [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * z * x + 2 * w * y],
        [2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x],
        [2 * z * x - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y],
    ])


# ---- Same world normalization as gsplat 1.5.3 (examples/datasets/normalize.py, colmap.py) ----
def similarity_from_cameras(c2w):
    t, R = c2w[:, :3, 3], c2w[:, :3, :3]
    ups = np.sum(R * np.array([0, -1.0, 0]), axis=-1)
    world_up = np.mean(ups, axis=0)
    world_up /= np.linalg.norm(world_up)
    up_camspace = np.array([0.0, -1.0, 0.0])
    c = (up_camspace * world_up).sum()
    cross = np.cross(world_up, up_camspace)
    skew = np.array([[0.0, -cross[2], cross[1]], [cross[2], 0.0, -cross[0]], [-cross[1], cross[0], 0.0]])
    R_align = np.eye(3) + skew + (skew @ skew) / (1 + c) if c > -1 else np.diag([-1.0, 1.0, 1.0])
    R = R_align @ R
    fwds = np.sum(R * np.array([0, 0.0, 1.0]), axis=-1)
    t = (R_align @ t[..., None])[..., 0]
    nearest = t + (fwds * -t).sum(-1)[:, None] * fwds
    translate = -np.median(nearest, axis=0)
    transform = np.eye(4)
    transform[:3, 3] = translate
    transform[:3, :3] = R_align
    transform[:3, :] *= 1.0 / np.median(np.linalg.norm(t + translate, axis=-1))
    return transform


def align_principal_axes(points):
    centroid = np.median(points, axis=0)
    values, vectors = np.linalg.eigh(np.cov(points - centroid, rowvar=False))
    vectors = vectors[:, values.argsort()[::-1]]
    if np.linalg.det(vectors) < 0:
        vectors[:, 0] *= -1
    transform = np.eye(4)
    transform[:3, :3] = vectors.T
    transform[:3, 3] = -vectors.T @ centroid
    return transform


def transform_points(m, p):
    return p @ m[:3, :3].T + m[:3, 3]


def transform_cameras(m, c2w):
    c2w = np.einsum("nij, ki -> nkj", c2w, m)
    scale = np.linalg.norm(c2w[:, 0, :3], axis=1)
    c2w[:, :3, :3] /= scale[:, None, None]
    return c2w


def normalize(c2w, points):
    T1 = similarity_from_cameras(c2w)
    c2w, points = transform_cameras(T1, c2w), transform_points(T1, points)
    T2 = align_principal_axes(points)
    c2w, points = transform_cameras(T2, c2w), transform_points(T2, points)
    if np.median(points[:, 2]) > np.mean(points[:, 2]):    # gsplat's upside-down fix
        T3 = np.diag([1.0, -1.0, -1.0, 1.0])
        c2w, points = transform_cameras(T3, c2w), transform_points(T3, points)
    return c2w, points


def load(sparse):
    """Frames sorted by name, their camera-to-world matrices and the 3D points, in the trained scene's space."""
    sparse = Path(sparse)
    images = sorted(read_images(sparse / "images.bin"), key=lambda im: im["name"])   # gsplat sorts by name = time
    point_ids, xyz = read_points(sparse / "points3D.bin")
    w2c = np.stack([np.vstack([np.hstack([qvec_to_rotmat(im["qvec"]), im["tvec"][:, None]]), [0, 0, 0, 1]])
                    for im in images])
    c2w, points = normalize(np.linalg.inv(w2c), xyz)
    return images, c2w, point_ids, points


def camera_positions(sparse):
    return load(sparse)[1][:, :3, 3]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("sparse", help="COLMAP model folder with cameras.bin, images.bin, points3D.bin")
    p.add_argument("--stops", type=int, default=16, help="How many stops along the path")
    p.add_argument("--video", help="Folder of the walk to follow, e.g. v1 (default: the one with most frames)")
    p.add_argument("--out", default="web/tour.json")
    args = p.parse_args()

    sparse = Path(args.sparse)
    cams = read_cameras(sparse / "cameras.bin")
    images, c2w, point_ids, points = load(sparse)
    index_of = {pid: i for i, pid in enumerate(point_ids)}

    # Each frame: where the phone was, which way it looked, how far its subject was
    frames = []
    for im, m in zip(images, c2w):
        pos, R = m[:3, 3], m[:3, :3]
        forward, up = R[:, 2], -R[:, 1]                     # OpenCV camera: +z forward, -y up
        seen = [index_of[i] for i in im["point3D_ids"] if i in index_of]
        depth = float(np.median((points[seen] - pos) @ forward)) if seen else 0.5
        depth = float(np.clip(depth, 0.15, 3.0))
        frames.append({"name": im["name"], "camera": im["camera_id"], "pos": pos, "forward": forward, "up": up,
                       "depth": depth, "seen": len(seen)})

    scene_up = np.mean([f["up"] for f in frames], axis=0)
    scene_up /= np.linalg.norm(scene_up)

    # Follow one walk (one video). Photos have no order, so they're never the path.
    folder_of = lambda f: f["name"].split("/")[0] if "/" in f["name"] else ""
    walks = {}
    for f in frames:
        if folder_of(f) != "photos":
            walks.setdefault(folder_of(f), []).append(f)
    if not walks:
        raise SystemExit("No video frames in this model")
    name = args.video if args.video is not None else max(walks, key=lambda k: len(walks[k]))
    if name not in walks:
        raise SystemExit(f"No walk called {name}. Walks: {', '.join(sorted(walks))}")
    walk = walks[name]

    cam = cams[walk[0]["camera"]]
    fy = cam["params"][1] if cam["model"] in (1, 4, 5) else cam["params"][0]
    vfov = float(np.degrees(2 * np.arctan(cam["height"] / 2 / fy)))

    # Split the walk into equal stretches by distance walked; in each, take the sharpest frame
    steps = np.r_[0, np.cumsum([np.linalg.norm(b["pos"] - a["pos"]) for a, b in zip(walk, walk[1:])])]
    edges = np.linspace(0, steps[-1], args.stops + 1)
    picks = []
    for lo, hi in zip(edges, edges[1:]):
        idx = [i for i, s in enumerate(steps) if lo <= s <= hi]
        if idx:
            picks.append(max(idx, key=lambda i: walk[i]["seen"]))
    picks = sorted(set(picks))
    stops = []
    for i in picks:
        f = walk[i]
        target = f["pos"] + f["forward"] * f["depth"]
        stops.append({"frame": f["name"],
                      "position": [round(float(v), 4) for v in f["pos"]],
                      "target": [round(float(v), 4) for v in target]})

    out = {"up": [round(float(v), 4) for v in scene_up], "fov": round(vfov, 1), "stops": stops}
    Path(args.out).write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")

    print(f"{len(images)} frames placed; walks: " + ", ".join(f"{k or 'main'} ({len(v)})" for k, v in sorted(walks.items())))
    print(f"Tour follows {name or 'main'}: path length {steps[-1]:.2f} (scene units)")
    print(f"Scene up: {out['up']}   camera vertical FOV: {vfov:.0f} deg")
    print(f"Points after normalizing: median {np.median(points, 0).round(3).tolist()}, "
          f"p5 {np.percentile(points, 5, 0).round(2).tolist()}, p95 {np.percentile(points, 95, 0).round(2).tolist()}")
    print(f"Wrote {len(stops)} stops to {args.out}")


if __name__ == "__main__":
    main()
