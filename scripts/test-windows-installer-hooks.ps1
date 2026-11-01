param(
    [string]$MakeNsis = 'makensis.exe',
    [string]$Rustc = 'rustc.exe'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('liveagent-hook-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $scratch | Out-Null
$parentName = 'liveagent-hook-parent-' + [guid]::NewGuid().ToString('N')
$parentExe = Join-Path $scratch "$parentName.exe"
$childExe = Join-Path $scratch 'lock-child.exe'
& $Rustc (Join-Path $PSScriptRoot 'fixtures\installer-lock.rs') -o $parentExe
if ($LASTEXITCODE -ne 0) { throw 'Failed to build lock fixture' }
Copy-Item $parentExe $childExe
# Exercise the original macro bodies, redirecting only the data root into a disposable directory.
$hook = Get-Content (Join-Path $repo 'crates\agent-gui\src-tauri\windows\installer-hooks.nsh') -Raw
$hook.Replace('$PROFILE', '$INSTDIR') | Set-Content (Join-Path $scratch 'isolated-hooks.nsh')
$source = @'
Unicode true
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!define MAINBINARYNAME "@PARENT@"
!include "isolated-hooks.nsh"
Name "LiveAgent hook regression fixture"
OutFile "hook-fixture.exe"
RequestExecutionLevel user
SilentInstall silent
Var DeleteAppDataCheckboxState
Var UpdateMode
Section
  ${GetParameters} $R0
  ${GetOptions} $R0 "/ROOT=" $INSTDIR
  ${GetOptions} $R0 "/DELETE=" $DeleteAppDataCheckboxState
  ${GetOptions} $R0 "/UPDATE=" $UpdateMode
  !ifmacrodef NSIS_HOOK_PREUNINSTALL
    !insertmacro NSIS_HOOK_PREUNINSTALL
  !endif
  ; Tauri's CheckIfAppIsRunning kills the main process before POSTUNINSTALL.
  ; No /T here: the regression is an orphaned child after its parent is gone.
  nsExec::Exec 'taskkill /F /IM "${MAINBINARYNAME}.exe"'
  Pop $0
  !insertmacro NSIS_HOOK_POSTUNINSTALL
SectionEnd
'@
$source.Replace('@PARENT@', $parentName) | Set-Content (Join-Path $scratch 'fixture.nsi')
Push-Location $scratch
try {
    & $MakeNsis /V2 fixture.nsi
    if ($LASTEXITCODE -ne 0) { throw 'Failed to compile hook fixture' }
} finally { Pop-Location }

function Run-Hook([string]$Root, [int]$Delete, [int]$Update) {
    Start-Process (Join-Path $scratch 'hook-fixture.exe') -ArgumentList "/ROOT=`"$Root`"", "/DELETE=$Delete", "/UPDATE=$Update" -WindowStyle Hidden -PassThru -Wait
}
$results = @()
foreach ($case in @(@(0,0,$false), @(1,0,$true), @(1,1,$false), @(0,1,$false))) {
    $root = Join-Path $scratch "flags-$($case[0])-$($case[1])"
    $data = Join-Path $root '.liveagent'
    New-Item -ItemType Directory -Force (Join-Path $data 'nested') | Out-Null
    'sentinel' | Set-Content (Join-Path $data 'nested\config.sqlite')
    $process = Run-Hook $root $case[0] $case[1]
    $results += [pscustomobject]@{case="delete=$($case[0]),update=$($case[1])";pass=((!(Test-Path $data)) -eq $case[2] -and $process.ExitCode -eq 0)}
}

$treeRoot = Join-Path $scratch 'process-tree'
$treeData = Join-Path $treeRoot '.liveagent'
New-Item -ItemType Directory -Force $treeData | Out-Null
$ready = Join-Path $scratch 'child-ready'
$parent = Start-Process $parentExe -ArgumentList 'parent', "`"$childExe`"", "`"$(Join-Path $treeData 'config.sqlite')`"", "`"$ready`"" -WindowStyle Hidden -PassThru
$childPid = $null
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (!(Test-Path $ready) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
    if (!(Test-Path $ready)) { throw 'Lock fixture did not become ready' }
    $childPid = [int](Get-Content $ready -Raw)
    $process = Run-Hook $treeRoot 1 0
    $results += [pscustomobject]@{case='child lock is released before Tauri kills parent';pass=(!(Test-Path $treeData) -and $process.ExitCode -eq 0)}
} finally {
    if ($childPid) { Stop-Process -Id $childPid -ErrorAction SilentlyContinue }
    Stop-Process -Id $parent.Id -ErrorAction SilentlyContinue
}

$lockedRoot = Join-Path $scratch 'persistent-lock'
$lockedData = Join-Path $lockedRoot '.liveagent'
New-Item -ItemType Directory -Force $lockedData | Out-Null
$lock = [IO.File]::Open((Join-Path $lockedData 'locked.sqlite'), 'Create', 'ReadWrite', 'None')
try {
    $process = Run-Hook $lockedRoot 1 0
    $results += [pscustomobject]@{case='persistent lock reports failure';pass=((Test-Path $lockedData) -and $process.ExitCode -ne 0)}
} finally { $lock.Dispose() }
$results | ConvertTo-Json | Set-Content (Join-Path $scratch 'results.json')
$results | Format-Table
Write-Output "Fixture output: $scratch"
if (@($results | Where-Object { !$_.pass }).Count -ne 0) { throw 'Installer hook regression failed' }
