Unicode true
!include "MUI2.nsh"

!ifndef ForgeRuntime
  !error "ForgeRuntime define is required"
!endif
!ifndef ForgeOutput
  !error "ForgeOutput define is required"
!endif

!define ProductName "Forge Local Agent IDE"
!define ProductVersion "0.1.0"
!define ProductPublisher "Forge Contributors"
!define UninstallKey "Software\Microsoft\Windows\CurrentVersion\Uninstall\ForgeLocalAgentIDE"

Name "${ProductName}"
OutFile "${ForgeOutput}"
InstallDir "$LOCALAPPDATA\Programs\Forge Local Agent IDE"
InstallDirRegKey HKCU "Software\ForgeLocalAgentIDE" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "0.1.0.0"
VIAddVersionKey "ProductName" "${ProductName}"
VIAddVersionKey "ProductVersion" "${ProductVersion}"
VIAddVersionKey "CompanyName" "${ProductPublisher}"
VIAddVersionKey "FileDescription" "Forge Code-OSS Windows Installer"
VIAddVersionKey "FileVersion" "${ProductVersion}"
VIAddVersionKey "LegalCopyright" "Code-OSS and Forge licenses are included in the installation."

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Forge.Installed.cmd"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Forge Local Agent IDE"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Forge Code-OSS Workbench" MainSection
  SectionIn RO
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${ForgeRuntime}\*.*"

  WriteUninstaller "$INSTDIR\Uninstall Forge.exe"
  WriteRegStr HKCU "Software\ForgeLocalAgentIDE" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UninstallKey}" "DisplayName" "${ProductName}"
  WriteRegStr HKCU "${UninstallKey}" "DisplayVersion" "${ProductVersion}"
  WriteRegStr HKCU "${UninstallKey}" "Publisher" "${ProductPublisher}"
  WriteRegStr HKCU "${UninstallKey}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UninstallKey}" "DisplayIcon" "$INSTDIR\VSCodium.exe"
  WriteRegStr HKCU "${UninstallKey}" "UninstallString" "$\"$INSTDIR\Uninstall Forge.exe$\""
  WriteRegDWORD HKCU "${UninstallKey}" "NoModify" 1
  WriteRegDWORD HKCU "${UninstallKey}" "NoRepair" 1

  CreateDirectory "$SMPROGRAMS\Forge Local Agent IDE"
  CreateShortcut "$SMPROGRAMS\Forge Local Agent IDE\Forge Local Agent IDE.lnk" "$INSTDIR\Forge.Installed.cmd" "" "$INSTDIR\VSCodium.exe" 0
  CreateShortcut "$SMPROGRAMS\Forge Local Agent IDE\Uninstall Forge.lnk" "$INSTDIR\Uninstall Forge.exe"
  CreateShortcut "$DESKTOP\Forge Local Agent IDE.lnk" "$INSTDIR\Forge.Installed.cmd" "" "$INSTDIR\VSCodium.exe" 0
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\Forge Local Agent IDE.lnk"
  Delete "$SMPROGRAMS\Forge Local Agent IDE\Forge Local Agent IDE.lnk"
  Delete "$SMPROGRAMS\Forge Local Agent IDE\Uninstall Forge.lnk"
  RMDir "$SMPROGRAMS\Forge Local Agent IDE"
  DeleteRegKey HKCU "${UninstallKey}"
  DeleteRegKey HKCU "Software\ForgeLocalAgentIDE"
  RMDir /r "$INSTDIR"
SectionEnd
