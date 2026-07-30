@echo off
setlocal EnableExtensions DisableDelayedExpansion

cd /d "%~dp0"
if errorlevel 1 (
  echo [LiveAgent] Failed to enter the repository directory.
  goto :fail
)

where pnpm.cmd >nul 2>nul
if errorlevel 1 (
  echo [LiveAgent] pnpm was not found in PATH.
  echo Install the project toolchain first, then run this file again.
  goto :fail
)

call :resolve_libclang
if errorlevel 1 goto :libclang_missing
if not defined LIBCLANG_PATH goto :libclang_missing
if not exist "%LIBCLANG_PATH%\libclang.dll" goto :libclang_missing
goto :libclang_ready

:libclang_missing
echo [LiveAgent] libclang.dll was not found.
echo Set LIBCLANG_PATH to the directory containing libclang.dll, then run this file again.
goto :fail

:libclang_ready

call :check_dev_port
if errorlevel 1 goto :fail

if not exist "crates\agent-gui\node_modules\.bin\tauri.cmd" (
  echo [LiveAgent] Installing GUI dependencies from the lockfile...
  call pnpm.cmd --dir crates/agent-gui install --frozen-lockfile
  if errorlevel 1 goto :command_failed
)

echo [LiveAgent] Repository: %CD%
echo [LiveAgent] LIBCLANG_PATH: %LIBCLANG_PATH%
echo [LiveAgent] Starting the Tauri debug client...
echo.

call pnpm.cmd --dir crates/agent-gui tauri dev
if errorlevel 1 goto :command_failed
exit /b 0

:resolve_libclang
if defined LIBCLANG_PATH if exist "%LIBCLANG_PATH%\libclang.dll" exit /b 0
set "LIBCLANG_PATH="

if exist "%APPDATA%\Python\Python313\site-packages\clang\native\libclang.dll" (
  set "LIBCLANG_PATH=%APPDATA%\Python\Python313\site-packages\clang\native"
  exit /b 0
)

if exist "%ProgramFiles%\LLVM\bin\libclang.dll" (
  set "LIBCLANG_PATH=%ProgramFiles%\LLVM\bin"
  exit /b 0
)

if exist "%ProgramFiles(x86)%\LLVM\bin\libclang.dll" (
  set "LIBCLANG_PATH=%ProgramFiles(x86)%\LLVM\bin"
  exit /b 0
)

for /d %%D in ("%APPDATA%\Python\Python*\site-packages\clang\native") do (
  if exist "%%~fD\libclang.dll" set "LIBCLANG_PATH=%%~fD"
)
if defined LIBCLANG_PATH exit /b 0

for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python*\Lib\site-packages\clang\native") do (
  if exist "%%~fD\libclang.dll" set "LIBCLANG_PATH=%%~fD"
)
if defined LIBCLANG_PATH exit /b 0

where python.exe >nul 2>nul
if not errorlevel 1 (
  for /f "usebackq delims=" %%D in (`python.exe -c "import pathlib, clang; print(pathlib.Path(clang.__file__).resolve().parent / 'native')" 2^>nul`) do (
    if exist "%%~fD\libclang.dll" set "LIBCLANG_PATH=%%~fD"
  )
)
if defined LIBCLANG_PATH exit /b 0

exit /b 1

:check_dev_port
set "PORT_PID="
for /f "tokens=5" %%P in ('%SystemRoot%\System32\netstat.exe -ano -p tcp ^| %SystemRoot%\System32\findstr.exe /r /c:":1420 .*LISTENING"') do (
  if not defined PORT_PID set "PORT_PID=%%P"
)
if not defined PORT_PID exit /b 0

echo [LiveAgent] Port 1420 is already in use by PID %PORT_PID%.
echo Close the existing Tauri debug window and console, then run this file again.
exit /b 1

:command_failed
echo.
echo [LiveAgent] The command failed with exit code %ERRORLEVEL%.

:fail
echo.
pause
exit /b 1
