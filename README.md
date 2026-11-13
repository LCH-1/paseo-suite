# Paseo Suite

현재 사용 중인 Paseo 0.12 기능을 유지하는 배포·플러그인 저장소입니다. 본체 소스는 공개 [LCH-1/paseo](https://github.com/LCH-1/paseo), 플러그인 소스와 통합 설치 파일은 이 공개 저장소에서 관리합니다. 릴리스의 `suite-lock.json`이 정확한 본체 커밋과 플러그인 파일 해시를 고정합니다. 데스크톱 배포 버전과 내부 프로토콜 버전은 별개입니다.

| 관리 대상     | 책임                                                                                                                          | 작업 경로                             |
| :------------ | :---------------------------------------------------------------------------------------------------------------------------- | :------------------------------------ |
| Paseo Core    | 기본 렌더링·선택·복사, 기록·사이드바·창과 탭, 단축키, 세션 기본 설정, 터미널 실행, Windows 표시, 안전한 오류 재시도, 확장 API | 별도 `paseo` 포크 checkout            |
| Paseo UI      | 전역 탭과 탭 복원, 제목 표시, 호스트 순서, 기록 불러오기, 터미널 대화 화면                                                    | `plugins/ui`                          |
| Aster         | Claude·Codex 다계정 자동 분배·구독·한도 확인·대화별 라우팅                                                                    | `plugins/aster`                       |
| Settings Sync | 암호화된 환경 백업·복원, 동일 계정의 호스트 간 인증 전달                                                                      | `plugins/settings-sync`               |
| 통합·배포     | 버전 고정, 설치, 상태 이전, 복구, 릴리스 검증                                                                                 | `tools`, `tests`, `.github/workflows` |

Paseo UI의 내부 ID는 `terminal-tabs`를 유지합니다. 기존 화면 주소, 사이드바 표시 설정, `terminal-tabs:<host>`와 전역 탭·호스트 순서 저장 키를 보존하기 위한 결정입니다. 본체의 일반 `addLegacyId` 확장이 예전 제목·호스트 순서 설정 화면 주소를 이어 줍니다. UI의 각 기능은 모듈별로 끌 수 있습니다. 기존에 꺼져 있던 기능은 설치 때 활성화하지 않습니다.

Aster는 계정 선택·라우팅을 담당합니다. 사용량은 화면과 같은 본체 API로 읽고 구독 확인은 본체가 반환한 계정 메타데이터로 판단합니다. 로그인 저장소 읽기와 공식 profile·usage 조회·캐시는 본체의 단일 Claude 엔진이 맡습니다. 실제 인증 전달·쓰기·잠금·암호화·동일 계정 확인은 Settings Sync가 담당합니다. 구버전 호스트에서만 이전 읽기 경로를 사용하므로 모든 기기를 한꺼번에 갱신할 필요는 없습니다.

Windows 자격증명 지원은 본체의 기존 `claude-usage-source`로 통합합니다. 별도 Windows 조회 엔진을 실행하지 않으며 기존 `claude-windows` 소스 ID와 선택 값은 호환 소스로 유지합니다. 두 소스는 프로필·사용량 캐시를 공유합니다. 현재 호스트의 데몬이 이전 빌드이면 설치기는 기존 외부 소스를 유지하고 내장 전환을 보류합니다. 실행 중인 코딩 세션을 설치기가 종료하지 않습니다.

## 다른 PC에 설치

1. 이 저장소의 Releases에서 Windows x64용 Paseo Suite 설치 파일을 받습니다. 현재 검증·배포 대상은 Windows x64입니다.
2. 설치 후 Paseo를 실행하면 해시를 확인한 세 플러그인을 오프라인으로 설치합니다. Node·pnpm·개발 폴더는 필요 없습니다.
3. 개인 환경을 가져오려면 Settings Sync에서 기존 GitHub 계정과 백업 암호를 연결합니다. 로그인·암호·개인 경로는 설치 파일에 포함되지 않습니다.

설치·업데이트는 공개 Release에서 인증 없이 받습니다. GitHub 계정·GitHub CLI·호스트 연결은 필요 없습니다. Settings Sync를 사용할 때만 각 사용자가 본인 GitHub 계정과 백업 암호를 연결합니다. 개인 백업은 그 계정의 암호화된 Secret Gist에 저장하며 소스나 릴리즈에 포함하지 않습니다.

### PowerShell에서 설치·업데이트

Windows PowerShell 5.1 이상과 Windows x64를 지원합니다. 최신 안정 릴리스의 설치 도우미를 받아 실행합니다. 설치 파일과 후속 도우미는 같은 릴리스의 SHA256SUMS로 확인하며, 다운로드가 끊기거나 해시가 다르면 설치하지 않습니다.

```powershell
$paseoSetup = Join-Path $env:TEMP 'PaseoSuite-install.ps1'
Invoke-WebRequest -UseBasicParsing 'https://github.com/LCH-1/paseo-suite/releases/latest/download/install.ps1' -OutFile $paseoSetup
powershell -NoProfile -ExecutionPolicy Bypass -File $paseoSetup -Action Install
```

그다음 수동 업데이트는 다음 명령으로 실행합니다. 설치된 버전보다 오래된 릴리스로 내려가지 않으며, 앱·백그라운드 로컬 호스트가 실행 중이면 다운로드만 하고 설치를 보류합니다. 설치는 계정·대화·프로젝트 파일을 삭제하지 않습니다. 이 도우미는 사용자별 설치만 다룹니다. 모든 사용자용(HKLM)으로 설치한 PC(예: 회사 PC)에서는 사용자별 사본이 옆에 생기고 이후 업데이트·제거 때 같은 폴더의 다른 설치까지 지워질 수 있어 Install·Update·EnableAutoUpdate·Rollback 모두 아무것도 받기 전에 거부합니다. 그런 PC는 Release의 설치 파일을 직접 실행하거나 그 PC에서 쓰던 교체 절차로 바꿉니다. 등록이 없어도 `%LOCALAPPDATA%\Programs\Paseo`의 하위 폴더에 `Paseo.exe`가 있으면(버전별 설치 폴더 모음) 같은 이유로 거부하니, 그 폴더들을 만든 교체 절차를 계속 쓰거나 폴더들을 다른 곳으로 옮긴 뒤 실행합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PaseoSuite\updater\install.ps1" -Action Update
```

자동 업데이트는 **PC별로 직접 켜야 합니다.** 기존 회사·Gaming·Linux 호스트에는 자동으로 활성화하지 않습니다. 첫 설치 명령에 `-EnableAutoUpdate`를 추가하거나 아래 명령으로 켭니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PaseoSuite\updater\install.ps1" -Action EnableAutoUpdate
```

현재 Windows 사용자로 로그인할 때와 30분마다 GitHub를 확인합니다. 최신 설치본을 한 번 내려받아 대기하고, Paseo 앱과 로컬 호스트가 모두 종료된 다음 검사에서 자동 설치합니다. 실행 중인 에이전트나 창을 종료하지 않으므로, 앱을 닫아도 호스트를 계속 실행하는 설정에서는 호스트까지 정상 종료해야 적용됩니다. 검사 중에만 PowerShell이 실행되며 상주 업데이트 프로세스는 없습니다. 인터넷 연결이나 다운로드에 실패하면 다음 검사에서 다시 시도합니다. 마지막 결과는 `%LOCALAPPDATA%\PaseoSuite\updater\status.json`에 남습니다.

```powershell
# 자동 업데이트 끄기
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PaseoSuite\updater\install.ps1" -Action DisableAutoUpdate
# 최신 버전만 확인하기
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PaseoSuite\updater\install.ps1" -Action Check
```

설치를 확인한 뒤에는 받은 설치 파일을 지우고, 설치를 보류한 동안에는 최신 설치 파일 하나만 남깁니다. 앱은 기본 `~/.paseo`로 시작할 때 설치 기록이 가리키는 체크포인트와 설정 내용이 서로 다른 최근 체크포인트 3개만 남기고(실패한 이전 시도는 체크포인트를 남기지 않고, 같은 설정 사본은 개수에 세지 않고 지웁니다), 현재 플러그인·설정과 남은 체크포인트가 가리키는 플러그인·하루가 지나지 않은 플러그인을 뺀 옛 플러그인 폴더를 정리합니다. `config.json`이 없으면 플러그인 폴더는 지우지 않습니다. 지운 폴더 이름, 지우지 못한 폴더와 오류 코드, 중단 이유는 `~/.paseo/suite/residue-cleanup.json`에 최근 20회까지 남습니다.

### 이전 버전으로 되돌리기

되돌릴 버전은 이 저장소의 공개 Release 태그에서 인증 없이 받습니다. PC에 설치 파일을 따로 보관하지 않습니다. 자동 업데이트가 켜져 있으면 최신 버전이 다시 설치되므로 먼저 끈 뒤 실행합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PaseoSuite\updater\install.ps1" -Action DisableAutoUpdate
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PaseoSuite\updater\install.ps1" -Action Rollback -Version 1.0.9
```

앱 안 업데이트나 설치 파일로만 올린 PC는 이 도우미가 없거나 `Rollback`을 모르는 옛 도우미일 수 있습니다. 그때는 위 설치 명령의 첫 두 줄로 최신 도우미를 `%TEMP%`에 받아 `-File $paseoSetup -Action Rollback -Version 1.0.9`로 실행합니다.

설치 파일은 같은 태그의 SHA256SUMS로 확인합니다. 앱이나 로컬 호스트가 실행 중이면 설치를 보류하므로 모두 종료한 뒤 같은 명령을 다시 실행합니다. 되돌린 앱을 시작하면 그 버전에 포함된 플러그인으로 다시 맞춥니다.

Release 페이지에 있는 버전만 되돌릴 수 있습니다(1.0.6·1.0.7은 공개 태그가 없습니다). 이 명령은 사용자별 설치만 되돌립니다. 모든 사용자용으로 설치한 PC에서는 사용자별 사본이 옆에 하나 더 생기므로 아무것도 받기 전에 거부합니다. 이때는 해당 태그의 설치 파일을 직접 받아 실행합니다.

기존 PC의 설정·대화 파일은 그대로 두고 플러그인 소스만 버전별 경로로 옮깁니다. 설치 체크포인트는 `$PASEO_HOME/suite/checkpoints`에 남습니다. 다른 세션이 수정한 설정은 복구 과정에서 덮어쓰지 않습니다. Windows 설치기는 실행 중인 Paseo 프로세스를 강제 종료하지 않으며, 사용 중인 설치 파일을 교체하기 전 종료를 요청합니다.

## 개발·검증

Node 24와 npm을 사용합니다. 본체 checkout과 이 저장소를 나란히 두고 본체 경로를 `PASEO_CORE_ROOT`로 지정할 수도 있습니다.

```text
npm ci
npm run typecheck
npm run lint
npm run build -- --core=../paseo-core
npm test
```

본체 웹 빌드를 먼저 만들면 `build`가 그 번들에 맞는 모듈 지도를 추가합니다. 이전 번들의 지도는 유지합니다. 내부 UI 모듈 연결은 현재 포크의 확장 기능이며 업스트림 공식 SDK 지원으로 간주하지 않습니다.

본체 웹·서버·데스크톱 main 빌드 후 Suite 폴더에서 패키징합니다.

```text
npm run package:win
npm run smoke
```

배포 파일은 `dist/installers`에 생성됩니다. 검증이 끝난 본체 커밋·플러그인 해시를 고정한 뒤 공개 Suite Release에 올립니다. 공개 포크의 기존 기본 브랜치 이력을 덮어쓰지 않고 검증한 본체를 별도의 릴리스 태그로 고정합니다.

## 작업공간

작업공간은 본체, UI, Aster, Settings Sync, 통합·배포의 다섯 역할을 기준으로 관리합니다. 새 작업은 위 표의 경로에서 이어갑니다. 이전 대화는 역할별 보관 대상으로 연결하며 대화 내용을 물리적으로 합치거나 삭제하지 않습니다. 실행 중인 세션과 열린 대화 탭은 정리 과정에서 종료하지 않습니다.

| 대표 작업공간      | 이어서 다룰 내용                                   | 이전 작업 기록                                                                                    |
| :----------------- | :------------------------------------------------- | :------------------------------------------------------------------------------------------------ |
| 01 · Paseo Core    | 본체 UI·플랫폼·안전한 재시도·확장 API              | 채팅창, 사이드바, 상단바, 프로젝트 그룹핑, 세션 전체 설정, 호스트 터미널 접속, 코덱스 오류 재시작 |
| 02 · Paseo UI      | 전역 탭·제목·호스트 순서·기록 불러오기·터미널 화면 | 탭 수정, 호스트 오더링, 터미널                                                                    |
| 03 · Aster         | 계정 선택·전환·구독 상태·대화 라우팅               | 클로드2개                                                                                         |
| 04 · Settings Sync | 환경 백업·복원·동일 계정 인증 전달                 | 셋팅싱크                                                                                          |
| 05 · 통합·배포     | 본체와 플러그인 버전·설치·이전·검증·릴리스         | 플러그인전체                                                                                      |

이전 기록은 `기록 · 역할 · 이전 이름`으로 식별합니다. 새 대표 작업공간의 대화는 기존 대화와 별개이며, 기존 기록은 기록 화면에서 계속 열 수 있습니다. 현재 열어 둔 이전 작업공간은 보관하지 않습니다.
