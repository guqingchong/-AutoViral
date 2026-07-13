; AutoViral MCN — NSIS Installer Customization
; Included by electron-builder via `include: build-resources/installer.nsh`

!macro customInstall
  ; Create a start menu shortcut with a friendly name
  CreateShortCut "$SMPROGRAMS\AutoViral MCN.lnk" "$INSTDIR\AutoViral.exe" "" "$INSTDIR\AutoViral.exe" 0

  ; Optionally write install path to registry for update detection
  WriteRegStr HKLM "Software\AutoViral" "InstallDir" "$INSTDIR"
!macroend

!macro customUnInstall
  ; Clean up start menu shortcut
  Delete "$SMPROGRAMS\AutoViral MCN.lnk"

  ; Clean up registry
  DeleteRegKey HKLM "Software\AutoViral"
!macroend
