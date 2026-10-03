#!/usr/bin/env bash
# Turns a raw take into a polished cut: ./render.sh [demo|board] reads
# out/<cut>.mp4 (from record.sh) and writes out/<cut>-polished.mp4 with music
# and out/<cut>-polished.gif for the README.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CUT="${1:-demo}"
NAME="$(tr '[:lower:]' '[:upper:]' <<< "${CUT:0:1}")${CUT:1}"
OUT="$HERE/out"
VIDEO="$HERE/video"

mkdir -p "$VIDEO/public"
cp "$OUT/$CUT.mp4" "$VIDEO/public/$CUT.mp4"
python3 "$HERE/music/chiptune.py" "$VIDEO/public/music.wav" 45

cd "$VIDEO"
[[ -d node_modules ]] || pnpm install --ignore-workspace
npx remotion render src/index.ts "$NAME" "$OUT/$CUT-polished.mp4"

# README GIF: the flat-background cut, rendered at 800 px (GitHub shows ~880).
# 10 fps, no dither. Keep it under ~5 MB.
npx remotion render src/index.ts "${NAME}Gif" "$OUT/$CUT-gif.mp4" --scale=0.41667 --crf=12
ffmpeg -y -loglevel error -i "$OUT/$CUT-gif.mp4" -filter_complex "fps=10,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" "$OUT/$CUT-polished.gif"
rm "$OUT/$CUT-gif.mp4"
echo "Wrote $OUT/$CUT-polished.mp4 and $OUT/$CUT-polished.gif"
