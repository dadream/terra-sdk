#!/usr/bin/env python3
"""Validate the immutable metadata associated with an SDK release tag."""

import argparse
import hashlib
import json
import pathlib
import re
import tarfile


TAG_PATTERN = re.compile(
    r"^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"
)


def checksum(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def cmake_version(root):
    content = (root / "CMakeLists.txt").read_text(encoding="utf-8")
    match = re.search(r"project\(TerraSdk VERSION ([^ )]+)", content)
    if not match:
        raise SystemExit("Unable to read Terra SDK version from CMakeLists.txt")
    return match.group(1)


def validate_archive(path, root_name):
    with tarfile.open(path, "r:gz") as archive:
        names = archive.getnames()
    if not names or any(
        name != root_name and not name.startswith(root_name + "/")
        for name in names
    ):
        raise SystemExit(
            f"Archive {path.name} contains an unexpected top-level path"
        )
    required = {
        f"{root_name}/FILES",
        f"{root_name}/release_manifest.json",
    }
    missing = required.difference(names)
    if missing:
        raise SystemExit(
            f"Archive {path.name} is missing: {', '.join(sorted(missing))}"
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", required=True)
    parser.add_argument("--release-dir", required=True, type=pathlib.Path)
    parser.add_argument(
        "--root",
        default=pathlib.Path(__file__).resolve().parents[1],
        type=pathlib.Path,
    )
    args = parser.parse_args()

    if not TAG_PATTERN.fullmatch(args.tag):
        raise SystemExit(f"Release tag must use vMAJOR.MINOR.PATCH: {args.tag}")
    version = args.tag[1:]
    root = args.root.resolve()
    release_dir = args.release_dir.resolve()
    project_version = cmake_version(root)
    if project_version != version:
        raise SystemExit(
            f"Tag {args.tag} does not match CMake project version {project_version}"
        )

    manifest_path = release_dir / "release_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        manifest.get("schema") != "terra.sdk-release.v1"
        or manifest.get("sdk_version") != version
    ):
        raise SystemExit("Release manifest schema or version does not match the tag")

    archives = (
        ("native", manifest["native_archive"], manifest["native_sha256"]),
        (
            "miniprogram",
            manifest["miniprogram_archive"],
            manifest["miniprogram_sha256"],
        ),
    )
    for kind, filename, expected in archives:
        expected_name = f"terra-sdk-{version}-{kind}.tar.gz"
        if filename != expected_name:
            raise SystemExit(f"Unexpected {kind} archive name: {filename}")
        archive = release_dir / filename
        if checksum(archive) != expected:
            raise SystemExit(f"SHA256 mismatch for {filename}")
        validate_archive(archive, filename.removesuffix(".tar.gz"))

    sums_path = release_dir / "SHA256SUMS"
    sums = {
        parts[1]: parts[0]
        for line in sums_path.read_text(encoding="utf-8").splitlines()
        if len(parts := line.split()) == 2
    }
    if sums != {filename: expected for _, filename, expected in archives}:
        raise SystemExit("SHA256SUMS does not match the release manifest")

    sbom_path = release_dir / f"terra-sdk-{version}.spdx.json"
    sbom = json.loads(sbom_path.read_text(encoding="utf-8"))
    if sbom.get("spdxVersion") != "SPDX-2.3":
        raise SystemExit("Release inventory is not SPDX 2.3 JSON")
    spdx_checksums = {}
    for package in sbom.get("packages", []):
        location = package.get("downloadLocation", "")
        filename = location.rsplit("/", 1)[-1]
        for item in package.get("checksums", []):
            if item.get("algorithm") == "SHA256":
                spdx_checksums[filename] = item.get("checksumValue")
    if spdx_checksums != {
        filename: expected for _, filename, expected in archives
    }:
        raise SystemExit("SPDX package checksums do not match release archives")

    notes = root / "docs" / "releases" / f"{args.tag}.md"
    if not notes.is_file() or not notes.read_text(encoding="utf-8").strip():
        raise SystemExit(f"Missing release notes: {notes}")

    print(f"Terra SDK release metadata verified for {args.tag}.")


if __name__ == "__main__":
    main()

