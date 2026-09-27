#!/usr/bin/env bash
# Regenerates the square app icons from the SHOUT wordmark (needs ImageMagick 7).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
wordmark="$here/../../shout/public/shout-wordmark.png"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
# Alpha-threshold trim ignores the faint specks around the artwork.
magick "$wordmark" -crop "$(magick "$wordmark" -channel A -threshold 50% +channel -format '%@' info:)" +repage "$work/mark.png"
magick -size 1024x1024 xc:none -fill '#0038a8' -draw 'roundrectangle 32,32 991,991 208,208' \
  \( "$work/mark.png" -resize 936x \) -gravity center -composite "$work/icon.png"
mkdir -p "$here/icons"
for size in 32 48 64 128 256 512; do magick "$work/icon.png" -resize "${size}x${size}" -strip "$here/icons/$size.png"; done
