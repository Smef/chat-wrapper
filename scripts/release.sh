#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v gh &>/dev/null; then
  echo "error: GitHub CLI (gh) is required. Install with: brew install gh" >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"

echo "Releasing ${TAG}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is not clean. Commit or stash changes first." >&2
  exit 1
fi

if git rev-parse "$TAG" &>/dev/null; then
  echo "error: tag ${TAG} already exists. Bump the version in package.json first." >&2
  exit 1
fi

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  echo "Building installers (mac/win/linux)..."
  npm run dist
else
  echo "Skipping build (SKIP_BUILD=1)"
fi

shopt -s nullglob
ASSETS=(
  dist/*.dmg
  dist/*.exe
  dist/*.AppImage
)
shopt -u nullglob

if [[ ${#ASSETS[@]} -eq 0 ]]; then
  echo "error: no installer files found in dist/. Did the build run?" >&2
  exit 1
fi

echo "Assets to upload:"
printf '  %s\n' "${ASSETS[@]}"

git tag "$TAG"
git push origin "$TAG"

gh release create "$TAG" \
  --title "$TAG" \
  --generate-notes \
  "${ASSETS[@]}"

echo "Released ${TAG}: https://github.com/Smef/chat-wrapper/releases/tag/${TAG}"
