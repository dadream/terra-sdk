[CmdletBinding()]
param(
  [string]$RepoRoot = '',
  [string]$DeploymentEvidence = ''
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
} else {
  $RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
}
if ([string]::IsNullOrWhiteSpace($DeploymentEvidence)) {
  $DeploymentEvidence =
    Join-Path $RepoRoot 'viewer_verify_output\cloudbase\deployment.json'
}
if (-not (Test-Path -LiteralPath $DeploymentEvidence)) {
  throw "Missing deployment evidence: $DeploymentEvidence"
}

function Wait-ServiceReady {
  param([string]$ServiceName, [string]$Domain, [int]$TimeoutSeconds = 180)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastFailure = 'not attempted'
  do {
    try {
      $ready = Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 `
        -Uri "$Domain/readyz"
      if ($ready.StatusCode -eq 200) {
        return
      }
      $lastFailure = "HTTP $($ready.StatusCode)"
    } catch {
      $lastFailure = $_.Exception.Message
    }
    Start-Sleep -Seconds 5
  } while ((Get-Date) -lt $deadline)
  throw "$ServiceName readiness timed out: $lastFailure"
}

$deployment = Get-Content -LiteralPath $DeploymentEvidence -Raw |
  ConvertFrom-Json
$services = @{}
foreach ($service in $deployment.services) {
  $services[$service.name] = $service
}
foreach ($required in @(
  'terra-terrain-1k', 'terra-terrain-globe', 'terra-tianditu-proxy')) {
  if (-not $services.ContainsKey($required)) {
    throw "Missing deployed service: $required"
  }
  Wait-ServiceReady -ServiceName $required `
    -Domain $services[$required].domain
}

$planarManifest = Invoke-RestMethod -TimeoutSec 60 -Uri (
  "$($services['terra-terrain-1k'].domain)" +
  '/terra/v1/datasets/ps-1k/manifest')
if ($planarManifest.dataset_id -ne 'ps-1k') {
  throw 'Planar manifest dataset mismatch.'
}
$globeManifest = Invoke-RestMethod -TimeoutSec 60 -Uri (
  "$($services['terra-terrain-globe'].domain)" +
  '/terra/v1/datasets/globe/manifest')
if ($globeManifest.dataset_id -ne 'globe' -or
    $globeManifest.transform.kind -ne 'cylindrical') {
  throw 'Globe manifest contract mismatch.'
}

$planarPatchPath = Join-Path ([IO.Path]::GetTempPath()) (
  'terra-planar-patch-' + [Guid]::NewGuid().ToString('N') + '.bin')
$globePatchPath = Join-Path ([IO.Path]::GetTempPath()) (
  'terra-globe-patch-' + [Guid]::NewGuid().ToString('N') + '.bin')
try {
  $planarPatch = Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 `
    -Uri ("$($services['terra-terrain-1k'].domain)" +
      '/terra/v1/datasets/ps-1k/patches/-268435456/0/268435456') `
    -OutFile $planarPatchPath -PassThru
  $globePatch = Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 `
    -Uri ("$($services['terra-terrain-globe'].domain)" +
      '/terra/v1/datasets/globe/patches/-134217728/134217728/-134217728') `
    -OutFile $globePatchPath -PassThru
  $planarPatchBytes = [IO.File]::ReadAllBytes($planarPatchPath)
  $globePatchBytes = [IO.File]::ReadAllBytes($globePatchPath)
  if ($planarPatch.StatusCode -ne 200 -or $planarPatchBytes.Length -le 0) {
    throw 'Planar patch request failed.'
  }
  if ($globePatch.StatusCode -ne 200 -or $globePatchBytes.Length -le 0) {
    throw 'Beijing globe patch request failed.'
  }
} finally {
  foreach ($path in @($planarPatchPath, $globePatchPath)) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force
    }
  }
}

$tileUrl = "$($services['terra-tianditu-proxy'].domain)" +
  '/terra/v1/imagery/tianditu/img-c/3/13/2.jpg'
$tilePath = Join-Path ([IO.Path]::GetTempPath()) (
  'terra-tianditu-' + [Guid]::NewGuid().ToString('N') + '.jpg')
try {
  $firstTile = Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 `
    -Uri $tileUrl -OutFile $tilePath -PassThru
  $bytes = [IO.File]::ReadAllBytes($tilePath)
  $secondTile = Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri $tileUrl
  if ($firstTile.StatusCode -ne 200 -or $secondTile.StatusCode -ne 200) {
    throw 'Tianditu proxy tile request failed.'
  }
  if ($firstTile.Headers['Content-Type'] -notmatch '^image/jpeg' -or
      $bytes.Length -lt 4) {
    throw 'Tianditu proxy did not return a JPEG.'
  }
  if ($secondTile.Headers['X-Terra-Cache'] -notmatch '^HIT') {
    throw 'Tianditu proxy second request was not a cache hit.'
  }
  if ($bytes[0] -ne 0xff -or $bytes[1] -ne 0xd8 -or
      $bytes[2] -ne 0xff) {
    throw 'Tianditu proxy JPEG signature is invalid.'
  }
} finally {
  if (Test-Path -LiteralPath $tilePath) {
    Remove-Item -LiteralPath $tilePath -Force
  }
}

$result = [ordered]@{
  schema = 'terra.cloudbase.verification.v1'
  verified_at = (Get-Date).ToUniversalTime().ToString('o')
  planar_dataset = $planarManifest.dataset_id
  globe_dataset = $globeManifest.dataset_id
  globe_transform = $globeManifest.transform
  planar_patch_bytes = $planarPatchBytes.Length
  globe_beijing_patch_bytes = $globePatchBytes.Length
  imagery_content_type = $firstTile.Headers['Content-Type']
  imagery_first_cache = $firstTile.Headers['X-Terra-Cache']
  imagery_second_cache = $secondTile.Headers['X-Terra-Cache']
  imagery_bytes = $bytes.Length
}
$evidenceDir = Join-Path $RepoRoot 'viewer_verify_output\cloudbase'
$resultPath = Join-Path $evidenceDir 'verification.json'
$result | ConvertTo-Json -Depth 5 |
  Set-Content -LiteralPath $resultPath -Encoding UTF8
Write-Host 'CloudBase service verification passed.'
Write-Host "Evidence: $resultPath"
