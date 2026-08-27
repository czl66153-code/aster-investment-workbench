param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePackageRoot,
    [string]$TargetAiaRoot = '',
    [string]$CurrentBatchId = ''
)

$ErrorActionPreference = 'Stop'
if (-not $TargetAiaRoot) { $TargetAiaRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'data\aia_authoritative' }
$package = [System.IO.Path]::GetFullPath($SourcePackageRoot)
$checksumPath = Join-Path $package 'SHA256SUMS.json'
$sourceAia = Get-ChildItem -LiteralPath $package -Directory -Recurse | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'ranking_candidates') -PathType Container } | Select-Object -First 1 -ExpandProperty FullName
$sourceSync = Get-ChildItem -LiteralPath $package -File -Recurse -Filter '*TOP10.ps1' | Select-Object -First 1 -ExpandProperty FullName
if (-not $sourceAia) { throw "Missing source AIA data root under: $package" }
if (-not $sourceSync) { throw "Missing source TOP10 sync tool under: $package" }
if (-not (Test-Path -LiteralPath $sourceSync -PathType Leaf)) { throw "Missing source sync tool: $sourceSync" }
if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) { throw "Missing source checksum manifest: $checksumPath" }

& $sourceSync -SourceAiaRoot $sourceAia -TargetAiaRoot $TargetAiaRoot | Out-Host

$allowedDirectories = @('ranking_candidates', 'top10_batches', 'top10_freezes', 'live_leaderboards', 'leadership_sources', 'heat')
$allowedFiles = @('ranking-config-versions.json', 'factor-config-versions.json', 'trade_calendar.json')
$aiaMarker = 'data\aia\'
$entries = [ordered]@{}
foreach ($entry in (Get-Content -LiteralPath $checksumPath -Raw -Encoding UTF8 | ConvertFrom-Json)) {
    $markerIndex = ([string]$entry.path).IndexOf($aiaMarker, [StringComparison]::OrdinalIgnoreCase)
    if ($markerIndex -lt 0) { continue }
    $relative = ([string]$entry.path).Substring($markerIndex + $aiaMarker.Length).Replace('\', '/')
    $top = $relative.Split('/')[0]
    if ($allowedDirectories -notcontains $top -and $allowedFiles -notcontains $relative) { continue }
    $targetPath = Join-Path $TargetAiaRoot $relative.Replace('/', '\')
    if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) { continue }
    $entries[$relative] = [ordered]@{ sha256 = ([string]$entry.sha256).ToLowerInvariant(); bytes = [long]$entry.bytes }
}

$batchRoot = Join-Path $TargetAiaRoot 'top10_batches'
$candidateRoot = Join-Path $TargetAiaRoot 'ranking_candidates'
$dated = Get-ChildItem -LiteralPath $batchRoot -File -Filter 'top10-*.json' | ForEach-Object {
    if ($_.Name -match '^top10-(\d{4}-\d{2}-\d{2})-') { [pscustomobject]@{ File = $_; TradeDate = $Matches[1] } }
} | Sort-Object TradeDate, @{ Expression = { $_.File.LastWriteTimeUtc }; Descending = $true } -Descending
$latestDate = $dated[0].TradeDate
$current = $null
if ($CurrentBatchId) {
    $explicitPath = Join-Path $batchRoot ($CurrentBatchId + '.json')
    if (-not (Test-Path -LiteralPath $explicitPath -PathType Leaf)) { throw "Requested AIA batch is missing: $CurrentBatchId" }
    $current = Get-Content -LiteralPath $explicitPath -Raw -Encoding UTF8 | ConvertFrom-Json
}
foreach ($candidateBatch in ($dated | Where-Object TradeDate -eq $latestDate)) {
    if ($null -ne $current) { break }
    try {
        $payload = Get-Content -LiteralPath $candidateBatch.File.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
        $candidatePath = Join-Path $candidateRoot ($payload.candidate_snapshot_id + '.json')
        if ($payload.status -eq 'pass' -and $payload.ranking_version -eq 'aia.top10.ranking.v6' -and $payload.items.Count -eq 10 -and (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
            $current = $payload
            break
        }
    } catch { continue }
}
if ($null -eq $current) { throw "No publishable authoritative AIA v6 batch found for $latestDate" }

$sourceMarkerPath = Join-Path $TargetAiaRoot 'AUTHORITATIVE_TOP10_SOURCE.json'
$sourceMarker = Get-Content -LiteralPath $sourceMarkerPath -Raw -Encoding UTF8 | ConvertFrom-Json
$manifest = [ordered]@{
    schema_version = 'aster.aia.authoritative.manifest.v1'
    source = $sourceMarker.source
    synchronized_at = $sourceMarker.synchronized_at
    current_batch_id = $current.batch_id
    current_candidate_snapshot_id = $current.candidate_snapshot_id
    ranking_version = $current.ranking_version
    files = $entries
}
$manifestPath = Join-Path $TargetAiaRoot 'AUTHORITATIVE_MANIFEST.json'
$temporary = $manifestPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporary -Encoding UTF8
Move-Item -LiteralPath $temporary -Destination $manifestPath -Force
$manifest | Select-Object schema_version, source, synchronized_at, current_batch_id, current_candidate_snapshot_id, ranking_version | ConvertTo-Json
