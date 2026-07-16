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

## If a LUT looks too strong

`lut3d` has no built-in intensity/mix control — it's all-or-nothing. To dial one
back you'd `split` the stream, grade one copy, and `blend` them at partial
opacity. Ask and we'll add an intensity knob; simplest first step is just trying
a gentler LUT.
