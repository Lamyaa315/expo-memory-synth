"""
Blur faces in frames before reconstruction (privacy step).
Uses OpenCV's built-in Haar cascade: fast and dependency-free, not perfect.

Example:
    python scripts/blur_faces.py data/scene/images
"""
import argparse
from pathlib import Path

import cv2


def main():
    p = argparse.ArgumentParser(description="Blur detected faces in a folder of images (in place)")
    p.add_argument("images", help="Folder with .jpg/.png frames")
    p.add_argument("--strength", type=int, default=51, help="Blur kernel size (odd number)")
    args = p.parse_args()

    k = args.strength if args.strength % 2 == 1 else args.strength + 1
    detector = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")

    files = sorted([f for f in Path(args.images).iterdir() if f.suffix.lower() in {".jpg", ".jpeg", ".png"}])
    total_faces = 0
    for f in files:
        img = cv2.imread(str(f))
        if img is None:
            continue
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        faces = detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30))
        for (x, y, w, h) in faces:
            pad = int(0.15 * w)
            x0, y0 = max(0, x - pad), max(0, y - pad)
            x1, y1 = min(img.shape[1], x + w + pad), min(img.shape[0], y + h + pad)
            img[y0:y1, x0:x1] = cv2.GaussianBlur(img[y0:y1, x0:x1], (k, k), 0)
        if len(faces):
            cv2.imwrite(str(f), img)
            total_faces += len(faces)

    print(f"Processed {len(files)} images, blurred {total_faces} faces.")


if __name__ == "__main__":
    main()
