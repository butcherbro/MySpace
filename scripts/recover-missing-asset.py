#!/usr/bin/env python3
"""Recover ONE missing managed asset from a validated backup snapshot.

Prepared for the DATA-RECOVERY checkpoint (plan 2026-09-11 v1-stabilization).

Dry-run unless --apply is passed, and --apply additionally requires
--confirm-app-closed. Never restores the whole database. Never overwrites an
existing asset: the destination is created with O_CREAT | O_EXCL, so a file that
appears between the checks and the write is never clobbered.

Safety contract:
  1. find the missing `assets.file_path` through SQLite (read-only);
  2. confirm exactly one live metadata row references it;
  3. confirm the backup snapshot manifest records `validation == "ok"`;
  4. validate `file_path` as a safe basename and require the backup source to be
     a regular file (not a symlink, not a directory);
  5. compare expected `size_bytes` to the backup file size, and hash the source;
  6. create the destination with O_CREAT | O_EXCL and verify the written bytes
     hash to the same SHA-256;
  7. re-run an integrity query and report counts.

No user-specific paths are embedded: pass them on the command line.

Usage:
  python3 recover-missing-asset.py \
      --live-db PATH --live-assets PATH --backup-dir PATH
  python3 recover-missing-asset.py \
      --live-db PATH --live-assets PATH --backup-dir PATH \
      --apply --confirm-app-closed
"""
import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import sys
import urllib.parse

# Every durable owner of an asset. `favicon_cache` is NOT an owner (acceleration
# index only), so it is deliberately absent.
OWNER_COLUMNS = [
    ("image_cards.asset_id", "SELECT COUNT(*) FROM image_cards WHERE asset_id = ?"),
    ("embed_cards.asset_id", "SELECT COUNT(*) FROM embed_cards WHERE asset_id = ?"),
    ("embed_cards.favicon_asset_id", "SELECT COUNT(*) FROM embed_cards WHERE favicon_asset_id = ?"),
    ("boards.cover_asset_id", "SELECT COUNT(*) FROM boards WHERE cover_asset_id = ?"),
    ("file_cards.asset_id", "SELECT COUNT(*) FROM file_cards WHERE asset_id = ?"),
    ("file_cards.preview_asset_id", "SELECT COUNT(*) FROM file_cards WHERE preview_asset_id = ?"),
]


def fail(msg):
    print("ABORT: " + msg, file=sys.stderr)
    sys.exit(1)


def is_safe_asset_name(name):
    """Mirror the app's `is_safe_asset_name`: one plain filename component."""
    if not name or name != name.strip():
        return False
    if name.startswith(".") or os.path.isabs(name):
        return False
    if "/" in name or "\\" in name or ".." in name:
        return False
    return all(c.isalnum() or c in ".-" for c in name)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def connect_readonly(path):
    # Percent-encode the path (spaces, '?' etc.) so SQLite parses the URI correctly.
    uri = "file:{}?mode=ro".format(urllib.parse.quote(path))
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def require_manifest_ok(backup_dir):
    manifest_path = os.path.join(backup_dir, "manifest.json")
    if not os.path.isfile(manifest_path):
        fail("backup manifest not found: {}".format(manifest_path))
    try:
        with open(manifest_path, "r", encoding="utf-8") as handle:
            manifest = json.load(handle)
    except (OSError, ValueError) as error:
        fail("cannot read backup manifest: {}".format(error))
    if manifest.get("validation") != "ok":
        fail("backup manifest is not validated (validation={!r})".format(manifest.get("validation")))
    return manifest


def require_regular_file(path, label):
    try:
        info = os.lstat(path)
    except OSError as error:
        fail("{} not found: {} ({})".format(label, path, error))
    if stat.S_ISLNK(info.st_mode):
        fail("{} is a symlink, refusing to trust it: {}".format(label, path))
    if not stat.S_ISREG(info.st_mode):
        fail("{} is not a regular file: {}".format(label, path))
    return info


def copy_exclusive(source, dest):
    """Copy `source` to a brand-new `dest` (O_CREAT|O_EXCL), never overwriting."""
    fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(fd, "wb") as out, open(source, "rb") as src:
            shutil.copyfileobj(src, out)
    except BaseException:
        # Leave no half-written file behind.
        try:
            os.unlink(dest)
        except OSError:
            pass
        raise


def main():
    parser = argparse.ArgumentParser(description="Recover one missing managed asset from a backup")
    parser.add_argument("--live-db", required=True, help="path to the live workspace.sqlite3")
    parser.add_argument("--live-assets", required=True, help="path to the live assets directory")
    parser.add_argument("--backup-dir", required=True, help="path to the validated backup snapshot")
    parser.add_argument("--apply", action="store_true", help="perform the copy (default is dry-run)")
    parser.add_argument(
        "--confirm-app-closed",
        action="store_true",
        help="required with --apply: confirm MySpace is fully closed",
    )
    args = parser.parse_args()

    if args.apply and not args.confirm_app_closed:
        fail("--apply requires --confirm-app-closed (close MySpace first)")
    if not os.path.isfile(args.live_db):
        fail("live database not found: {}".format(args.live_db))
    if not os.path.isdir(args.backup_dir):
        fail("backup snapshot not found: {}".format(args.backup_dir))

    # Step 3 (manifest) is checked up front: an unvalidated snapshot is never used.
    manifest = require_manifest_ok(args.backup_dir)
    print("Backup: {} (validation=ok, schema_version={})".format(
        args.backup_dir, manifest.get("schema_version")))

    backup_assets = os.path.join(args.backup_dir, "assets")
    if not os.path.isdir(backup_assets):
        fail("backup assets directory not found: {}".format(backup_assets))

    conn = connect_readonly(args.live_db)

    # Step 1: find asset rows whose physical file is missing from the live assets dir.
    rows = conn.execute("SELECT id, file_path, size_bytes FROM assets ORDER BY file_path").fetchall()
    missing = []
    for row in rows:
        if not os.path.exists(os.path.join(args.live_assets, row["file_path"])):
            missing.append(row)
    if not missing:
        print("No missing asset files detected. Nothing to recover.")
        return
    if len(missing) > 1:
        print("Multiple ({}) asset files are missing; this script recovers exactly one.".format(len(missing)))
        for row in missing:
            print("  - id={} file_path={}".format(row["id"], row["file_path"]))
        fail("resolve the ambiguity (or recover one at a time) before --apply")

    row = missing[0]
    asset_id, file_path, size_bytes = row["id"], row["file_path"], row["size_bytes"]
    print("Missing asset: id={} file_path={} size_bytes={}".format(asset_id, file_path, size_bytes))

    # Step 4a: the DB value is untrusted input for a path join.
    if not is_safe_asset_name(file_path):
        fail("unsafe asset filename in database: {!r}".format(file_path))

    # Step 2: confirm exactly one live metadata row references it.
    refs = []
    for label, query in OWNER_COLUMNS:
        count = conn.execute(query, (asset_id,)).fetchone()[0]
        if count:
            refs.append((label, count))
    total = sum(count for _, count in refs)
    if total != 1:
        fail("expected exactly 1 live reference, found {} ({})".format(
            total, ", ".join("{}:{}".format(l, n) for l, n in refs) or "none"))
    print("References: exactly 1 -> {}".format(refs[0][0]))

    # Step 4b: backup source must be a regular file.
    backup_path = os.path.join(backup_assets, file_path)
    require_regular_file(backup_path, "backup asset")

    # Step 5: size and content hash of the source.
    backup_size = os.path.getsize(backup_path)
    if backup_size != size_bytes:
        fail("size mismatch: live size_bytes={} backup size={}".format(size_bytes, backup_size))
    source_hash = sha256_file(backup_path)
    print("Backup file verified: {} bytes, sha256={}".format(backup_size, source_hash))

    dest_path = os.path.join(args.live_assets, file_path)

    if not args.apply:
        print("\nDRY-RUN: would create {} from {}".format(dest_path, backup_path))
        print("(the destination is created with O_CREAT|O_EXCL, so an existing file is never overwritten)")
        print("Re-run with --apply --confirm-app-closed to perform the copy.")
        return

    # Step 6: exclusive create + verify the written bytes.
    if os.path.lexists(dest_path):
        fail("destination already exists; refusing to overwrite: {}".format(dest_path))
    os.makedirs(args.live_assets, exist_ok=True)
    try:
        copy_exclusive(backup_path, dest_path)
    except FileExistsError:
        fail("destination appeared concurrently; refusing to overwrite: {}".format(dest_path))
    except OSError as error:
        fail("copy failed: {}".format(error))

    written_hash = sha256_file(dest_path)
    if written_hash != source_hash:
        fail("written file hash mismatch: expected {} got {}".format(source_hash, written_hash))
    print("Copied: {} -> {} (sha256 verified)".format(backup_path, dest_path))

    # Step 7: integrity query and counts.
    integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
    total_assets = conn.execute("SELECT COUNT(*) FROM assets").fetchone()[0]
    still_missing = 0
    for row in conn.execute("SELECT file_path FROM assets").fetchall():
        if not os.path.exists(os.path.join(args.live_assets, row["file_path"])):
            still_missing += 1
    print("Integrity check: {}".format(integrity))
    print("Total assets: {}; still-missing files: {}".format(total_assets, still_missing))


if __name__ == "__main__":
    main()
