[CmdletBinding()]
param(
  [string]$RepoRoot = '',
  [string]$EnvId = 'shunlu-api-test-d9fvhxfy3199a35a',
  [string]$PhysicalBucket =
    '7368-shunlu-api-test-d9fvhxfy3199a35a-1254147477',
  [string]$Region = 'ap-shanghai',
  [string]$StorageKeyId = $env:TERRA_COS_CONNECTION_KEY_ID,
  [switch]$ReuseLatestImages
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
} else {
  $RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
}
$EvidenceDir = Join-Path $RepoRoot 'viewer_verify_output\cloudbase'
$StagingRoot = Join-Path $EvidenceDir 'staging'
$TcbJsonHelper = Join-Path $RepoRoot 'scripts\invoke_tcb_json.js'
$token = $env:TERRA_TIANDITU_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
  throw 'Set TERRA_TIANDITU_TOKEN before deploying the imagery service.'
}
if ($token -notmatch '^[A-Za-z0-9_-]{16,128}$') {
  throw 'TERRA_TIANDITU_TOKEN has an invalid format.'
}
if ([string]::IsNullOrWhiteSpace($StorageKeyId)) {
  throw 'Pass -StorageKeyId or set TERRA_COS_CONNECTION_KEY_ID.'
}
if ($StorageKeyId -notmatch '^[A-Za-z][A-Za-z0-9_-]{0,127}$') {
  throw 'StorageKeyId has an invalid format.'
}

function Invoke-TcbJson {
  param([string[]]$Arguments)
  if (-not (Test-Path -LiteralPath $TcbJsonHelper -PathType Leaf)) {
    throw "Missing CloudBase JSON helper: $TcbJsonHelper"
  }
  $nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
  $nativeArguments = @()
  $body = ''
  for ($index = 0; $index -lt $Arguments.Count; $index++) {
    if ($Arguments[$index] -eq '--body') {
      if ($index + 1 -ge $Arguments.Count) {
        throw 'Missing value after --body.'
      }
      $body = $Arguments[$index + 1]
      $index++
      continue
    }
    $nativeArguments += $Arguments[$index]
  }

  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $text = (
      $body |
        & $nodeCommand $TcbJsonHelper @nativeArguments 2>$null |
        Out-String
    ).Trim()
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($exitCode -ne 0) {
    $operation = ($Arguments |
      Where-Object { $_ -ne '--body' -and $_ -notmatch '^\{' } |
      Select-Object -First 4) -join ' '
    throw "tcb command failed: $operation"
  }
  if ([string]::IsNullOrWhiteSpace($text)) {
    return $null
  }
  $firstBrace = $text.IndexOf('{')
  $lastBrace = $text.LastIndexOf('}')
  if ($firstBrace -lt 0 -or $lastBrace -lt $firstBrace) {
    throw 'tcb command returned no JSON object.'
  }
  return $text.Substring(
    $firstBrace, $lastBrace - $firstBrace + 1) | ConvertFrom-Json
}

function Get-ServiceDetail {
  param([string]$ServiceName)
  $body = @{
    EnvId = $EnvId
    ServerName = $ServiceName
  } | ConvertTo-Json -Compress
  return Invoke-TcbJson @(
    'api', 'tcbr', 'DescribeCloudRunServerDetail',
    '--api-version', '2022-02-17', '--body', $body)
}

function Get-DeploymentRecords {
  param([string]$ServiceName)
  $body = @{
    EnvId = $EnvId
    ServerName = $ServiceName
  } | ConvertTo-Json -Compress
  return Invoke-TcbJson @(
    'api', 'tcbr', 'DescribeCloudRunDeployRecord',
    '--api-version', '2022-02-17', '--body', $body)
}

function Test-ServiceExists {
  param([string]$ServiceName)
  $response = Invoke-TcbJson @('-e', $EnvId, 'cloudrun', 'list')
  $names = @(
    $response.data.ServerList | ForEach-Object { $_.ServerName })
  return $names -contains $ServiceName
}

