; NSIS installer hooks for the LiveAgent Windows bundle.
;
; Tauri's stock uninstaller only removes $APPDATA\<identifier> and
; $LOCALAPPDATA\<identifier> when "Delete the application data" is ticked.
; LiveAgent keeps its persistent data (config, chat history, memory, skills,
; uploads, checkpoints, ...) under %USERPROFILE%\.liveagent, so clean it here.

!macro NSIS_HOOK_PREUNINSTALL
  ; Same condition as Tauri's own app-data cleanup: checkbox ticked, and not an
  ; in-place update (updates also run the uninstaller and must keep user data).
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Tauri kills the main process before POSTUNINSTALL. Kill the tree while
    ; its root still exists, otherwise children holding sqlite files survive.
    Push $0
    nsExec::Exec 'taskkill /F /T /IM "${MAINBINARYNAME}.exe"'
    Pop $0
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    Push $1
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
      DetailPrint 'Could not remove "$PROFILE\.liveagent": files may still be in use.'
      MessageBox MB_OK|MB_ICONEXCLAMATION 'LiveAgent was uninstalled, but some application data could not be deleted from "$PROFILE\.liveagent". Close programs using these files and remove the remaining directory manually.' /SD IDOK
      SetErrorLevel 1
    liveagent_rmdir_done:
    Pop $1
  ${EndIf}
!macroend
