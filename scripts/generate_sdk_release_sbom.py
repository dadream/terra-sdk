#!/usr/bin/env python3
"""Generate a deterministic SPDX 2.3 inventory for Terra SDK archives."""

import argparse
import hashlib
import json
import pathlib
import subprocess
from datetime import datetime, timezone


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def git_value(root, *arguments):
    return subprocess.check_output(
        ["git", "-C", str(root), *arguments], text=True
    ).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--release-dir", required=True, type=pathlib.Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--root", required=True, type=pathlib.Path)
    args = parser.parse_args()

    release_dir = args.release_dir.resolve()
    root = args.root.resolve()
    native = release_dir / f"terra-sdk-{args.version}-native.tar.gz"
    miniprogram = release_dir / f"terra-sdk-{args.version}-miniprogram.tar.gz"
    for archive in (native, miniprogram):
        if not archive.is_file():
            raise SystemExit(f"Missing release archive: {archive}")

    commit = git_value(root, "rev-parse", "HEAD")
    commit_epoch = int(
        git_value(root, "show", "-s", "--format=%ct", "HEAD")
    )
    created = datetime.fromtimestamp(commit_epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    namespace = (
        "https://github.com/dadream/terra-sdk/releases/"
        f"spdx/v{args.version}/{commit}"
    )
    packages = []
    for identifier, archive, purpose in (
        ("SPDXRef-Package-Native", native, "Linux C++14/C ABI SDK"),
        (
            "SPDXRef-Package-WebMiniProgram",
            miniprogram,
            "WebAssembly, WebGL, and WeChat Mini Program runtime",
        ),
    ):
        packages.append(
            {
                "SPDXID": identifier,
                "name": archive.name.removesuffix(".tar.gz"),
                "versionInfo": args.version,
                "downloadLocation": (
                    "https://github.com/dadream/terra-sdk/releases/download/"
                    f"v{args.version}/{archive.name}"
                ),
                "filesAnalyzed": False,
                "checksums": [
                    {"algorithm": "SHA256", "checksumValue": sha256(archive)}
                ],
                "licenseConcluded": "NOASSERTION",
                "licenseDeclared": "NOASSERTION",
                "copyrightText": "NOASSERTION",
                "summary": purpose,
                "licenseComments": (
                    "The archive contains components under their upstream terms. "
                    "See LICENSE, NOTICE, spacelib/COPYING, and ratman/LICENSE."
                ),
            }
        )

    document = {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": f"Terra SDK {args.version} release inventory",
        "documentNamespace": namespace,
        "creationInfo": {
            "created": created,
            "creators": ["Tool: generate_sdk_release_sbom.py"],
        },
        "documentDescribes": [package["SPDXID"] for package in packages],
        "packages": packages,
    }
    output = release_dir / f"terra-sdk-{args.version}.spdx.json"
    output.write_text(
        json.dumps(document, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(output)


if __name__ == "__main__":
    main()
