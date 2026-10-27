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
  'terra-terrain-1k', 'terra-terrain-globe', 'terra-imagery')) {
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

$imageryOrigin = $services['terra-imagery'].domain
$planarImageryManifest = Invoke-RestMethod -TimeoutSec 60 -Uri (
  "$imageryOrigin/terra/v1/imagery/ps-1k/manifest")
$blueMarbleManifest = Invoke-RestMethod -TimeoutSec 60 -Uri (
  "$imageryOrigin/terra/v1/imagery/blue-marble/manifest")
$tiandituManifest = Invoke-RestMethod -TimeoutSec 60 -Uri (
  "$imageryOrigin/terra/v1/imagery/tianditu-img-c/manifest")
if ($planarImageryManifest.schema -ne 'terra.imagery-manifest' -or
    $planarImageryManifest.kind -ne 'planar-tms' -or
    $planarImageryManifest.matrix.maximum_level -ne 2) {
  throw 'Planar imagery manifest contract mismatch.'
}
if ($blueMarbleManifest.kind -ne 'global-geodetic' -or
    $blueMarbleManifest.matrix.maximum_level -ne 7 -or
    $blueMarbleManifest.matrix.matrix_level_offset -ne 0) {
  throw 'Blue Marble imagery manifest contract mismatch.'
}
if ($tiandituManifest.kind -ne 'global-geodetic' -or
    $tiandituManifest.matrix.matrix_level_offset -ne 1) {
  throw 'Tianditu imagery manifest contract mismatch.'
}
if ($planarManifest.textures[0].kind -ne 'planar-tms' -or
    $planarManifest.textures[0].manifest_url -ne
      "$imageryOrigin/terra/v1/imagery/ps-1k/manifest") {
  throw 'Planar terrain manifest is not linked to the imagery service.'
}
if ($globeManifest.textures[0].id -ne 'blue-marble' -or
    $globeManifest.textures[0].manifest_url -ne
      "$imageryOrigin/terra/v1/imagery/blue-marble/manifest") {
  throw 'Globe terrain manifest is not linked to Blue Marble imagery.'
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

$imageChecks = @(
  @{
    Id = 'ps-1k'
    Url = "$imageryOrigin/terra/v1/imagery/ps-1k/2/3/0.jpg"
  },
  @{
    Id = 'blue-marble'
    Url = "$imageryOrigin/terra/v1/imagery/blue-marble/7/210/35.jpg"
  },
  @{
    Id = 'tianditu-img-c'
    Url = "$imageryOrigin/terra/v1/imagery/tianditu/img-c/3/13/2.jpg"
  }
)
$imageryEvidence = @()
foreach ($check in $imageChecks) {
  $tilePath = Join-Path ([IO.Path]::GetTempPath()) (
    'terra-imagery-' + [Guid]::NewGuid().ToString('N') + '.jpg')
  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 `
      -Uri $check.Url -OutFile $tilePath -PassThru
    $bytes = [IO.File]::ReadAllBytes($tilePath)
    if ($response.StatusCode -ne 200 -or
        $response.Headers['Content-Type'] -notmatch '^image/jpeg' -or
        $bytes.Length -lt 4 -or $bytes[0] -ne 0xff -or
        $bytes[1] -ne 0xd8 -or $bytes[2] -ne 0xff) {
      throw "$($check.Id) imagery tile is not a valid JPEG."
    }
    $imageryEvidence += [ordered]@{
      id = $check.Id
      bytes = $bytes.Length
      cache = $response.Headers['X-Terra-Cache']
    }
  } finally {
    if (Test-Path -LiteralPath $tilePath) {
      Remove-Item -LiteralPath $tilePath -Force
    }
  }
}
$tiandituSecond = Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 `
  -Uri $imageChecks[2].Url
if ($tiandituSecond.StatusCode -ne 200 -or
    $tiandituSecond.Headers['X-Terra-Cache'] -notmatch '^HIT') {
  throw 'Tianditu second request was not served from cache.'
}

$result = [ordered]@{
  schema = 'terra.cloudbase.verification.v1'
  verified_at = (Get-Date).ToUniversalTime().ToString('o')
  planar_dataset = $planarManifest.dataset_id
  globe_dataset = $globeManifest.dataset_id
  globe_transform = $globeManifest.transform
  planar_patch_bytes = $planarPatchBytes.Length
  globe_beijing_patch_bytes = $globePatchBytes.Length
  planar_imagery = $planarImageryManifest
  blue_marble_imagery = $blueMarbleManifest
  tianditu_imagery = $tiandituManifest
  imagery_tiles = $imageryEvidence
  tianditu_second_cache = $tiandituSecond.Headers['X-Terra-Cache']
}
$evidenceDir = Join-Path $RepoRoot 'viewer_verify_output\cloudbase'
$resultPath = Join-Path $evidenceDir 'verification.json'
$result | ConvertTo-Json -Depth 5 |
  Set-Content -LiteralPath $resultPath -Encoding UTF8
Write-Host 'CloudBase service verification passed.'
Write-Host "Evidence: $resultPath"
