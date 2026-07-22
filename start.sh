#!/bin/sh
# Runs the bot with a native arm64 Node on Apple Silicon. An x64 Node under
# Rosetta makes Puppeteer warn and forces Chrome translation, so prefer an
# arm64 build installed via fnm (fnm install 24 --arch arm64). Falls back to
# whatever "node" is on PATH.
set -e

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ "$(uname -sm)" = "Darwin arm64" ]; then
  for candidate in "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node; do
    if [ -x "$candidate" ] && [ "$("$candidate" -p process.arch 2>/dev/null)" = "arm64" ]; then
      exec "$candidate" "$DIR/src/index.js" "$@"
    fi
  done
  echo "warning: no arm64 Node found in fnm; falling back to PATH (x64 will run under Rosetta)." >&2
  echo "         install one with: fnm install 24 --arch arm64" >&2
fi

exec node "$DIR/src/index.js" "$@"
