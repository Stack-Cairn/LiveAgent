param(
    [Parameter(Mandatory = $true)]
    [string]$BinaryPath,
    [Parameter(Mandatory = $true)]
    [string]$DataRoot,
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [Parameter(Mandatory = $true)]
    [string]$SourceSha,
    [int]$Port = 47331,
    [int]$DurationSeconds = 300,
    [int]$RequestsPerBurst = 3,
    [int]$BurstIntervalSeconds = 60
)

$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $OutputDirectory) { throw "Output directory already exists: $OutputDirectory" }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "Port $Port is in use" }
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null

$binary = (Resolve-Path -LiteralPath $BinaryPath).Path
$data = (Resolve-Path -LiteralPath $DataRoot).Path
$binaryHash = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
$datasetManifestPath = Join-Path $data 'session-sync-dataset.json'
if (-not (Test-Path -LiteralPath $datasetManifestPath)) { throw 'Dataset manifest is missing' }
$datasetManifest = Get-Content -LiteralPath $datasetManifestPath -Raw | ConvertFrom-Json
$stdout = Join-Path $OutputDirectory 'backend.stdout.log'
$stderr = Join-Path $OutputDirectory 'backend.stderr.log'
$backend = Start-Process -FilePath $binary -ArgumentList @(
    'backend', '-listen', "127.0.0.1:$Port", '-data-dir', $data,
    '-memory-organizer-interval', '24h'
) -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden
try {
    $deadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 250
        try {
            $health = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/v1/health" -TimeoutSec 2 -ErrorAction Stop
        } catch { $health = $null }
    } while (($null -eq $health -or $health.StatusCode -ne 200) -and (Get-Date) -lt $deadline)
    if ($null -eq $health -or $health.StatusCode -ne 200) { throw 'Backend did not become ready' }

    $metadata = [ordered]@{
        schemaVersion = 1
        sourceSha = $SourceSha
        binaryPath = $binary
        binarySha256 = $binaryHash
        dataRoot = $data
        datasetDigest = $datasetManifest.digest
        datasetBytes = $datasetManifest.transcriptBytes
        sessionCount = $datasetManifest.sessionCount
        startedAt = [DateTimeOffset]::UtcNow.ToString('O')
        durationSeconds = $DurationSeconds
        requestsPerBurst = $RequestsPerBurst
        burstIntervalSeconds = $BurstIntervalSeconds
        port = $Port
        pid = $backend.Id
    }
    $metadata | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'run.json')
    [ordered]@{ roles = [ordered]@{ kbrain = @([int]$backend.Id) } } |
        ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'pids.json')
    $sampler = Start-Process -FilePath 'pwsh' -ArgumentList @(
        '-NoProfile', '-NonInteractive', '-File',
        (Join-Path $PSScriptRoot 'session-sync-sample.ps1'),
        '-PidMapPath', (Join-Path $OutputDirectory 'pids.json'),
        '-OutputPath', (Join-Path $OutputDirectory 'samples.jsonl'),
        '-DurationSeconds', $DurationSeconds,
        '-IntervalMilliseconds', 1000
    ) -PassThru -RedirectStandardOutput (Join-Path $OutputDirectory 'sampler.stdout.log') -RedirectStandardError (Join-Path $OutputDirectory 'sampler.stderr.log') -WindowStyle Hidden
    $burstCount = [Math]::Max(1, [Math]::Floor(($DurationSeconds - 1) / $BurstIntervalSeconds) + 1)
    $requester = Start-Process -FilePath 'node' -ArgumentList @(
        (Join-Path $PSScriptRoot 'session-sync-benchmark.mjs'),
        '--url', "http://127.0.0.1:$Port/v1/sessions?page=1&page_size=200",
        '--bursts', $burstCount,
        '--requests', $RequestsPerBurst,
        '--interval', ($BurstIntervalSeconds * 1000),
        '--output', (Join-Path $OutputDirectory 'requests.jsonl')
    ) -PassThru -RedirectStandardOutput (Join-Path $OutputDirectory 'requester.stdout.log') -RedirectStandardError (Join-Path $OutputDirectory 'requester.stderr.log') -WindowStyle Hidden
    Wait-Process -Id $sampler.Id, $requester.Id
    if ($sampler.ExitCode -ne 0) { throw "Sampler failed with exit code $($sampler.ExitCode)" }
    if ($requester.ExitCode -ne 0) { throw "Requester failed with exit code $($requester.ExitCode)" }
    & node (Join-Path $PSScriptRoot 'session-sync-summarize.mjs') `
        --samples (Join-Path $OutputDirectory 'samples.jsonl') `
        --requests (Join-Path $OutputDirectory 'requests.jsonl') `
        --output (Join-Path $OutputDirectory 'summary.json') | Out-Null
} finally {
    if (-not $backend.HasExited) { Stop-Process -Id $backend.Id -Force }
}
