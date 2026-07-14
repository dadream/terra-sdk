# Terrain Service v1

## Purpose

`terra_terrain_service` exposes existing CBDAM `terrain.xml`, `terrain.root`,
and `terrain.data` repositories through a versioned HTTP contract. The service
is an adapter: it does not convert repository files, and Mini Program clients
never open VIC VFS or Berkeley DB storage.

The reference server is intentionally single-process and sequential. Run it
read-only behind an HTTPS reverse proxy and a process supervisor. Multiple
service processes may be used for scale because repository access is read-only.

## Start The Service

Build in the fixed Docker environment, then run:

```bash
terra_terrain_service \
  --dataset-id globe \
  --terrain /srv/terra/globe/terrain \
  --bind 127.0.0.1 \
  --port 18081 \
  --min-level 0 \
  --max-level 30 \
  --texture-id blue-marble \
  --texture-kind global-geodetic \
  --texture-template 'https://assets.example.com/blue-marble/{z}/{x}/{y}.jpg' \
  --texture-level-offset 0 \
  --texture-max-level 8
```

`--terrain` is the base path without `.xml`, `.root`, or `.data`. The runtime
image must provide the C++ runtime, pthreads, and Berkeley DB 5.3 used by the
legacy read-only repository adapter; the maintained Docker image fixes these
dependencies. Dataset and texture IDs accept only ASCII letters, digits, `_`,
and `-`. Texture templates are
metadata only; this service does not proxy imagery or store provider tokens.

## HTTP Contract

All paths are relative to the HTTPS deployment origin:

| Method | Path | Result |
| --- | --- | --- |
| `GET`, `HEAD` | `/terra/v1/datasets/{dataset}/manifest` | Dataset manifest JSON |
| `GET`, `HEAD` | `/terra/v1/datasets/{dataset}/roots/{i}/{j}/{k}` | Root patch record |
| `GET`, `HEAD` | `/terra/v1/datasets/{dataset}/patches/{i}/{j}/{k}` | Detail patch record |

Patch coordinates are strict decimal integers inside the CBDAM grid range
`[-268435456, 268435456]`. Unknown datasets and missing records return `404`;
malformed paths or keys return `400`; unsupported methods return `405`.
Errors use `application/problem+json` and never expose repository paths.

The manifest contains:

- schema and repository format version;
- dataset ID, patch dimension, height scale, SRS, and description;
- planar or cylindrical transform, bounds, radius, and root count;
- supported level range and CBDAM record framing;
- root/detail endpoint templates;
- zero or more credential-free texture descriptors.

Patch responses use `application/octet-stream` and preserve the exact bytes
returned by the current repository reader. They include:

```text
X-Terra-Format-Version: 1
X-Terra-Checksum: fnv1a64:<16 lowercase hex digits>
ETag: "fnv1a64-<hash>-<length>"
Cache-Control: public, max-age=31536000, immutable
Content-Length: <record bytes>
```

`If-None-Match` returns `304`. A dataset ID is an immutable content version:
when metadata or either repository changes, publish a new ID rather than
overwriting the old dataset. This invariant makes the one-year immutable patch
cache safe. FNV-1a detects transport or cache corruption; it
is not an authentication primitive. HTTPS and trusted deployment controls
provide transport authenticity. The client must validate `Content-Length` and
`X-Terra-Checksum` before submitting a record to Wasm.

## HTTPS Deployment

Bind the service to loopback and terminate TLS at the reverse proxy. A minimal
Nginx location is:

```nginx
location /terra/ {
    proxy_pass http://127.0.0.1:18081;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering on;
}
```

Production deployment must use a valid public certificate, restrict filesystem
access to the configured read-only dataset, cap request/header sizes, and apply
normal connection/rate limits at the proxy. Do not publish `.root` or `.data`
as static files and do not derive filesystem paths from request segments.

## WeChat Mini Program Setup

1. Deploy the service on an HTTPS domain controlled by the application owner.
2. Add that exact domain to the Mini Program request-domain allowlist.
3. Fetch the manifest as JSON with `wx.request`.
4. Fetch patch endpoints with `responseType: 'arraybuffer'`.
5. Apply concurrency, cancellation, retries, and compressed cache policy in
   TypeScript.
6. Validate length and checksum, then pass bytes to the Terra Wasm C ABI.

Do not add the 768 MiB globe `terrain.data` repository to
`apps/miniprogram`. Tianditu credentials are supplied to the imagery request
layer at runtime and must not appear in service arguments, manifests, source,
reports, or logs.

## Verification

Run the checked-in 1k HTTP contract and negative tests:

```bash
bash scripts/verify_terrain_service.sh
```

Run byte parity against the external 768 MiB cylindrical globe repository:

```bash
GLOBE_DATA_DIR=/mnt/s/terra-data/globe \
  bash scripts/verify_terrain_service_globe.sh
```

The first gate checks manifest/root/detail requests, fixed SHA-256 values,
ETag/304, HEAD, `400`/`404`/`405`, log budget, and package exclusion. The globe
gate checks cylindrical metadata and exact root/detail payloads, including the
checked-in 48-byte M2 patch fixture.