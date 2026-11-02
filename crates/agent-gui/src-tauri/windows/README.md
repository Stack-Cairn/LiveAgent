# Windows uninstall hooks

LiveAgent stores user data in `%USERPROFILE%\.liveagent`, outside Tauri's default
application-data directories. The hooks remove this directory only when the
uninstaller's data-deletion checkbox is selected and it is not an update.

`PREUNINSTALL` stops the process tree before Tauri stops the main process;
otherwise child processes can survive and retain SQLite file handles.
`POSTUNINSTALL` retries deletion five times. If files remain, interactive users
see a warning and the process returns exit code 1 (also in silent mode).

Run the isolated regression fixture on Windows with Rust and NSIS available:

```powershell
./scripts/test-windows-installer-hooks.ps1 -MakeNsis 'C:\path\to\makensis.exe'
```

The fixture redirects the data path into a unique temporary directory, uses
uniquely named test processes, and does not install/uninstall LiveAgent or touch
its real user data. It covers checkbox/update combinations, a child holding an
exclusive file lock, and an unrelated persistent lock. Evidence is retained in
the temporary directory printed by the script.
