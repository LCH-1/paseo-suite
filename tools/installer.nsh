!macro customCheckAppRunning
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 == 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "실행 중인 Paseo 작업을 마친 뒤 앱과 로컬 호스트를 종료하고 설치를 다시 실행하세요." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend
