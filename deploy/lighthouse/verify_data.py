#!/usr/bin/env python3

import argparse
import hashlib
import json
from pathlib import Path


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    arguments = parser.parse_args()

    manifest = json.loads(arguments.manifest.read_text(encoding="utf-8"))
    failures = []
    for entry in manifest["files"]:
        path = arguments.data_root / entry["path"]
        if not path.is_file():
            failures.append(f"missing file: {entry['path']}")
            continue
        size = path.stat().st_size
        if size != entry["bytes"]:
            failures.append(
                f"size mismatch: {entry['path']} ({size} != {entry['bytes']})"
            )
            continue
        digest = file_sha256(path)
        if digest != entry["sha256"]:
            failures.append(f"sha256 mismatch: {entry['path']}")

    for entry in manifest["collections"]:
        root = arguments.data_root / entry["path"]
        files = list(root.rglob(f"*{entry['extension']}")) if root.is_dir() else []
        size = sum(path.stat().st_size for path in files)
        if len(files) != entry["files"]:
            failures.append(
                f"file count mismatch: {entry['path']} "
                f"({len(files)} != {entry['files']})"
            )
        if size != entry["bytes"]:
            failures.append(
                f"collection size mismatch: {entry['path']} "
                f"({size} != {entry['bytes']})"
            )

    if failures:
        for failure in failures:
            print(f"[error] {failure}")
        return 1

    print("Lighthouse dataset verification passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
