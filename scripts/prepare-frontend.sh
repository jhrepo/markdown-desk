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

# Copy bridge script
cp "$SCRIPT_DIR/bridge.js" "$FRONTEND_DIR/"

# Inject bridge.js into the copied index.html (in <head>, before other scripts)
sed -i '' 's|</head>|<script src="bridge.js"></script></head>|' "$FRONTEND_DIR/index.html"

echo "Frontend prepared successfully."
