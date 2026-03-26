#!/bin/bash
# HeadVer version bump script
# https://github.com/line/headver
#
# Format: {head}.{YYWW}.{build}
#   head   — Manual. Increment on major end-user releases (starts at 0)
#   YYWW   — Auto. 2-digit year + 2-digit ISO week (e.g., 2613 = 2026 week 13)
#   build  — Auto. Starts at 1, increments if same head+yearweek already exists
#
# Usage:
#   ./scripts/bump.sh [head]
#   ./scripts/bump.sh        # uses current head number
#   ./scripts/bump.sh 1      # sets head to 1
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Read current version from tauri.conf.json
CURRENT_VERSION=$(grep '"version"' "$PROJECT_DIR/src-tauri/tauri.conf.json" | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')

# Parse current head
CURRENT_HEAD=$(echo "$CURRENT_VERSION" | cut -d. -f1)

# Determine head number
if [ -n "$1" ]; then
  HEAD="$1"
else
  HEAD="$CURRENT_HEAD"
fi

# Generate YYWW from current date (ISO week)
YEAR=$(date +%y)
WEEK=$(date +%V)
YYWW="${YEAR}${WEEK}"

# Determine build number
CURRENT_YYWW=$(echo "$CURRENT_VERSION" | cut -d. -f2)
CURRENT_BUILD=$(echo "$CURRENT_VERSION" | cut -d. -f3)
if [ "$CURRENT_HEAD" = "$HEAD" ] && [ "$CURRENT_YYWW" = "$YYWW" ]; then
  BUILD=$((CURRENT_BUILD + 1))
else
  BUILD=1
fi

VERSION="${HEAD}.${YYWW}.${BUILD}"

# Update package.json
sed -i '' "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" "$PROJECT_DIR/package.json"

# Update Cargo.toml (only the package version under [package], not dependencies)
sed -i '' '/^\[package\]/,/^$/{s/^version = ".*"/version = "'"$VERSION"'"/;}' "$PROJECT_DIR/src-tauri/Cargo.toml"

# Update tauri.conf.json
sed -i '' "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" "$PROJECT_DIR/src-tauri/tauri.conf.json"

echo "Bumped version to $VERSION (HeadVer: head=$HEAD, yearweek=$YYWW, build=$BUILD)"
echo "  - package.json"
echo "  - src-tauri/Cargo.toml"
echo "  - src-tauri/tauri.conf.json"
