!echo "=== WORKBENCH CUSTOM INSTALLER.NSH LOADED ==="
!ifndef BUILD_UNINSTALLER
!macro customInit
  ; Close any running instance (new workbench.exe and legacy hermes.exe) before file extraction
  nsExec::ExecToLog 'taskkill /F /IM workbench.exe /T'
  Pop $0
  nsExec::ExecToLog 'taskkill /F /IM hermes.exe /T'
  Pop $0

  ; ── Remove legacy Hermes (appId com.hermes.studio) so this installs as an
  ;    in-place upgrade instead of a second parallel app. electron-builder stores
  ;    the uninstall entry under its deterministic appId GUID, not the literal appId.
  ;    d66c5416-3040-5a93-9d55-5f7c760b26e2 = UUIDv5(com.hermes.studio).
  StrCpy $R0 ""
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\d66c5416-3040-5a93-9d55-5f7c760b26e2" "UninstallString"
  ${If} $R0 == ""
    SetRegView 32
    ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\d66c5416-3040-5a93-9d55-5f7c760b26e2" "UninstallString"
    SetRegView 64
  ${EndIf}
  ${If} $R0 != ""
    ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\d66c5416-3040-5a93-9d55-5f7c760b26e2" "InstallLocation"
    ${If} $R1 == ""
      SetRegView 32
      ReadRegStr $R1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\d66c5416-3040-5a93-9d55-5f7c760b26e2" "InstallLocation"
      SetRegView 64
    ${EndIf}
    ; The legacy program is already stopped above. Delete its known application
    ; folder directly instead of executing a registry-supplied command line: that
    ; avoids trusting a mutable UninstallString and works even if its uninstaller
    ; has been damaged. Guard on hermes.exe so an unrelated directory is untouched.
    ${If} $R1 != ""
      ${If} ${FileExists} "$R1\hermes.exe"
        DetailPrint "Removing legacy hermes installation from $R1 ..."
        RMDir /r "$R1"
      ${EndIf}
    ${EndIf}
    ; stale entries / shortcuts / autostart the old uninstaller may leave behind
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\d66c5416-3040-5a93-9d55-5f7c760b26e2"
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\d66c5416-3040-5a93-9d55-5f7c760b26e2"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.hermes.studio"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.hermes.studio"
    Delete "$DESKTOP\hermes.lnk"
    Delete "$SMPROGRAMS\hermes.lnk"
    Delete "$SMPROGRAMS\hermes\hermes.lnk"
    RMDir "$SMPROGRAMS\hermes"
  ${EndIf}
!macroend

; Directory-page guard: a user-selected folder is a parent folder, never the
; application folder itself. Thus D:\Apps becomes D:\Apps\workbench, while an
; already-correct D:\Apps\workbench stays unchanged. The template's instFilesPre
; remains the final guard for silent installs as well.
Function .onVerifyInstDir
  StrCpy $0 $INSTDIR 10 -10
  ; lstrcmpi avoids creating a nested workbench folder when the user typed
  ; an existing final folder with a different letter case (for example WORKBENCH).
  System::Call 'kernel32::lstrcmpi(t "$0", t "\workbench") i.r1'
  StrCmp $1 0 workbench_dir_ok
  StrCpy $INSTDIR "$INSTDIR\workbench"
  workbench_dir_ok:
FunctionEnd

!macro customInstall
  ; Always replace shortcuts during upgrades and point them at a
  ; versioned ICO so Windows cannot reuse a stale shortcut icon cache.
  File /oname=workbench-v3523.ico "${BUILD_RESOURCES_DIR}\hermes.ico"

  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$appExe" "" "$INSTDIR\workbench-v3523.ico" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"

  !ifdef MENU_FILENAME
    CreateDirectory "$SMPROGRAMS\${MENU_FILENAME}"
  !endif
  Delete "$newStartMenuLink"
  CreateShortCut "$newStartMenuLink" "$appExe" "" "$INSTDIR\workbench-v3523.ico" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"

  ; Legacy hermes-era shortcuts (desktop + start menu) point to the old exe name — remove them
  Delete "$DESKTOP\hermes.lnk"
  Delete "$SMPROGRAMS\hermes.lnk"
  Delete "$SMPROGRAMS\hermes\hermes.lnk"
  RMDir "$SMPROGRAMS\hermes"

  ; Clean up old versioned icons to avoid stale cache
  Delete "$INSTDIR\hermes-avatar-H-bw-v225.ico"
  Delete "$INSTDIR\hermes-avatar-H-bw-v227.ico"
  Delete "$INSTDIR\hermes-avatar-H-bw-v300.ico"
  Delete "$INSTDIR\hermes-avatar-H-bw-v301.ico"
  Delete "$INSTDIR\hermes-avatar-H-bw-v330.ico"
  Delete "$INSTDIR\hermes-avatar-H-bw-v331.ico"
  Delete "$INSTDIR\hermes-avatar-H-bw-v332.ico"
  Delete "$INSTDIR\hermes-avatar-H-bw-v333.ico"
  Delete "$INSTDIR\hermes-avatar-H-bw-v340.ico"
  Delete "$INSTDIR\hermes-avatar-H-bw-v341.ico"
  Delete "$INSTDIR\hermes-avatar-H-bw-v342.ico"
  Delete "$INSTDIR\hermes-avatar-H-bw-v343.ico"
  Delete "$INSTDIR\workbench-v350.ico"
  Delete "$INSTDIR\workbench-v351.ico"
  Delete "$INSTDIR\workbench-v352.ico"
  Delete "$INSTDIR\workbench-v353.ico"
  Delete "$INSTDIR\workbench-v354.ico"
  Delete "$INSTDIR\workbench-v355.ico"
  Delete "$INSTDIR\workbench-v356.ico"
  Delete "$INSTDIR\workbench-v357.ico"
  Delete "$INSTDIR\workbench-v358.ico"
  Delete "$INSTDIR\workbench-v359.ico"
  Delete "$INSTDIR\workbench-v360.ico"
  Delete "$INSTDIR\workbench-v361.ico"
  Delete "$INSTDIR\workbench-v362.ico"
  Delete "$INSTDIR\workbench-v363.ico"
  Delete "$INSTDIR\workbench-v364.ico"

  ; Notify shell to refresh icons
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
!else
!macro customUnInstall
  ; electron-builder invokes the previous uninstaller during an in-place update.
  ; Preserve the current application's login item during upgrades: it carries
  ; both the Run command and Windows' enabled/disabled StartupApproved state.
  ; A real user-initiated uninstall still removes it to prevent a stale command.
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.workbench.app"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.workbench.app"
  ${endIf}
  ; Legacy hermes-era autostart entries
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.hermes.studio"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.hermes.studio"
!macroend
!endif