function Wait-DeploymentImage {
  param(
    [string]$ServiceName,
    [string[]]$PreviousRunIds,
    [int]$TimeoutSeconds = 900
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastStatus = 'waiting'
  do {
    Start-Sleep -Seconds 5
    $response = Get-DeploymentRecords $ServiceName
    $record = $response.data.DeployRecords |
      Where-Object { $_.RunId -notin $PreviousRunIds } |
      Sort-Object DeployTime -Descending |
      Select-Object -First 1
    if ($null -eq $record) {
      continue
    }
    $lastStatus = $record.Status
    if ($record.Status -in @('normal', 'running', 'deploy_failed') -and
        -not [string]::IsNullOrWhiteSpace($record.ImageUrl)) {
      return $record
    }
    if ($record.Status -match 'failed') {
      throw "$ServiceName source deployment entered status $($record.Status)"
    }
  } while ((Get-Date) -lt $deadline)
  throw (
    "Timed out waiting for $ServiceName source image; " +
    "last deployment status: $lastStatus")
}

function Wait-ReleaseClosed {
  param(
    [string]$ServiceName,
    [string]$RunId,
    [int]$TimeoutSeconds = 300
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Seconds 3
    $response = Get-DeploymentRecords $ServiceName
    $record = $response.data.DeployRecords |
      Where-Object { $_.RunId -eq $RunId } |
      Select-Object -First 1
    if ($null -eq $record -or $record.IsReleasing -ne $true) {
      return
    }
  } while ((Get-Date) -lt $deadline)
  throw "Timed out waiting for $ServiceName source release to close"
}

function Get-LatestImage {
  param([string]$ServiceName)
  $response = Get-DeploymentRecords $ServiceName
  $record = $response.data.DeployRecords |
    Where-Object {
      $_.Status -in @('normal', 'running', 'deploy_failed') -and
      -not [string]::IsNullOrWhiteSpace($_.ImageUrl)
    } |
    Sort-Object DeployTime -Descending |
    Select-Object -First 1
  if ($null -eq $record) {
    throw "No reusable image found for $ServiceName"
  }
  Write-Host "$ServiceName reusing build $($record.BuildId)"
  return $record.ImageUrl
}

function Wait-Service {
  param(
    [string]$ServiceName,
    [string[]]$PreviousRunIds,
    [int]$TimeoutSeconds = 900
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastStatus = 'waiting'
  do {
    Start-Sleep -Seconds 5
    $response = Get-DeploymentRecords $ServiceName
    $record = $response.data.DeployRecords |
      Where-Object { $_.RunId -notin $PreviousRunIds } |
      Sort-Object DeployTime -Descending |
      Select-Object -First 1
    if ($null -eq $record) {
      continue
    }
    $lastStatus = $record.Status
    if ($record.Status -in @('normal', 'running')) {
      return Get-ServiceDetail $ServiceName
    }
    if ($record.Status -match 'failed') {
      throw "$ServiceName deployment entered status $($record.Status)"
    }
  } while ((Get-Date) -lt $deadline)
  throw (
    "Timed out waiting for CloudBase Run service $ServiceName; " +
    "last deployment status: $lastStatus")
}

function Update-ServiceConfig {
  param(
    [string]$ServiceName,
    [string]$ImageUrl,
    [object[]]$Volumes,
    [hashtable]$Environment
  )
  $items = @(
    @{ Key = 'OperationMode'; Value = 'alwaysScale' },
    @{ Key = 'MinNum'; IntValue = 0 },
    @{ Key = 'MaxNum'; IntValue = 5 },
    @{ Key = 'TimerScale'; TimerScale = @() },
    @{ Key = 'Port'; IntValue = 8080 },
    @{ Key = 'AccessTypes'; ArrayValue = @('PUBLIC', 'MINIAPP') },
    @{ Key = 'VolumesConf'; VolumesConf = $Volumes }
  )
  if ($Environment.Count -gt 0) {
    $items += @{
      Key = 'EnvParam'
      Value = ($Environment | ConvertTo-Json -Compress)
    }
  }
  $body = @{
    EnvId = $EnvId
    ServerName = $ServiceName
    DeployInfo = @{
      DeployType = 'image'
      ImageUrl = $ImageUrl
      ReleaseType = 'FULL'
    }
    Items = $items
  } | ConvertTo-Json -Depth 8 -Compress
  $previous = Get-DeploymentRecords $ServiceName
  $previousRunIds = @(
    $previous.data.DeployRecords | ForEach-Object { $_.RunId })
  Invoke-TcbJson @(
    'api', 'tcbr', 'UpdateCloudRunServer',
    '--api-version', '2022-02-17', '--body', $body) | Out-Null
  return Wait-Service -ServiceName $ServiceName `
    -PreviousRunIds $previousRunIds
}

function Deploy-Source {
  param([string]$ServiceName, [string]$Source)
  Write-Host "Building $ServiceName source image"
  $previousRunIds = @()
  $serviceExisted = Test-ServiceExists $ServiceName
  if ($serviceExisted) {
    $previous = Get-DeploymentRecords $ServiceName
    $previousRunIds = @(
      $previous.data.DeployRecords | ForEach-Object { $_.RunId })
  }
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & tcb -e $EnvId cloudrun deploy `
      --serviceName $ServiceName `
      --port 8080 `
      --source $Source `
      --force `
      --traffic `
      --json
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($exitCode -ne 0) {
    throw "CloudBase Run source deployment failed: $ServiceName"
  }
  $record = Wait-DeploymentImage -ServiceName $ServiceName `
    -PreviousRunIds $previousRunIds
  Write-Host (
    "$ServiceName image ready: status=$($record.Status), " +
    "build=$($record.BuildId)")
  if ($record.Status -eq 'deploy_failed') {
    Write-Host (
      "$ServiceName bootstrap container did not start before its runtime " +
      'mounts and environment were applied; publishing the built image.')
  }

  if ($record.IsReleasing -eq $true) {
    $trafficAction = if ($serviceExisted) { 'rollback' } else { 'promote' }
    Write-Host (
      "Closing $ServiceName source-build release with $trafficAction")
    $previousPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      & tcb -e $EnvId cloudrun traffic $trafficAction `
        --serviceName $ServiceName `
        --json
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) {
      $releaseResponse = Get-DeploymentRecords $ServiceName
      $currentRelease = $releaseResponse.data.DeployRecords |
        Where-Object { $_.RunId -eq $record.RunId } |
        Select-Object -First 1
      if ($null -eq $currentRelease -or
          $currentRelease.IsReleasing -eq $true) {
        throw (
          "CloudBase Run source release $trafficAction failed: $ServiceName")
      }
      Write-Host (
        "$ServiceName source release closed despite a nonzero traffic " +
        'command result.')
    }
    Wait-ReleaseClosed -ServiceName $ServiceName -RunId $record.RunId
  }
  return $record.ImageUrl
}

function Wait-HttpReady {
  param([string]$ServiceName, [string]$Domain, [int]$TimeoutSeconds = 180)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = 'not attempted'
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 `
        -Uri "$Domain/readyz"
      if ($response.StatusCode -eq 200) {
        return $response
      }
      $lastError = "HTTP $($response.StatusCode)"
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Seconds 3
  } while ((Get-Date) -lt $deadline)
  throw "$ServiceName readiness timed out: $lastError"
}

$terrain1k = Join-Path $StagingRoot 'terra-terrain-ps-1k'
$terrainGlobe = Join-Path $StagingRoot 'terra-terrain-globe'
$imagerySource = Join-Path $RepoRoot 'deploy\cloudbase\imagery'
foreach ($source in @($terrain1k, $terrainGlobe, $imagerySource)) {
  if (-not (Test-Path -LiteralPath (Join-Path $source 'Dockerfile'))) {
    throw "Missing deployment source: $source"
  }
}

$temporaryRoot = Join-Path 'C:\tmp' (
  'terra-cloudbase-deploy-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
try {
  $sources = [ordered]@{
    'terra-terrain-1k' = $terrain1k
    'terra-terrain-globe' = $terrainGlobe
    'terra-imagery' = $imagerySource
  }
  $images = @{}
  foreach ($entry in $sources.GetEnumerator()) {
    if ($ReuseLatestImages) {
      $images[$entry.Key] = Get-LatestImage $entry.Key
      continue
    }
    $target = Join-Path $temporaryRoot $entry.Key
    Copy-Item -LiteralPath $entry.Value -Destination $target -Recurse
    $images[$entry.Key] = Deploy-Source $entry.Key $target
  }

  # CloudBase passes Endpoint directly to cosfs; use the resolvable COS domain.
  $endpoint = "https://cos.$Region.myqcloud.com"
  $terrainVolume = @(@{
    Type = 'COS'
    BucketName = $PhysicalBucket
    Endpoint = $endpoint
    KeyID = $StorageKeyId
    DstPath = '/mnt/terra-data'
    SrcPath = '/terra-testdata'
    ReadOnly = $true
  })
  # Mount the bucket once for imagery. CloudBase/cosfs does not reliably
  # expose two prefixes from the same bucket as independent volumes.
  $imageryVolumes = @(@{
    Type = 'COS'
    BucketName = $PhysicalBucket
    Endpoint = $endpoint
    KeyID = $StorageKeyId
    DstPath = '/mnt/terra-cos'
    SrcPath = '/'
    ReadOnly = $false
  })

  $details = @{}
  $details['terra-imagery'] = Update-ServiceConfig `
    'terra-imagery' $images['terra-imagery'] $imageryVolumes @{
      TIANDITU_TOKEN = $token
      DATA_ROOT = '/mnt/terra-cos/terra-testdata'
      CACHE_ROOT = '/mnt/terra-cos/terra-tianditu-cache'
      HOST = '0.0.0.0'
      PORT = '8080'
    }
  $imageryOrigin = $details['terra-imagery'].data.BaseInfo.DefaultDomainName
  $details['terra-terrain-1k'] = Update-ServiceConfig `
    'terra-terrain-1k' $images['terra-terrain-1k'] $terrainVolume @{
      TERRA_IMAGERY_ORIGIN = $imageryOrigin
    }
  $details['terra-terrain-globe'] = Update-ServiceConfig `
    'terra-terrain-globe' $images['terra-terrain-globe'] $terrainVolume @{
      TERRA_IMAGERY_ORIGIN = $imageryOrigin
    }

  $services = @()
  foreach ($name in @(
    'terra-terrain-1k', 'terra-terrain-globe', 'terra-imagery')) {
    $detail = $details[$name]
    $domain = $detail.data.BaseInfo.DefaultDomainName
    $serverConfig = $detail.data.ServerConfig
    if ($serverConfig.OperationMode -ne 'alwaysScale' -or
        [int]$serverConfig.MinNum -ne 0) {
      throw (
        "$name is not in scale-to-zero mode: " +
        "operationMode=$($serverConfig.OperationMode), " +
        "minNum=$($serverConfig.MinNum)")
    }
    Wait-HttpReady -ServiceName $name -Domain $domain | Out-Null
    $services += [ordered]@{
      name = $name
      domain = $domain
      image = $images[$name]
      status = $detail.data.BaseInfo.Status
      scaling = [ordered]@{
        operation_mode = $serverConfig.OperationMode
        min_instances = [int]$serverConfig.MinNum
        max_instances = [int]$serverConfig.MaxNum
      }
      volumes = $serverConfig.VolumesConf
    }
  }

  $deployment = [ordered]@{
    schema = 'terra.cloudbase.deployment.v1'
    environment = $EnvId
    deployed_at = (Get-Date).ToUniversalTime().ToString('o')
    services = $services
  }
  $evidencePath = Join-Path $EvidenceDir 'deployment.json'
  $deployment | ConvertTo-Json -Depth 8 |
    Set-Content -LiteralPath $evidencePath -Encoding UTF8
  Write-Host "CloudBase service deployment passed."
  Write-Host "Evidence: $evidencePath"
} finally {
  $resolved = [IO.Path]::GetFullPath($temporaryRoot)
  if ($resolved.StartsWith('C:\tmp\terra-cloudbase-deploy-')) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
