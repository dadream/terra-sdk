# Lighthouse Deployment

This deployment runs the two terrain services and the imagery service on the
`terra` SSH host. Caddy exposes one HTTPS origin, `https://terra.tapirs.top`,
and manages its TLS certificate automatically.

The current server is in Tencent Cloud's Beijing region. DNS and open ports are
not sufficient for public access: complete ICP filing, or Tencent Cloud access
filing when the domain was filed elsewhere, before accepting the public HTTPS
gate. Tencent Cloud documents that unfiled domains on mainland servers are
automatically blocked.

Runtime data is stored under `/srv/terra/data`. It is copied from the private
CloudBase COS prefix with a short-lived, read-only STS credential; no permanent
COS key is stored on the server. The services never read COS at request time.

```bash
# From WSL, after the CMake build has produced terra_terrain_service:
bash scripts/prepare_lighthouse_images.sh
```

```powershell
# From Windows PowerShell with an authenticated CloudBase CLI:
node deploy/cloudbase/cos-uploader/sync_lighthouse.js `
  --env shunlu-api-test-d9fvhxfy3199a35a `
  --bucket 7368-shunlu-api-test-d9fvhxfy3199a35a-1254147477 `
  --region ap-shanghai --host terra
```

```bash
# From WSL; TERRA_TIANDITU_TOKEN is optional for static imagery-only use:
TERRA_TIANDITU_TOKEN=... \
TERRA_LIGHTHOUSE_PUBLIC_ORIGIN=http://49.233.185.96 \
  bash scripts/deploy_lighthouse.sh
bash scripts/verify_lighthouse_services.sh
```

After filing, set `TERRA_LIGHTHOUSE_PUBLIC_ORIGIN=https://terra.tapirs.top`.

Omitting `TERRA_TIANDITU_TOKEN` preserves the token already installed on the
server. Set it explicitly to replace the token, or set it to an empty value to
clear the token.

The deployment keeps Tianditu's runtime disk cache at
`/srv/terra/cache/tianditu`. Remove the obsolete CloudBase cache only through
the guarded command below. It refuses every prefix except
`terra-tianditu-cache/`.

```powershell
node deploy/cloudbase/cos-uploader/prune.js `
  --env shunlu-api-test-d9fvhxfy3199a35a `
  --bucket 7368-shunlu-api-test-d9fvhxfy3199a35a-1254147477 `
  --region ap-shanghai `
  --prefix terra-tianditu-cache/ `
  --confirm-prefix terra-tianditu-cache/
```

Do not add `.env`, image archives, COS credentials, or copied datasets to Git.
