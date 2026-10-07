; NSIS installer hooks for the LiveAgent Windows bundle.
;
; Tauri's stock uninstaller only removes $APPDATA\<identifier> and
; $LOCALAPPDATA\<identifier> when "Delete the application data" is ticked.
; LiveAgent keeps its persistent data (config, chat history, memory, skills,
; uploads, checkpoints, ...) under %USERPROFILE%\.liveagent, so clean it here.

!macro NSIS_HOOK_POSTUNINSTALL
  ; Same condition as Tauri's own app-data cleanup: checkbox ticked, and not an
  ; in-place update (updates also run the uninstaller and must keep user data).
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Child processes (gateway helpers, MCP servers, browser) may still hold
    ; sqlite / -wal files open and make RMDir fail silently; end the whole tree.
    nsExec::Exec 'taskkill /F /T /IM "${MAINBINARYNAME}.exe"'
    Pop $0

    ; Retry a few times in case handles are released slightly late.
    StrCpy $1 0
    liveagent_rmdir_retry:
      RMDir /r "$PROFILE\.liveagent"
      ${IfNot} ${FileExists} "$PROFILE\.liveagent"
        Goto liveagent_rmdir_done
      ${EndIf}
      IntOp $1 $1 + 1
      ${If} $1 < 5
        Sleep 500
        Goto liveagent_rmdir_retry
      ${EndIf}
    liveagent_rmdir_done:
  ${EndIf}
!macroend
