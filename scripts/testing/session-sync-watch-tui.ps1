param(
    [Parameter(Mandatory = $true)]
    [string]$BinaryPath,
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [int]$DurationSeconds = 45
)

$ErrorActionPreference = 'Stop'
$binary = [IO.Path]::GetFullPath($BinaryPath)
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output -Force | Out-Null
$started = [DateTimeOffset]::UtcNow
$deadline = $started.AddSeconds(30)
$target = $null
while ([DateTimeOffset]::UtcNow -lt $deadline) {
    $target = Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -eq $binary -and
        ([DateTimeOffset]$_.CreationDate) -ge $started -and
        $_.CommandLine -notmatch '\sbackend(?:\s|$)'
    } | Select-Object -First 1
    if ($null -ne $target) { break }
    Start-Sleep -Milliseconds 100
}
if ($null -eq $target) { throw 'No newly started standalone TUI process appeared within 30 seconds' }
$mapPath = Join-Path $output 'pids.json'
[ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString('O')
    processCreatedAt = ([DateTimeOffset]$target.CreationDate).ToString('O')
    roles = @{ tui = @([int]$target.ProcessId) }
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $mapPath -Encoding utf8
& (Join-Path $PSScriptRoot 'session-sync-sample.ps1') `
    -PidMapPath $mapPath `
    -OutputPath (Join-Path $output 'samples.jsonl') `
    -DurationSeconds $DurationSeconds `
    -IntervalMilliseconds 500
