!macro customInstall
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  StrCmp $0 1 done

  IfFileExists "$INSTDIR\resources\vc_redist.x64.exe" 0 done
  DetailPrint "VC++ 2015-2022 x64 runtime not found. Installing prerequisite..."
  ExecWait '"$INSTDIR\resources\vc_redist.x64.exe" /install /quiet /norestart' $1

done:
!macroend
