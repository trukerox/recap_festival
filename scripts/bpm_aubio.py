#!/usr/bin/env python3
"""Accurate BPM via aubio's onset-based beat tracker.

aubio is a mature, CPU-only audio-analysis library purpose-built for
onset/tempo/pitch detection — far more reliable on real music than the naive
energy-autocorrelation fallback in bpmDetect.js. We feed it a decoded WAV
(the Node side converts with ffmpeg first, so aubio never has to decode mp3
itself — avoids depending on aubio's codec build) and report the BPM from the
median inter-beat interval, plus a confidence derived from how consistent
those intervals are.

Usage:  python3 bpm_aubio.py <wav_path>
Output (stdout JSON): {"bpm": <int|null>, "confidence": <float 0..1>,
                       "beats": [<beat time in seconds>, ...]}

The "beats" array is the actual detected beat times — the caller cuts ON these
so the edit is synced to the real kicks (not a fixed grid from t=0, which
ignores the song's intro and drift).
"""
import sys
import json
import statistics

import aubio

WIN_SIZE = 1024
HOP_SIZE = 512


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: bpm_aubio.py <wav_path>"}), file=sys.stderr)
        sys.exit(1)

    path = sys.argv[1]
    try:
        src = aubio.source(path, 0, HOP_SIZE)  # samplerate 0 = use file's own
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)

    tempo = aubio.tempo("default", WIN_SIZE, HOP_SIZE, src.samplerate)
    beats = []
    while True:
        samples, read = src()
        if tempo(samples):
            beats.append(round(float(tempo.get_last_s()), 4))
        if read < HOP_SIZE:
            break

    if len(beats) < 4:
        print(json.dumps({"bpm": None, "confidence": 0.0, "beats": beats}))
        return

    intervals = [b - a for a, b in zip(beats[:-1], beats[1:]) if (b - a) > 0]
    if not intervals:
        print(json.dumps({"bpm": None, "confidence": 0.0, "beats": beats}))
        return

    median_interval = statistics.median(intervals)
    bpm = 60.0 / median_interval

    # Confidence: consistent beat spacing → high confidence. Use relative
    # standard deviation of the intervals (0 = perfectly steady).
    if len(intervals) > 1:
        rel_stdev = statistics.pstdev(intervals) / median_interval if median_interval else 1.0
        confidence = max(0.0, min(1.0, 1.0 - rel_stdev))
    else:
        confidence = 0.3

    print(json.dumps({"bpm": round(bpm), "confidence": round(confidence, 3), "beats": beats}))


if __name__ == "__main__":
    main()
