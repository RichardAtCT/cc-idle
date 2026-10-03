#!/usr/bin/env bash
# Records a cc-idle demo take: ./record.sh [demo|board] writes out/<name>.mp4,
# a quick GIF and stills.
# Starts from a fresh game save; your real save is restored on exit.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TAKE="${1:-demo}"
OUT="$HERE/out"
SHOP="$HOME/shop"
STORE="$HOME/.claude/plugins/store"
# The demo loads the mod with --plugin-dir, which keeps its own "inline" store.
# Your live sessions use the marketplace store, so they never touch this one.
SAVE_GLOB="cc-idle_inline-*.json"
PLUGIN_DIR="$(cd "$HERE/../plugins/cc-idle" && pwd)"

if [[ -e "$SHOP" && ! -e "$SHOP/.ccidle-demo" ]]; then
  echo "$SHOP exists and is not a demo repo. Move it first." >&2
  exit 1
fi

mkdir -p "$OUT/save-backup"

restore() {
  rm -f "$STORE"/$SAVE_GLOB
  cp "$OUT"/save-backup/$SAVE_GLOB "$STORE"/ 2>/dev/null || true
  rm -rf "$SHOP"
  echo "Save restored."
}

rm -f "$OUT"/save-backup/*
cp "$STORE"/$SAVE_GLOB "$OUT/save-backup/" 2>/dev/null || true
trap restore EXIT
rm -f "$STORE"/$SAVE_GLOB

# A tiny shop with one bug and a failing test.
rm -rf "$SHOP" && mkdir -p "$SHOP" && cd "$SHOP"
touch .ccidle-demo
cat > package.json <<'JSON'
{ "name": "shop", "type": "module", "scripts": { "test": "node --test" } }
JSON
cat > cart.js <<'JS'
export function total(items, discountPercent = 0) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return subtotal - discountPercent;
}
JS
cat > cart.test.js <<'JS'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from './cart.js';

test('applies a percentage discount', () => {
  const items = [{ price: 20, qty: 2 }, { price: 10, qty: 1 }];
  assert.equal(total(items, 10), 45);
});
JS
printf '.ccidle-demo\n' > .gitignore
git init -q && git add -A && git commit -qm "shop" && cd "$HERE"

PLUGIN_DIR="$PLUGIN_DIR" vhs "$HERE/$TAKE.tape"

# README GIF: the same take at 1.4x speed, 1200 px wide.
ffmpeg -y -loglevel error -i "$OUT/$TAKE.mp4" -filter_complex "setpts=PTS/1.4,fps=12,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" "$OUT/$TAKE.gif"
echo "Wrote $OUT/$TAKE.mp4 and $OUT/$TAKE.gif"
