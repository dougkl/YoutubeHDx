#!/usr/bin/env bash
# Builds the Player extension's offscreen TIDAL player (offscreen.js + tidal-player/*.js) from
# extension-player/src/offscreen-src.js and TIDAL's official web player SDK (@tidal-music/player, Apache-2.0).
# The built files are committed, so installing the extension never needs Node. Re-run after changing the source
# or to update the SDK:   tools/build-tidal-player.sh [sdk-version]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
ver="${1:-0.20.1}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
npm init -y >/dev/null
npm install --silent "@tidal-music/player@$ver" esbuild >/dev/null
cp "$here/extension-player/src/offscreen-src.js" entry.js
rm -rf "$here/extension-player/tidal-player" "$here/extension-player/offscreen.js"
npx esbuild entry.js --bundle --format=esm --splitting --target=chrome111 --minify \
  --outdir="$here/extension-player" --entry-names=offscreen --chunk-names='tidal-player/[name]-[hash]' \
  --legal-comments=none --log-level=warning
{
  echo "TIDAL web player SDK (@tidal-music/player $ver and its @tidal-music/* dependencies)"
  echo "Copyright TIDAL Music AS. Licensed under the Apache License, Version 2.0:"
  echo "https://www.apache.org/licenses/LICENSE-2.0  -  source: https://github.com/tidal-music/tidal-sdk-web"
  echo
  echo "Bundled third-party code inside the SDK keeps its own license (e.g. shaka-player, Apache-2.0)."
} > "$here/extension-player/tidal-player/NOTICE.txt"
echo "Built: $(ls "$here/extension-player/tidal-player" | wc -l) chunk files + offscreen.js"
