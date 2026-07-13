#!/usr/bin/env python3
"""Lightweight face/crowd heuristic for a single still frame.

Uses OpenCV's bundled Haar cascade (CPU-only, no model download, fast enough
to run per-candidate-frame on a Raspberry Pi). Not a substitute for a real
crowd/emotion model — see docs/ARCHITECTURE.md "AI model recommendations" for
the optional cloud-API upgrade path.

Usage: python3 face_count.py <image_path>
Output (stdout): {"faces": <int>, "avg_face_area_ratio": <float 0..1>}
"""
import sys
import json

import cv2

def main():
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: face_count.py <image_path>"}), file=sys.stderr)
        sys.exit(1)

    path = sys.argv[1]
    img = cv2.imread(path)
    if img is None:
        print(json.dumps({"error": f"could not read image: {path}"}), file=sys.stderr)
        sys.exit(1)

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)

    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    cascade = cv2.CascadeClassifier(cascade_path)
    faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(24, 24))

    h, w = gray.shape[:2]
    frame_area = float(w * h)
    avg_area_ratio = 0.0
    if len(faces) > 0:
        areas = [float(fw * fh) for (_, _, fw, fh) in faces]
        avg_area_ratio = (sum(areas) / len(areas)) / frame_area

    print(json.dumps({"faces": int(len(faces)), "avg_face_area_ratio": round(avg_area_ratio, 5)}))

if __name__ == "__main__":
    main()
