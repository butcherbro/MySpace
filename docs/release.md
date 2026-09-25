# Releasing MySpace

Installers and the updater manifest are published to the **public** repo
[`butcherbro/MySpace-releases`](https://github.com/butcherbro/MySpace-releases).
This code repo stays private. Installed apps only ever read
`https://github.com/butcherbro/MySpace-releases/releases/latest/download/latest.json`
(`plugins.updater.endpoints` in `src-tauri/tauri.conf.json`).

The workflow is `.github/workflows/release.yml`. It builds:

| Platform | Runner | Installer (first install) | Updater bundle (in-app updates) |
|---|---|---|---|
| macOS, Apple Silicon | `macos-latest`, `--target aarch64-apple-darwin` | `myspace_<ver>_aarch64.dmg` | `myspace_aarch64.app.tar.gz` + `.sig` (tauri-action adds the arch) |
| macOS, Intel | `macos-latest`, `--target x86_64-apple-darwin` (cross-compiled) | `myspace_<ver>_x64.dmg` | `myspace_<arch>.app.tar.gz` + `.sig` |
| Windows x64 | `windows-latest`, `--bundles nsis` | `myspace_<ver>_x64-setup.exe` | the same `-setup.exe` + `.sig` |

## One-time setup

1. **Create the public releases repo.** On GitHub: New repository ->
   owner `butcherbro`, name `MySpace-releases`, **Public**, tick
   "Add a README file" (the repo needs a `main` branch: releases there are
   tagged from `main`, because the code commits do not exist in that repo).
2. **Create a fine-grained personal access token.** GitHub -> Settings ->
   Developer settings -> Personal access tokens -> Fine-grained tokens ->
   Generate new token. Resource owner `butcherbro`, Repository access "Only
   select repositories" -> `butcherbro/MySpace-releases`, Repository
   permissions -> **Contents: Read and write** (Metadata: Read-only is added
   automatically). Pick an expiration and put a reminder in your calendar: an
   expired token makes the next release fail at "Create or reuse the draft
   release" with `Bad credentials` / 401.
3. **Add three Actions secrets to this (private) repo.** Settings -> Secrets
   and variables -> Actions -> New repository secret:
   - `TAURI_SIGNING_PRIVATE_KEY` = the full content of `myspace-updater.key`
     (the two lines of base64 text as they are in the file).
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = empty. GitHub does not accept an
     empty secret; if it refuses, leave this secret out: an unset secret
     expands to an empty string, which is what the key needs.
   - `RELEASES_TOKEN` = the token from step 2.
4. **Keep the private key safe.** Store `myspace-updater.key` in a password
   manager. It is **not** in this repo and must never be committed. If it is
   lost, existing installs can no longer be updated: they only accept updates
   signed by the key whose public half is in `plugins.updater.pubkey`, so every
   user would have to reinstall by hand once a new key ships.

Public key fingerprint (minisign key id): `65F881BE29DD9AAD`.

## Releasing a version

1. Bump the version in **all three** files (they must match the tag; the
   workflow checks it before building):
   - `package.json` -> `"version"` (then `npm install` to refresh `package-lock.json`)
   - `src-tauri/tauri.conf.json` -> `"version"`
   - `src-tauri/Cargo.toml` -> `[package] version` (then `cargo check` in
     `src-tauri/` to refresh `Cargo.lock`)
2. Commit and push to `main`.
3. Tag and push the tag:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
4. Watch **Actions -> Release** in this repo. Three build jobs run in
   parallel (about 15-25 minutes on a cold cache), then `publish`.
5. Check the result in `MySpace-releases` -> Releases: the release
   `MySpace v0.2.0` is published (not a draft) and has the `.dmg` files, the
   `-setup.exe`, the `.app.tar.gz` files, the `.sig` files and `latest.json`.
   Open
   `https://github.com/butcherbro/MySpace-releases/releases/latest/download/latest.json`:
   `version` is the new version and `platforms` has `darwin-aarch64`,
   `darwin-x86_64` and `windows-x86_64`, each with a `signature` and a `url`.
6. Installed apps of an older version show "MySpace 0.2.0 is available"
   about 3 seconds after they start (or right away from Trash -> "Check for
   updates…"). "Update and restart" downloads, verifies the signature,
   installs, and restarts.

`workflow_dispatch` (Actions -> Release -> Run workflow) re-runs the release of
an **existing** tag, e.g. after fixing a secret. It reuses the draft release if
the previous run left one; it refuses to touch a release that is already
published (bump the version instead).

### How the workflow publishes

1. `create-release` checks the tag against the three version fields and
   creates a **draft** release in `MySpace-releases` (or reuses the draft of a
   previous failed run).
2. `build` (one job per platform) runs `tauri-apps/tauri-action@v0` (0.6.x)
   with `owner: butcherbro`, `repo: MySpace-releases`, `releaseId` of that
   draft and `tagName`. It uploads the installers, updater bundles and
   signatures, and merges its platform into `latest.json`.
3. `publish` downloads `latest.json`, fails if a platform or signature is
   missing, and only then publishes the draft. Until that moment
   `releases/latest` still points at the previous version, so installed apps
   never see a half-uploaded release.

## Unsigned builds: what users see

There is no Apple Developer ID / notarization and no Windows code-signing
certificate yet.

- **macOS.** The app is only ad-hoc signed (`bundle.macOS.signingIdentity: "-"`;
  without it Apple Silicon reports a downloaded app as "damaged"). Gatekeeper
  blocks the first launch of the downloaded `.dmg` app with "Apple could not
  verify 'myspace' is free of malware". The user right-clicks (Control-clicks)
  the app in Applications -> **Open** -> **Open**. On macOS 15 Sequoia and
  later that shortcut is gone: try to open once, then System Settings ->
  Privacy & Security -> **Open Anyway**. Last resort in Terminal:
  `xattr -dr com.apple.quarantine /Applications/myspace.app`.
  In-app updates are downloaded by the app itself (no quarantine flag), so they
  do not trigger Gatekeeper again. Because every build is ad-hoc signed with a
  new identity, macOS may ask again for permissions granted to the old build
  (e.g. folder access prompts).
- **Windows.** SmartScreen shows "Windows protected your PC" for the unsigned
  `-setup.exe`: **More info -> Run anyway**. Browsers may also flag the
  download as uncommon; choose Keep. The in-app updater runs the installer in
  `passive` mode (`plugins.updater.windows.installMode`): a small progress
  window, no questions, then the app restarts.

## MCP server (`myspace-mcp`) and sidecars

`src-tauri/tauri.conf.json` has **no** `bundle.externalBin`, and
`scripts/release.sh` does not build or copy the MCP binary. So the installers
contain only the app; `myspace-mcp` (`src-tauri/src/bin/myspace-mcp.rs`) is
still built from source by whoever wires it into an agent host
(`cargo build --release --bin myspace-mcp`).

If it is ever shipped as a sidecar (`"externalBin": ["binaries/myspace-mcp"]`),
Tauri looks for one file per target triple next to that path, and the release
workflow must build it per matrix entry **before** tauri-action:

- `binaries/myspace-mcp-aarch64-apple-darwin`
- `binaries/myspace-mcp-x86_64-apple-darwin`
- `binaries/myspace-mcp-x86_64-pc-windows-msvc.exe` (Windows needs the MSVC
  triple and the `.exe` suffix)

e.g. `cargo build --release --bin myspace-mcp --target <triple>` and copy
`target/<triple>/release/myspace-mcp[.exe]` to that name.

## Local builds

`npm run release` (macOS, installs into `/Applications/MySpace.app`) passes
`--config '{"bundle":{"createUpdaterArtifacts":false}}'`: with updater
artifacts on, `tauri build` fails without `TAURI_SIGNING_PRIVATE_KEY`. For a
hand-made Windows bundle do the same:
`npm run tauri build -- --config '{"bundle":{"createUpdaterArtifacts":false}}'`.
Such local builds still check `MySpace-releases` for updates and will offer the
published version when it is newer.

## When a release run fails

Open Actions -> Release -> the failed run. The job name says which stage broke;
expand the red step.

| Where | Message | Cause / fix |
|---|---|---|
| create-release, "Check the tag…" | `Tag vX does not match the version…` | Bump the three files, delete and re-push the tag (`git tag -d vX; git push origin :refs/tags/vX`). |
| create-release, "Create or reuse…" | `HTTP 401` / `Bad credentials` | `RELEASES_TOKEN` missing or expired. |
| create-release, "Create or reuse…" | `HTTP 404` / `Resource not accessible by personal access token` | The token does not cover `MySpace-releases` or lacks Contents: write; or the repo does not exist. |
| create-release, "Create or reuse…" | `HTTP 422` … `target_commitish` | `MySpace-releases` has no `main` branch (create it with a README). |
| build, tauri-action | `A public key has been found, but no private key` | `TAURI_SIGNING_PRIVATE_KEY` secret missing. |
| build, tauri-action | `failed to decode secret key` / `Wrong password for that key` | The secret is not the exact file content, or a password was set. |
| build, tauri-action (macOS) | `failed to bundle project` … `hdiutil` | Flaky DMG step on the runner; re-run the failed job. |
| build, tauri-action | a Rust compile error on only one platform | Genuine platform bug (the CI `windows-cargo` job only checks debug builds on the host target). |
| publish, "Verify latest.json" | `latest.json has no signed entry for …` | Two builds merged `latest.json` at the same moment. Re-run the workflow (Re-run all jobs): assets and `latest.json` are replaced. |

The release stays a **draft** after any failure, so users are never offered a
broken update. Delete the draft in `MySpace-releases` if you abandon the version.
