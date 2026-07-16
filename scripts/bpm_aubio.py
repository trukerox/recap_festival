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
                       "beats": [<beat time in seconds>, ...],
                       "energies": [<0..1 loudness around each beat>, ...],
                       "drop": <seconds|null>}

The "beats" array is the actual detected beat times — the caller cuts ON these
so the edit is synced to the real kicks (not a fixed grid from t=0, which
ignores the song's intro and drift).

"energies" (same length as "beats") is the normalised RMS loudness of the
music around each beat, computed from the SAME sample stream in the same pass
(no extra decode). "drop" is the beat where sustained energy jumps the most —
the musical payoff moment. The caller places the strongest shot there and
concentrates flashy transitions in the high-energy stretches.
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
    hop_rms = []  # RMS per hop — the loudness envelope, from the same pass
    while True:
        samples, read = src()
        if tempo(samples):
            beats.append(round(float(tempo.get_last_s()), 4))
        if read:
            acc = 0.0
            for s in samples[:read]:
                acc += float(s) * float(s)
            hop_rms.append((acc / read) ** 0.5)
        if read < HOP_SIZE:
            break

    if len(beats) < 4:
        print(json.dumps({"bpm": None, "confidence": 0.0, "beats": beats,
                          "energies": [], "drop": None}))
        return

    intervals = [b - a for a, b in zip(beats[:-1], beats[1:]) if (b - a) > 0]
    if not intervals:
        print(json.dumps({"bpm": None, "confidence": 0.0, "beats": beats,
                          "energies": [], "drop": None}))
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

    # Per-beat energy: mean hop-RMS over [beat, beat + median interval),
    # normalised to the loudest beat.
    hop_dur = HOP_SIZE / src.samplerate
    energies = []
    for b in beats:
        lo = int(b / hop_dur)
        hi = min(len(hop_rms), max(lo + 1, int((b + median_interval) / hop_dur)))
        window = hop_rms[lo:hi]
        energies.append(sum(window) / len(window) if window else 0.0)
    peak = max(energies) if energies else 0.0
    if peak > 0:
        energies = [round(e / peak, 3) for e in energies]

    # The DROP: the beat where SUSTAINED energy jumps the most — mean of the
    # next 4 beats minus mean of the previous 4 (single-beat spikes are just
    # accents, not drops). Only within the first 75% of the beats so the reel
    # can still build after it, and only if the jump is meaningful.
    drop = None
    if len(energies) >= 9:
        best_score = 0.15  # minimum jump worth calling a drop
        limit = int(len(beats) * 0.75)
        for i in range(4, limit):
            after = sum(energies[i:i + 4]) / 4
            before = sum(energies[i - 4:i]) / 4
            score = after - before
            if score > best_score:
                best_score = score
                drop = beats[i]

    print(json.dumps({"bpm": round(bpm), "confidence": round(confidence, 3),
                      "beats": beats, "energies": energies, "drop": drop}))


if __name__ == "__main__":
    main()
