#!/usr/bin/env bash
# =============================================================================
# measure-font-advance.sh — measure a font's real average glyph advance.
#
# videoComposer's CHAR_ADV estimates how wide a hook will render, because
# drawtext CANNOT size itself (fontsize takes no expression, and text_w is only
# knowable after the fact). Get it too high and the title is shrunk for no reason;
# too low and it runs off both edges.
#
# It has been guessed three times — 0.62, then 0.70 for DejaVu, then 0.54 for
# Anton — each by eye, each wrong. This measures it: render the text in white on
# black at a known fontsize, let cropdetect find its bounding box, and divide.
#
#   advance = text_width_px / (character_count * fontsize)
#
# which is exactly the quantity videoComposer multiplies by.
#
# Usage (on the Pi):  bash scripts/measure-font-advance.sh
# =============================================================================
set -euo pipefail

CONTAINER=festival_recap
FS=100          # measure at a large size so rounding is negligible
CANVAS=6000x300 # wide enough that no sample can clip; clipping would silently
                # cap the measurement and make the font look narrower than it is

ANTON=/app/fonts/Anton-Regular.ttf
INTER=/app/fonts/Inter-SemiBold.ttf
DEJAVU=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf

# Realistic hooks, not lorem ipsum: CHAR_ADV is multiplied by a naive .length, so
# what matters is the average advance of the TEXT WE ACTUALLY SET — uppercase,
# spaces included. A pangram would skew it.
SAMPLES=(
  "BREZELFEST FUN"
  "FESTIVAL VIBES"
  "BEST NIGHT EVER"
  "BREZELFEST 2026"
  "UNTOLD 2026"
  "FESTIVAL RECAP"
  "A VERY LONG HOOK!!"
)

measure() { # $1=fontfile $2=text -> prints advance, or nothing on failure
  local font="$1" text="$2" crop w
  crop=$(docker exec "$CONTAINER" ffmpeg -hide_banner -nostdin \
      -f lavfi -i "color=black:s=${CANVAS}:d=0.2" \
      -vf "drawtext=fontfile='${font}':text='${text}':fontsize=${FS}:fontcolor=white:x=20:y=20,cropdetect=limit=0.05:round=2:reset=0" \
      -frames:v 3 -f null - 2>&1 | grep -oE 'crop=[0-9]+:[0-9]+:[0-9]+:[0-9]+' | tail -1) || return 1
  [ -n "$crop" ] || return 1
  w=$(echo "$crop" | sed -E 's/crop=([0-9]+):.*/\1/')
  # cropdetect's width is the inked box; x=20 padding is excluded by the detector.
  awk -v w="$w" -v n="${#text}" -v fs="$FS" 'BEGIN{ printf "%.4f", w/(n*fs) }'
}

report() { # $1=label $2=fontfile $3=current-constant-or-dash
  local label="$1" font="$2" current="$3"
  if ! docker exec "$CONTAINER" test -f "$font" 2>/dev/null; then
    printf '\n%s — NOT PRESENT in the image (%s)\n' "$label" "$font"
    return
  fi
  printf '\n%s   (current constant: %s)\n' "$label" "$current"
  printf '  %-22s %5s  %7s  %s\n' "sample" "chars" "px wide" "advance"
  local sum=0 n=0
  for s in "${SAMPLES[@]}"; do
    local a
    a=$(measure "$font" "$s") || { printf '  %-22s  measure FAILED\n' "$s"; continue; }
    local px
    px=$(awk -v a="$a" -v n="${#s}" -v fs="$FS" 'BEGIN{printf "%.0f", a*n*fs}')
    printf '  %-22s %5d  %7s  %s\n' "$s" "${#s}" "$px" "$a"
    sum=$(awk -v s="$sum" -v a="$a" 'BEGIN{print s+a}')
    n=$((n + 1))
  done
  [ "$n" -gt 0 ] || return
  awk -v s="$sum" -v n="$n" -v c="$current" 'BEGIN{
    m = s/n;
    printf "  => MEASURED AVERAGE: %.3f", m;
    if (c != "-") printf "   (constant is %s — %s by %.0f%%)", c, (c>m ? "too HIGH, title shrunk" : "too LOW, title may clip"), (c>m ? (c/m-1)*100 : (m/c-1)*100);
    printf "\n";
  }'
}

echo "Measuring at fontsize ${FS} on canvas ${CANVAS}."
echo "advance = inked_width / (chars * fontsize) — the exact quantity CHAR_ADV stands in for."

report "ANTON  (the hook)"        "$ANTON"  "0.54"
report "INTER  (sub-lines)"       "$INTER"  "-"
report "DEJAVU (stale fallback)"  "$DEJAVU" "0.70"

cat <<'NOTE'

Pick the constant slightly ABOVE the measured average, not at it: CHAR_ADV is a
safety estimate multiplied by a naive .length, and a hook of unusually wide
glyphs ("WOWWW") would overflow at exactly the average. Overshooting shrinks the
title a little; undershooting runs it off both edges.
NOTE
