# Unified Imagery Service

## Purpose

`terra-imagery` is the single public HTTPS image origin for the Mini Program.
It keeps terrain delivery independent from imagery delivery while preserving
the three-service deployment:

- `terra-terrain-1k`: planar CBDAM records.
- `terra-terrain-globe`: cylindrical CBDAM records.
- `terra-imagery`: PS 1k tiles, Blue Marble tiles, and cached Tianditu tiles.

Terrain manifests link to the matching imagery manifest through
`textures[].manifest_url`. The SDK does not require terrain and imagery to be
hosted by the same service.

## HTTP Contract

Metadata endpoints:

```text
GET /terra/v1/imagery/ps-1k/manifest
GET /terra/v1/imagery/blue-marble/manifest
GET /terra/v1/imagery/tianditu-img-c/manifest
```

Tile endpoints:

```text
GET /terra/v1/imagery/ps-1k/{z}/{x}/{y}.jpg
GET /terra/v1/imagery/blue-marble/{z}/{x}/{y}.jpg
GET /terra/v1/imagery/tianditu/img-c/{z}/{x}/{y}.jpg
```

Every manifest uses `terra.imagery-manifest` version 1 and declares the image
kind, bounds, tile size, level-zero matrix, level offset, level range, row
origin, JPEG format, and absolute URL template. Public `y` is always top-left.
VicTMS files use bottom-origin rows, so the service performs
`repository_y = row_count - 1 - public_y` before reading a static tile.

## Storage Layout

The imagery service mounts the physical COS bucket once:

```text
/ -> /mnt/terra-cos
DATA_ROOT  = /mnt/terra-cos/terra-testdata
CACHE_ROOT = /mnt/terra-cos/terra-tianditu-cache
```

A single mount avoids duplicate cosfs mounts of the same bucket. The resource
connection's CAM policy denies writes under `terra-testdata` and allows them
only under `terra-tianditu-cache`.

Static collections are immutable and versioned:

```text
terra-testdata/datasets/ps-1k/v1/imagery/ps-1k/00..02/...
terra-testdata/datasets/globe/v1/imagery/blue-marble/00..07/...
```

Files retain the VicTMS directory hierarchy and `.jpg` extension. The
Tianditu cache uses `img-c/v1/z/{z}/x/{x}/y/{y}.jpg`, expires after one year,
and can serve a stale tile temporarily when the upstream service fails.

## Upload And Deployment

Install the official COS client once, then upload terrain and both imagery
collections:

```powershell
cd deploy/cloudbase/cos-uploader
npm ci
cd ..\..\..
.\scripts\upload_cloudbase_data.ps1
```

The uploader requests one temporary credential per object or collection. It
checks existing object sizes and refuses to overwrite a different immutable
object. Blue Marble is read from
`S:\terra-data\globe\blue-marble-global-geodetic` by default and is never
committed to Git.

Deploy and verify from Windows PowerShell:

```powershell
$env:TERRA_TIANDITU_TOKEN = '<server token>'
$env:TERRA_COS_CONNECTION_KEY_ID = '<resource connection KeyID>'
.\scripts\deploy_cloudbase_services.ps1
.\scripts\verify_cloudbase_services.ps1
```

The verifier checks all three readiness endpoints, both terrain manifests,
all imagery manifests, representative static JPEGs, a Beijing globe patch,
and the second-request Tianditu cache hit.

## Mini Program Acceptance

The checked-in runtime uses `imageryServiceOrigin`; storage key
`terra.imageryServiceOrigin` may override it for a test deployment. Register
the imagery HTTPS domain for `canvas.createImage` before device validation.

For planar acceptance, confirm the initial texture and use `+` repeatedly
until finer texture tiles replace the ancestor tile without gaps. For globe
acceptance, verify Blue Marble first, then select Tianditu and confirm the
attribution remains visible while pan, zoom, top view, tilt, and reset operate.
Record screenshots and the DevTools network requests for both modes.
