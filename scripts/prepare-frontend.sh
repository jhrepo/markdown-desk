#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
FRONTEND_DIR="$PROJECT_DIR/dist"
SUBMODULE_DIR="$PROJECT_DIR/Markdown-Viewer"

# Clean and recreate frontend directory
rm -rf "$FRONTEND_DIR"
mkdir -p "$FRONTEND_DIR"

# Copy web assets from submodule
cp "$SUBMODULE_DIR/index.html" "$FRONTEND_DIR/"
cp "$SUBMODULE_DIR/script.js" "$FRONTEND_DIR/"
cp "$SUBMODULE_DIR/styles.css" "$FRONTEND_DIR/"
cp -r "$SUBMODULE_DIR/assets" "$FRONTEND_DIR/" 2>/dev/null || true

# Preview rendering worker (added in Markdown-Viewer 3.7.x). script.js loads it
# via `new Worker(new URL("preview-worker.js", …))` for large documents
# (>= 50KB). It is load-bearing: if it 404s the preview pipeline errors out and
# falls back to main-thread rendering with console noise + a first-render stall.
# Hard copy (no `|| true`) so a renamed/missing worker fails the build loudly
# rather than silently degrading at runtime. The tests/unit submodule contract
# (`prepare-frontend.sh bundles every worker .js …`) pins this coupling.
# NOTE: sw.js (service worker) and manifest.json are intentionally NOT copied —
# they are PWA niceties that are inert/guarded inside the Tauri shell.
cp "$SUBMODULE_DIR/preview-worker.js" "$FRONTEND_DIR/"

# Copy bridge script and inject app version
cp "$SCRIPT_DIR/bridge.js" "$FRONTEND_DIR/"
cp "$SCRIPT_DIR/bridge-helpers.js" "$FRONTEND_DIR/"
cp "$SCRIPT_DIR/toc.js" "$FRONTEND_DIR/"
APP_VERSION=$(grep '"version"' "$PROJECT_DIR/src-tauri/tauri.conf.json" | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/')
if [ -z "$APP_VERSION" ]; then
  echo "ERROR: Could not extract version from tauri.conf.json" >&2
  exit 1
fi
sed -i '' "s/%%APP_VERSION%%/$APP_VERSION/g" "$FRONTEND_DIR/bridge.js"

# Strip dev-only hook blocks from release builds so internal test surfaces
# aren't exposed to production users. Tauri sets TAURI_ENV_DEBUG=true for
# `tauri build --debug` / `tauri dev`; any other value (including unset)
# is treated as release. Applied to every bridge-owned script via a glob
# so new dev-hooks landing in helpers / future scripts get stripped too
# without needing a parallel edit here.
if [ "${TAURI_ENV_DEBUG:-false}" != "true" ]; then
  for f in bridge.js bridge-helpers.js toc.js; do
    if [ -f "$FRONTEND_DIR/$f" ]; then
      sed -i '' '/@dev-hook-start/,/@dev-hook-end/d' "$FRONTEND_DIR/$f"
    fi
  done
fi

# Inject bridge.js into the copied index.html (in <head>, before other scripts).
# bridge-helpers.js must load first since bridge.js reads from
# window.__bridgeHelpers at call sites.
sed -i '' 's|</head>|<script src="bridge-helpers.js"></script><script src="bridge.js"></script></head>|' "$FRONTEND_DIR/index.html"

# Inject toc.js just before </body>, after the rest of the body has been
# parsed. This is not literally a `defer` attribute — it relies on DOM
# parse order so script.js has already attached its handlers by the time
# toc.js runs. toc.js itself waits on DOMContentLoaded before installing.
sed -i '' 's|</body>|<script src="toc.js"></script></body>|' "$FRONTEND_DIR/index.html"

echo "Frontend prepared successfully."
