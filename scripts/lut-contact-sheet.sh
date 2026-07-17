#!/usr/bin/env bash
# =============================================================================
# lut-contact-sheet.sh — audition every .cube against YOUR footage, on one page.
#
# The composer only ever loads five filenames (warm/vibrant/cool/moody/default),
# so a 35-LUT pack is really a shortlist exercise: you need to pick four looks
# and rename them. Doing that from filenames is guesswork — "Tealorange 12" tells
# you nothing about how it treats a sunlit parade float.
#
# This grades ONE frame of your own footage with every .cube it finds, labels
# each tile with the LUT's filename, and tiles the lot into a single JPG with the
# UNGRADED original as the first tile. Pick your four by eye, rename, done.
#
# Usage (on the Pi):
#   bash scripts/lut-contact-sheet.sh                    # auto-picks a source frame
#   bash scripts/lut-contact-sheet.sh /app/data/uploads/27/some.jpg
#
# Output:  /mnt/storage/festival_recap/data/lut-contact-sheet.jpg
# Copy it to your laptop to view:
#   scp gatekeeper@192.168.178.37:/mnt/storage/festival_recap/data/lut-contact-sheet.jpg .
# =============================================================================
set -euo pipefail

CONTAINER=festival_recap
LUT_DIR=/app/luts                 # read-only mount of /mnt/storage/festival_recap/luts
WORK=/app/data/_lutshots          # scratch, inside the data mount
OUT=/app/data/lut-contact-sheet.jpg
TILE_W=360                        # per-tile width; 6 across ~= 2160px sheet
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf

in_container() { docker exec "$CONTAINER" "$@"; }

# --- source frame ------------------------------------------------------------
# A photo, not a video frame: decoding is one less thing to go wrong, and stills
# are what the LUT differences show up on most clearly.
SRC="${1:-}"
if [ -z "$SRC" ]; then
  SRC=$(in_container sh -c "find /app/data/uploads -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) | sort | head -1")
  [ -n "$SRC" ] || { echo "No image found under /app/data/uploads — pass one explicitly."; exit 1; }
  echo "Source frame (auto): $SRC"
else
  echo "Source frame: $SRC"
fi

# --- collect LUTs ------------------------------------------------------------
mapfile -t LUTS < <(in_container sh -c "ls -1 '$LUT_DIR' 2>/dev/null | grep -i '\.cube$' | sort")
COUNT=${#LUTS[@]}
[ "$COUNT" -gt 0 ] || { echo "No .cube files in $LUT_DIR (host: /mnt/storage/festival_recap/luts)"; exit 1; }
echo "Found $COUNT LUT(s)."

in_container sh -c "rm -rf '$WORK' && mkdir -p '$WORK'"

# --- tile 0: the ungraded original -------------------------------------------
# Without a reference tile every LUT looks plausible. This is the control.
in_container ffmpeg -y -v error -i "$SRC" \
  -vf "scale=${TILE_W}:-2,drawtext=fontfile='${FONT}':text='ORIGINAL (no LUT)':fontsize=16:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6:x=8:y=8" \
  -frames:v 1 "${WORK}/000_original.jpg"

# --- one tile per LUT --------------------------------------------------------
i=0
for lut in "${LUTS[@]}"; do
  i=$((i + 1))
  idx=$(printf "%03d" "$i")
  # Label with the real filename so the sheet maps straight back to the pack.
  # Escaping for drawtext: ' \ : % all bite inside a filtergraph.
  label=$(printf '%s' "$lut" | sed -e "s/\\\\/\\\\\\\\/g" -e "s/'/\\\\'/g" -e "s/:/\\\\:/g" -e "s/%/\\\\%/g")
  if in_container ffmpeg -y -v error -i "$SRC" \
       -vf "lut3d=file='${LUT_DIR}/${lut}',scale=${TILE_W}:-2,drawtext=fontfile='${FONT}':text='${label}':fontsize=16:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6:x=8:y=8" \
       -frames:v 1 "${WORK}/${idx}.jpg" 2>/dev/null
  then
    printf '  ok   %s\n' "$lut"
  else
    # A Log-conversion LUT or an exotic DOMAIN can make lut3d bail. Skipping is
    # right: a LUT that won't apply here would fail mid-render too.
    printf '  FAIL %s  (skipped — bad/unsupported .cube?)\n' "$lut"
    in_container sh -c "rm -f '${WORK}/${idx}.jpg'"
  fi
done

# --- tile them ---------------------------------------------------------------
TILES=$(in_container sh -c "ls -1 '${WORK}'/*.jpg 2>/dev/null | wc -l")
[ "$TILES" -gt 0 ] || { echo "Nothing graded successfully — are these really .cube LUTs?"; exit 1; }
COLS=6
ROWS=$(( (TILES + COLS - 1) / COLS ))
echo "Tiling ${TILES} frame(s) into ${COLS}x${ROWS}…"

in_container ffmpeg -y -v error -pattern_type glob -i "${WORK}/*.jpg" \
  -vf "scale=${TILE_W}:-2,tile=${COLS}x${ROWS}:padding=4:color=0x111111" \
  -frames:v 1 -q:v 3 "$OUT"

in_container sh -c "rm -rf '$WORK'"

echo
echo "Sheet: /mnt/storage/festival_recap/data/lut-contact-sheet.jpg"
echo "Pull it:  scp gatekeeper@192.168.178.37:/mnt/storage/festival_recap/data/lut-contact-sheet.jpg ."
echo
echo "Then pick FOUR and rename them (the composer reads filenames, not content):"
echo "  cd /mnt/storage/festival_recap/luts"
echo "  cp '<punchy saturated one>'  vibrant.cube   # also the fallback — do this one first"
echo "  cp '<golden/sunset one>'     warm.cube"
echo "  cp '<cool blue one>'         cool.cube"
echo "  cp '<crushed/teal-orange>'   moody.cube"
echo "Leftovers can stay — they're simply never read."
