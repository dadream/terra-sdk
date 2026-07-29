[CmdletBinding()]
param(
  [string]$RepoRoot = '',
  [string]$EnvId = 'shunlu-api-test-d9fvhxfy3199a35a',
  [string]$BucketId = 'terra-testdata',
  [string]$PhysicalBucket =
    '7368-shunlu-api-test-d9fvhxfy3199a35a-1254147477',
  [string]$Region = 'ap-shanghai',
  [long]$LargeFileThresholdBytes = 104857600,
  [string]$GlobeDataRoot =
    'S:\terra-data\globe\cbdam-srtm-v2-global-geodetic'
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
} else {
  $RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
}
$EvidenceDir = Join-Path $RepoRoot 'viewer_verify_output\cloudbase'
$CosUploader = Join-Path $RepoRoot 'deploy\cloudbase\cos-uploader\upload.js'
$CosSdk = Join-Path $RepoRoot (
  'deploy\cloudbase\cos-uploader\node_modules\cos-nodejs-sdk-v5')
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null

$files = @(
  @{
    Source = Join-Path $RepoRoot 'testdata\datasets\ps_1k\reference\terrain.xml'
    Object = 'datasets/ps-1k/v1/terrain/terrain.xml'
  },
  @{
    Source = Join-Path $RepoRoot 'testdata\datasets\ps_1k\reference\terrain.root'
    Object = 'datasets/ps-1k/v1/terrain/terrain.root'
  },
  @{
    Source = Join-Path $RepoRoot 'testdata\datasets\ps_1k\reference\terrain.data'
    Object = 'datasets/ps-1k/v1/terrain/terrain.data'
  },
  @{
    Source = Join-Path $RepoRoot 'testdata\datasets\ps_1k\source\ps_texture_1k.png'
    Object = 'datasets/ps-1k/v1/texture/ps_texture_1k.png'
  },
  @{
    Source = Join-Path $GlobeDataRoot 'global_srtm_tol2.xml'
    Object = 'datasets/globe/v1/terrain/global_srtm_tol2.xml'
  },
  @{
    Source = Join-Path $GlobeDataRoot 'global_srtm_tol2.root'
    Object = 'datasets/globe/v1/terrain/global_srtm_tol2.root'
  },
  @{
    Source = Join-Path $GlobeDataRoot 'global_srtm_tol2.data'
    Object = 'datasets/globe/v1/terrain/global_srtm_tol2.data'
  }
)

$evidence = @()
$ErrorActionPreference = 'Continue'
foreach ($item in $files) {
  if (-not (Test-Path -LiteralPath $item.Source -PathType Leaf)) {
    throw "Missing deployment data: $($item.Source)"
  }
  $local = Get-Item -LiteralPath $item.Source
  $isLarge = $local.Length -ge $LargeFileThresholdBytes
  $hash = (Get-FileHash -LiteralPath $item.Source -Algorithm SHA256).Hash.ToLower()
  $md5 = (Get-FileHash -LiteralPath $item.Source -Algorithm MD5).Hash.ToLower()
  $contentType = switch ([IO.Path]::GetExtension($item.Source).ToLower()) {
    '.xml' { 'application/xml' }
    '.png' { 'image/png' }
    default { 'application/octet-stream' }
  }
  if ($isLarge) {
    if (-not (Test-Path -LiteralPath $CosUploader -PathType Leaf) -or
        -not (Test-Path -LiteralPath $CosSdk -PathType Container)) {
      throw (
        'COS multipart uploader is not installed. Run npm ci in ' +
        'deploy/cloudbase/cos-uploader.')
    }
    Write-Host (
      "Verifying physical COS object $BucketId/$($item.Object) " +
      "($($local.Length) bytes)")
    & node $CosUploader `
      --env $EnvId `
      --source $item.Source `
      --bucket $PhysicalBucket `
      --region $Region `
      --key "$BucketId/$($item.Object)"
    if ($LASTEXITCODE -ne 0) {
      throw "CloudBase COS multipart upload failed: $BucketId/$($item.Object)"
    }
    $evidence += [ordered]@{
      object = "$BucketId/$($item.Object)"
      bytes = $local.Length
      sha256 = $hash
      md5 = $md5
      etag = $null
      upload_mode = 'cos-multipart'
    }
    continue
  }

  $statText = (& tcb -e $EnvId storage objects stat $item.Object `
    -b $BucketId --json 2>$null | Out-String).Trim()
  $exists = $LASTEXITCODE -eq 0 -and
    -not [string]::IsNullOrWhiteSpace($statText)
  if ($exists) {
    $stat = $statText | ConvertFrom-Json
    $remoteSize = [long]$stat.data.body.size
    $remoteEtag = [string]$stat.data.body.etag
    $remoteEtag = $remoteEtag.Trim('"').ToLower()
    if ($remoteSize -ne $local.Length -or $remoteEtag -ne $md5) {
      throw "Immutable CloudBase object differs: $BucketId/$($item.Object)"
    }
    Write-Host "Verified existing $BucketId/$($item.Object)"
  } else {
    Write-Host "Uploading $BucketId/$($item.Object) ($($local.Length) bytes)"
    & tcb -e $EnvId storage objects upload $item.Source $item.Object `
      -b $BucketId --content-type $contentType --use-put --json
    if ($LASTEXITCODE -ne 0) {
      throw "CloudBase PG upload failed: $BucketId/$($item.Object)"
    }
    $statText = (& tcb -e $EnvId storage objects stat $item.Object `
      -b $BucketId --json 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($statText)) {
      throw "CloudBase PG stat failed: $BucketId/$($item.Object)"
    }
    $stat = $statText | ConvertFrom-Json
  }
  $evidence += [ordered]@{
    object = "$BucketId/$($item.Object)"
    bytes = $local.Length
    sha256 = $hash
    md5 = $md5
    etag = $stat.data.body.etag
    upload_mode = 'pg-put'
  }
}
$ErrorActionPreference = 'Stop'

$manifest = [ordered]@{
  schema = 'terra.cloudbase.data-upload.v1'
  environment = $EnvId
  bucket = $BucketId
  uploaded_at = (Get-Date).ToUniversalTime().ToString('o')
  files = $evidence
}
$manifestPath = Join-Path $EvidenceDir 'data_upload.json'
$manifest | ConvertTo-Json -Depth 5 |
  Set-Content -LiteralPath $manifestPath -Encoding UTF8
Write-Host "CloudBase versioned data upload passed."
Write-Host "Evidence: $manifestPath"
