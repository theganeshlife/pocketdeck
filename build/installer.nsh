; PocketDeck installer additions.
; If this same version is already installed for this Windows account, ask before reinstalling.
; Reinstalling (or updating) always replaces the existing copy in the same folder; it never adds a second one.
!macro customInit
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion"
  StrCmp $0 "${VERSION}" 0 +3
    MessageBox MB_YESNO|MB_ICONQUESTION "An up-to-date version of PocketDeck (${VERSION}) is already installed on this PC.$\r$\n$\r$\nDo you want to reinstall it?" /SD IDYES IDYES +2
    Quit
!macroend
