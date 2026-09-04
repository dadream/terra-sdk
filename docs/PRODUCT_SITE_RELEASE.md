# Terra SDK Release And Product Site

## Purpose

Terra SDK publishes its reusable package boundary before promoting the public
website. The website then presents a real released version instead of an
unversioned source snapshot. Version `v0.1.0` is a Developer Preview.

## Release Contract

Pushing an exact `vMAJOR.MINOR.PATCH` tag runs the complete SDK release gate.
The tag must match `project(TerraSdk VERSION ...)`. A successful run publishes
an immutable GitHub prerelease containing:

- `terra-sdk-<version>-native.tar.gz`
- `terra-sdk-<version>-miniprogram.tar.gz`
- `SHA256SUMS`
- `release_manifest.json`
- `terra-sdk-<version>.spdx.json`

The packages exclude viewer, nav3d, builders, hosted services, Docker images,
and datasets. Release notes live at `docs/releases/<tag>.md`.

Before tagging, run:

```bash
bash scripts/verify_sdk_release.sh
python3 scripts/verify_sdk_release_metadata.py \
  --tag v0.1.0 --release-dir workspace_old/package/release
```

## Product Site

Sources are under `apps/site/`. Build and validate the generated static site:

```bash
bash scripts/verify_product_site.sh
```

Output is written to `workspace_old/site/`. It includes the home page,
interactive Globe and Planar demos, service reference, quickstart, downloads,
licensing page, browser SDK bundle, and verified Wasm artifact. Download links
are generated from the SDK release manifest and point to GitHub Releases.

## Pre-Filing Access

Until domain filing permits normal public HTTPS access, the deployed site is
available at `http://49.233.185.96`. This temporary origin is only for browser
evaluation. The site adapter rewrites SDK-approved loopback URLs to same-origin
relative requests; the SDK and Mini Program HTTPS policies remain unchanged.

After filing, the canonical origin is `https://terra.tapirs.top`. WeChat Mini
Programs must use the HTTPS domain and cannot use the temporary public HTTP IP.

## Lighthouse Deployment

The Caddy edge serves both origins, the static site, and the existing API
routes. Static output is uploaded to a versioned directory and mounted read-only.

```bash
bash scripts/prepare_lighthouse_images.sh
TERRA_TIANDITU_TOKEN='<server-token>' \
TERRA_LIGHTHOUSE_PUBLIC_ORIGIN=http://49.233.185.96 \
  bash scripts/deploy_lighthouse.sh
TERRA_LIGHTHOUSE_ORIGIN=http://49.233.185.96 \
  bash scripts/verify_lighthouse_services.sh
```
After filing, deploy with `TERRA_LIGHTHOUSE_PUBLIC_ORIGIN=https://terra.tapirs.top`.

Verification performs bounded one-shot requests for the pages, Wasm, manifests,
terrain records, and image tiles. It does not open a persistent browser or leave
polling processes running. A visual browser check must close its page, browser
context, and process when complete.
