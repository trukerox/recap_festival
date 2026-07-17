# Colour LUTs (`.cube`)

The Gemini director returns a **mood** for every render (e.g. `"Vibrant, Joyful"`).
That mood is keyword-matched to one of four buckets, and the matching `.cube` file
here is applied to every photo/clip with ffmpeg's `lut3d` filter.

## Naming

Drop files in with **exactly these names** (the mood → file mapping is by filename):

| File | Used when the mood mentions… | Typical look |
|---|---|---|
| `warm.cube` | warm, nostalgic, golden, sunset, cosy, vintage, romantic | golden highlights, soft skin |
| `vibrant.cube` | vibrant, joyful, happy, energetic, festive, lively, fun, party | punchy saturation, clean contrast |
| `cool.cube` | cool, sleek, modern, clean, crisp, calm, serene | cool blues, crisp shadows |
| `moody.cube` | moody, dramatic, dark, intense, cinematic, epic, night | crushed shadows, teal-orange |
| `default.cube` | *(fallback if the mood matches nothing)* | your house look |

Resolution order: **matched bucket → `vibrant.cube` → `default.cube` → no LUT**.
A missing file is not an error — the render simply keeps the ungraded look, so you
can start with one file and add the rest later.

## Requirements

- Format: **`.cube`** (Adobe/Iridas). 33×33×33 is the norm; 17× and 65× also work.
- These are **not** in git on purpose: most free packs licence you to *use* the
  LUTs but not to *redistribute* them. Keeping them mounted (not committed, not
  baked into the image) respects that — and means a new look needs no rebuild.

## Install (on the Pi)

```bash
mkdir -p /mnt/storage/festival_recap/luts
# copy your .cube files in, named as above
ls /mnt/storage/festival_recap/luts
```

The directory is mounted read-only at `/app/luts`. No rebuild needed to add or
swap a LUT — the next render picks it up.

## Where to get them

Search for "free LUT pack .cube". Well-known free sources: RocketStock's *35 Free
LUTs*, Ground Control Color, Lutify.me's free sample, IWLTBAP's free sample.
Check each pack's licence before use.

**Pick Rec.709 CREATIVE looks, not Log conversions.** Most free packs are built for
S-Log/V-Log/D-Log footage. Ours is phone video and JPEGs — already Rec.709, already
contrast-baked — so a Log→Rec709 LUT expands contrast that's already expanded and
the result is crushed and radioactive. If a pack's "before" image looks washed-out
grey, it's the wrong pack. A Log LUT also gives itself away numerically: midtone
contrast ~2.0+, because that's the curve it's built to undo.

## What's currently installed (2026-07-17)

RocketStock *35 Free LUTs* (`LUT_3D_SIZE 32`, domain 0-1, Photoshop Color Lookup
export — i.e. Rec.709 creative looks). Chosen by MEASURING each cube rather than
reading its name: feed the identity grid through it and compare in→out saturation,
warmth (R−B), and the neutral-axis slope.

| Installed as | Source file | sat× | warmth | contrast | Why |
|---|---|---|---|---|---|
| `vibrant.cube` | `Byers 11.CUBE` | 1.12 | −0.01 | 1.37 | punchy sat + clean contrast, zero luma shift |
| `warm.cube` | `Neon 770.CUBE` | 1.05 | +0.09 | 1.29 | warm *and* keeps punch |
| `cool.cube` | `Cubicle 99.CUBE` | 0.98 | −0.14 | 0.77 | coolest cast that holds saturation |
| `moody.cube` | `Ava 614.CUBE` | 1.06 | +0.02 | 1.64 | steepest tone curve in the pack |
| *(spare)* | `Teigen 28.CUBE` | 1.23 | 0.00 | 1.05 | vibrant alt — more sat, flatter |
| *(spare)* | `Pitaya 15.CUBE` | 1.23 | −0.02 | 1.08 | vibrant alt — same sat, darkens hard (−0.18) |

Renaming destroys provenance and the cubes are gitignored, so this table is the
only record of which file is which.

**The internal `TITLE` tag lies.** `vibrant.cube` (Byers 11) is titled `"Cool"` but
measures warmth −0.013 — neutral. 21 of the 35 are titled `"Untitled"`. The mapping
is by FILENAME; titles were not a usable signal.

**Two to keep away from `vibrant.cube`:** `Clayton 33` measures sat ×0.00 — it is
literally greyscale, and as the fallback bucket it would render every recap in
black and white. `Arabica 12` is sepia (sat 0.67).

To audition the pack yourself on your own footage: `scripts/lut-contact-sheet.sh`.

## If a LUT looks too strong

`lut3d` has no built-in intensity/mix control — it's all-or-nothing. To dial one
back you'd `split` the stream, grade one copy, and `blend` them at partial
opacity. Ask and we'll add an intensity knob; simplest first step is just trying
a gentler LUT.
