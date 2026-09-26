#!/usr/bin/env bash
# Собирает release-бандл и кладёт его в /Applications/MySpace.app,
# чтобы приложение запускалось из Dock/Spotlight как обычная программа.
set -euo pipefail
cd "$(dirname "$0")/.."
# Только .app: шаг .dmg падает в sandbox-оболочке (hdiutil), а для запуска он не нужен
# Updater-артефакты (.app.tar.gz + .sig) нужны только CI-релизу (docs/release.md):
# без TAURI_SIGNING_PRIVATE_KEY `tauri build` с createUpdaterArtifacts падает.
npm run tauri build -- --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
SRC="src-tauri/target/release/bundle/macos/myspace.app"
DEST="/Applications/MySpace.app"
[ -d "$SRC" ] || { echo "bundle not found: $SRC" >&2; exit 1; }
mkdir -p "$DEST"
rsync -a --delete "$SRC/" "$DEST/"
echo "installed: $DEST"
