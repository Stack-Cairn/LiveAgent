param(
    [Parameter(Mandatory = $true)]
    [int]$RootPid,
    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$all = @(Get-CimInstance Win32_Process)
$byParent = @{}
foreach ($process in $all) {
    $parent = [int]$process.ParentProcessId
    if (-not $byParent.ContainsKey($parent)) { $byParent[$parent] = @() }
    $byParent[$parent] += $process
}
$ids = [System.Collections.Generic.HashSet[int]]::new()
$queue = [System.Collections.Generic.Queue[int]]::new()
$queue.Enqueue($RootPid)
while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    if (-not $ids.Add($current)) { continue }
    foreach ($child in @($byParent[$current])) {
        if ($null -ne $child -and [int]$child.ProcessId -gt 0) {
            $queue.Enqueue([int]$child.ProcessId)
        }
    }
}

$roles = [ordered]@{
    liveagent = @()
    kbrain = @()
    gateway = @()
    webview = @()
    support = @()
}
foreach ($process in $all) {
    $processId = [int]$process.ProcessId
    if (-not $ids.Contains($processId)) { continue }
    $name = ([string]$process.Name).ToLowerInvariant()
    if ($name -eq 'liveagent.exe') { $role = 'liveagent' }
    elseif ($name -eq 'k-brain.exe' -or $name -eq 'kn.exe') { $role = 'kbrain' }
    elseif ($name.StartsWith('liveagent-gateway')) { $role = 'gateway' }
    elseif ($name -eq 'msedgewebview2.exe') { $role = 'webview' }
    else { $role = 'support' }
    $roles[$role] += $processId
}
[ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString('O')
    rootPid = $RootPid
    roles = $roles
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutputPath
Get-Content -LiteralPath $OutputPath
