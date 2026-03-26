#!/bin/bash
# CalVer version bump script
# https://calver.org/
#
# Format: YY.M.MICRO (no leading zeros for SemVer compatibility)
#   YY    — Auto. Year (e.g., 26 = 2026)
#   M     — Auto. Month without leading zero (e.g., 3 = March)
#   MICRO — Auto. Starts at 1, increments if same YY.MM already exists
#
# Usage:
#   ./scripts/bump.sh    # auto-increment micro within current YY.MM
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Read current version from tauri.conf.json
CURRENT_VERSION=$(grep '"version"' "$PROJECT_DIR/src-tauri/tauri.conf.json" | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')

# Generate YY.M from current date (no leading zero for SemVer compatibility)
YY=$(date +%y | sed 's/^0//')
MM=$(date +%m | sed 's/^0//')

# Parse current YY.MM
CURRENT_YYMM=$(echo "$CURRENT_VERSION" | cut -d. -f1-2)
CURRENT_MICRO=$(echo "$CURRENT_VERSION" | cut -d. -f3)

if [ "$CURRENT_YYMM" = "${YY}.${MM}" ]; then
  MICRO=$((CURRENT_MICRO + 1))
else
  MICRO=1
fi

VERSION="${YY}.${MM}.${MICRO}"

# Update package.json
sed -i '' "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" "$PROJECT_DIR/package.json"

# Update Cargo.toml (only the package version under [package], not dependencies)
sed -i '' '/^\[package\]/,/^$/{s/^version = ".*"/version = "'"$VERSION"'"/;}' "$PROJECT_DIR/src-tauri/Cargo.toml"

# Update tauri.conf.json
sed -i '' "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" "$PROJECT_DIR/src-tauri/tauri.conf.json"

echo "Bumped version to $VERSION (CalVer: YY=$YY, MM=$MM, micro=$MICRO)"
echo "  - package.json"
echo "  - src-tauri/Cargo.toml"
echo "  - src-tauri/tauri.conf.json"
