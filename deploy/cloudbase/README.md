# CloudBase Deployment

This directory contains the source-only deployment templates for the three
CloudBase Run services:

- `terra-terrain-1k`: PS 1k planar terrain and local validation texture.
- `terra-terrain-globe`: global CBDAM terrain.
- `terra-tianditu-proxy`: Tianditu `img-c` HTTPS proxy with persistent cache.

Before deployment, create a CloudBase resource connection of type `cloud-api`
named `terra-cos-mount-v2`. Use a dedicated CAM sub-user and attach
[`COS_MOUNT_POLICY.json`](COS_MOUNT_POLICY.json). The policy allows listing
only this bucket, read-only object access under `terra-testdata/`, and
read-write access under `terra-tianditu-cache/`. The copy/delete permissions
support atomic cache-file replacement. Record only the non-secret connection
`KeyID`; never place its SecretId or SecretKey in the repository.

Run the deployment workflow from Windows PowerShell after the standard CMake gate:

```powershell
wsl -d Ubuntu-22.04 -- bash -lc `
  "cd /home/holo/terra-sdk-anti/terra-sdk-miniprogram && `
   bash scripts/prepare_cloudbase_terrain.sh"
.\scripts\upload_cloudbase_data.ps1
$env:TERRA_TIANDITU_TOKEN = '<server token>'
$env:TERRA_COS_CONNECTION_KEY_ID = '<resource connection KeyID>'
.\scripts\deploy_cloudbase_services.ps1
.\scripts\verify_cloudbase_services.ps1
Remove-Item Env:TERRA_TIANDITU_TOKEN
Remove-Item Env:TERRA_COS_CONNECTION_KEY_ID
```

When all three images have already been built, add `-ReuseLatestImages` to
skip source builds and publish the latest recorded images with the COS mounts.
For a fresh source build, the script creates a temporary canary only to obtain
the image, rolls that canary back, and then performs one `FULL` release with
the required mount configuration. The mount endpoint must be the complete,
resolvable COS endpoint `https://cos.<region>.myqcloud.com`.

## Storage API And RLS

The CloudBase console may warn that the logical PG Storage bucket
`terra-testdata` has no RLS policy and that API access is denied. This is the
intended configuration:

- Mini Program clients never call the PG Storage API directly.
- CloudBase Run mounts the physical COS bucket through the dedicated CAM
  resource connection.
- Terrain objects and imagery cache remain inaccessible to
  `anon`/`authenticated` Storage API roles.

Do not add a public or blanket RLS policy to silence the warning. Add a
client-facing RLS policy only if direct Storage API access becomes an explicit
product requirement and is reviewed separately.

## Mini Program Test Routing

The test app uses `wx.cloud.callContainer` for both terrain services. Imagery
uses the `terra-tianditu-proxy` public HTTPS domain because the current WebGL
loader assigns tile URLs to `canvas.createImage().src`. This keeps the
Tianditu token server-side while preserving the native image decoding path.
The proxy domain may need to be registered in the Mini Program network-domain
configuration for real-device and release builds.

This public image endpoint is for the current test acceptance environment.
Although it hides the Tianditu token, an unauthenticated public caller could
consume upstream quota. Before production, either load proxy bytes through
`wx.cloud.callContainer` and a local temporary image file, or add reviewed
gateway authentication, rate limits, and quotas.

Follow
[`docs/cloudbase/MINIPROGRAM_ACCEPTANCE.md`](../../docs/cloudbase/MINIPROGRAM_ACCEPTANCE.md)
for the DevTools planar/globe visual acceptance sequence and required evidence.

Generated binaries, upload manifests, deployment details, and verification
evidence stay under `viewer_verify_output/cloudbase/`. Terrain data is mounted
read-only from `/terra-testdata`; proxy cache is mounted read-write from
`/terra-tianditu-cache` and stores JPEG files as:

```text
img-c/v1/z/{z}/x/{x}/y/{y}.jpg
```

Large terrain objects that exceed the CloudBase PG Storage single-upload limit use the official COS multipart uploader:

```powershell
cd deploy/cloudbase/cos-uploader
npm ci
node upload.js `
  --env shunlu-api-test-d9fvhxfy3199a35a `
  --source S:\\terra-data\\globe\\cbdam-srtm-v2-global-geodetic\\global_srtm_tol2.data `
  --bucket 7368-shunlu-api-test-d9fvhxfy3199a35a-1254147477 `
  --region ap-shanghai `
  --key terra-testdata/datasets/globe/v1/terrain/global_srtm_tol2.data
```

The uploader asks STS `GetFederationToken` for a 15-minute credential scoped
to the one target object. It never reads or prints the permanent local login
credential, uses 20 MiB multipart slices, and verifies the final object size. The main upload script selects this
path automatically for files of 100 MiB or larger.

Multipart uploads write the physical COS object directly. They do not create a
row in the logical PG Storage metadata table, so the CloudBase PG bucket page
may not list `global_srtm_tol2.data`. Verify the physical COS key and exact
size with the uploader's idempotent `HeadObject` check, then verify an actual
terrain patch through the Run service.

Never add a Tianditu token, generated deployment context, or terrain repository
to Git.
