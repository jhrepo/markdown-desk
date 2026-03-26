#!/bin/bash
set -e

if [ -z "$1" ]; then
  echo "Usage: ./scripts/bump.sh <version>"
  echo "Example: ./scripts/bump.sh 0.2.0"
  exit 1
fi

VERSION="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Validate semver format
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: Version must be in semver format (e.g., 0.2.0)"
  exit 1
fi

# Update package.json
sed -i '' "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" "$PROJECT_DIR/package.json"

# Update Cargo.toml (only the package version, not dependencies)
sed -i '' "0,/^version = \".*\"/s//version = \"$VERSION\"/" "$PROJECT_DIR/src-tauri/Cargo.toml"

# Update tauri.conf.json
sed -i '' "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" "$PROJECT_DIR/src-tauri/tauri.conf.json"

echo "Bumped version to $VERSION in:"
echo "  - package.json"
echo "  - src-tauri/Cargo.toml"
echo "  - src-tauri/tauri.conf.json"
