!macro customInit
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Wolffish"
!macroend

; The `wolffish` CLI. The app writes the shim itself on first launch (it must
; be re-pointed after every update, so the app is the only thing that can keep
; it correct) — the installer's job is only to make its folder findable.
;
; Per-user HKCU, not the machine PATH: no elevation, no effect on other
; accounts, and it matches where the shim is written. WM_SETTINGCHANGE is what
; makes newly-opened terminals see it without a reboot.
; Delegated to PowerShell rather than hand-rolled in NSIS: the idempotency
; check is a string search over the user's whole PATH, and getting that wrong
; either duplicates the entry on every reinstall or corrupts the variable.
; .NET's SetEnvironmentVariable also broadcasts WM_SETTINGCHANGE itself, so a
; newly-opened terminal picks it up without a reboot.
!macro customInstall
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = Join-Path $$env:USERPROFILE \".wolffish\bin\"; $$p = [Environment]::GetEnvironmentVariable(\"Path\",\"User\"); if (-not ($$p -split \";\" | Where-Object { $$_.TrimEnd(\"\\\") -ieq $$d.TrimEnd(\"\\\") })) { $$n = if ([string]::IsNullOrEmpty($$p)) { $$d } else { \"$$p;$$d\" }; [Environment]::SetEnvironmentVariable(\"Path\",$$n,\"User\") }"'
!macroend

!macro customUnInstall
  ; Leave PATH alone on uninstall: stripping one entry out of a user's PATH
  ; string is easy to get wrong, and a stale entry pointing at a folder that
  ; no longer exists is harmless.
!macroend
