param(
    [Parameter(Mandatory = $true)]
    [string]$PidMapPath,
    [Parameter(Mandatory = $true)]
    [string]$OutputPath,
    [int]$DurationSeconds = 300,
    [int]$IntervalMilliseconds = 1000
)

$ErrorActionPreference = 'Stop'
if ($DurationSeconds -lt 1) { throw 'DurationSeconds must be positive' }
if ($IntervalMilliseconds -lt 100) { throw 'IntervalMilliseconds must be at least 100' }

$pidMap = Get-Content -LiteralPath $PidMapPath -Raw | ConvertFrom-Json
$pidToRole = @{}
foreach ($property in $pidMap.roles.PSObject.Properties) {
    foreach ($processId in $property.Value) {
        $pidToRole[[int]$processId] = [string]$property.Name
    }
}

$outputDirectory = Split-Path -Parent $OutputPath
if ($outputDirectory) { New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null }
$started = [DateTimeOffset]::UtcNow
$deadline = $started.AddSeconds($DurationSeconds)
while ([DateTimeOffset]::UtcNow -le $deadline) {
    $processes = @()
    $cimProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    if ($pidMap.dynamicDescendants -eq $true) {
        # Browser renderers may be replaced after BFCache or reconnect. Rebuild
        # the task-owned process tree so samples cannot silently omit new PIDs.
        $pidToRole = @{}
        $children = @{}
        $byId = @{}
        foreach ($candidate in $cimProcesses) {
            $candidateId = [int]$candidate.ProcessId
            $parentId = [int]$candidate.ParentProcessId
            $byId[$candidateId] = $candidate
            if (-not $children.ContainsKey($parentId)) { $children[$parentId] = @() }
            $children[$parentId] += $candidateId
        }
        foreach ($root in @(
            @{ pid = [int]$pidMap.rootPid; web = $false },
            @{ pid = [int]$pidMap.webRootPid; web = $true }
        )) {
            if ($root.pid -le 0) { continue }
            $queue = [System.Collections.Generic.Queue[int]]::new()
            $seen = [System.Collections.Generic.HashSet[int]]::new()
            $queue.Enqueue($root.pid)
            $rootCreatedAt = if ($byId.ContainsKey($root.pid)) { $byId[$root.pid].CreationDate } else { $null }
            while ($queue.Count -gt 0) {
                $candidateId = $queue.Dequeue()
                if (-not $seen.Add($candidateId) -or -not $byId.ContainsKey($candidateId)) { continue }
                $candidate = $byId[$candidateId]
                # Windows can reuse a PID while older orphaned children still
                # name it as their parent. Those are not this runtime's tree.
                if ($null -ne $rootCreatedAt -and $candidate.CreationDate -lt $rootCreatedAt) { continue }
                if ($root.web) { $role = 'webui' }
                elseif ($candidate.Name -eq 'liveagent.exe') { $role = 'liveagent' }
                elseif ($candidate.Name -in @('kn.exe', 'k-brain.exe')) { $role = 'kbrain' }
                elseif ($candidate.Name -like 'liveagent-gateway*') { $role = 'gateway' }
                elseif ($candidate.Name -eq 'msedgewebview2.exe') {
                    $role = if ($candidate.CommandLine -match '--type=renderer') { 'webviewRenderer' } else { 'webviewOther' }
                }
                else { $role = 'support' }
                $pidToRole[$candidateId] = $role
                foreach ($childId in @($children[$candidateId])) {
                    if ($null -ne $childId) { $queue.Enqueue([int]$childId) }
                }
            }
        }
    }
    foreach ($cim in $cimProcesses) {
        $processId = [int]$cim.ProcessId
        if (-not $pidToRole.ContainsKey($processId)) { continue }
        $processes += [ordered]@{
            pid = [int]$processId
            role = [string]$pidToRole[$processId]
            name = [string]$cim.Name
            executablePath = [string]$cim.ExecutablePath
            commandLine = [string]$cim.CommandLine
            cpu100ns = [long]$cim.KernelModeTime + [long]$cim.UserModeTime
            user100ns = [long]$cim.UserModeTime
            privileged100ns = [long]$cim.KernelModeTime
            readBytes = [long]$cim.ReadTransferCount
            writeBytes = [long]$cim.WriteTransferCount
            otherBytes = [long]$cim.OtherTransferCount
            workingSetBytes = [long]$cim.WorkingSetSize
            privateBytes = [long]$cim.PrivatePageCount
            virtualBytes = [long]$cim.VirtualSize
            handles = [long]$cim.HandleCount
            threads = [long]$cim.ThreadCount
        }
    }
    $sample = [ordered]@{
        at = [DateTimeOffset]::UtcNow.ToString('O')
        atMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        processes = $processes
    }
    Add-Content -LiteralPath $OutputPath -Value ($sample | ConvertTo-Json -Compress -Depth 5) -Encoding utf8
    Start-Sleep -Milliseconds $IntervalMilliseconds
}
