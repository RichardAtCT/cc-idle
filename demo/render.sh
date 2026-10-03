#!/usr/bin/env bash
# Turns the raw take (out/demo.mp4, from record.sh) into the polished video:
# out/demo-polished.mp4 with music, and out/demo-polished.gif for the README.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/out"
VIDEO="$HERE/video"

cp "$OUT/demo.mp4" "$VIDEO/public/demo.mp4"
python3 "$HERE/music/chiptune.py" "$VIDEO/public/music.wav" 45

cd "$VIDEO"
[[ -d node_modules ]] || pnpm install --ignore-workspace
npx remotion render src/index.ts Demo "$OUT/demo-polished.mp4"

# README GIF: the flat-background cut, rendered at 800 px (GitHub shows ~880).
# 10 fps, no dither. Keep it under ~4 MB.
npx remotion render src/index.ts DemoGif "$OUT/demo-gif.mp4" --scale=0.41667 --crf=12
ffmpeg -y -loglevel error -i "$OUT/demo-gif.mp4" -filter_complex "fps=10,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" "$OUT/demo-polished.gif"
rm "$OUT/demo-gif.mp4"
echo "Wrote $OUT/demo-polished.mp4 and $OUT/demo-polished.gif"
