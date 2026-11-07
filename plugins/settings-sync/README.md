# Settings Sync

사용량을 표시할 호스트 선택은 기기별로 유지합니다. 다른 PC의 Ubuntu/Windows 선택을 가져와 현재 PC의 사용량 표시 대상을 바꾸지 않습니다. 사용량의 표시 방식과 고정할 항목은 계속 동기화합니다.

Paseo 0.12용 설정 동기화 플러그인. GitHub 로그인과 백업 암호를 한 번 연결하면, 앱을 사용하는 동안 원격 호스트·테마·프로바이더 설정·플러그인을 자동 백업하고 복원합니다. 개인 설정은 본인 계정의 암호화된 Secret Gist에 저장합니다. 저장소 주소·Client ID·토큰을 입력하지 않습니다.

## 설치·업데이트와 역할

[Suite 설치 파일](../../README.md)로 설치합니다. 이 소스 폴더의 별도 설치나 예전 Nest 설치 명령은 사용하지 않습니다. 환경 백업과 Aster에서 이동한 동일 계정 인증 전달을 각각 끌 수 있습니다. 암호화·동일 계정 확인·로그아웃 보호·CLI 잠금과 저장 저널은 기존 구현을 유지합니다. Aster는 계정 선택과 구독 라우팅만 담당합니다.

구형 PC에 보내는 백업은 기존 플러그인 형식과 5 MiB 제한을 유지합니다. Suite PC는 그 백업을 현재 설치 파일에 고정된 통합 코드로 해석합니다. 호환 코드 7개는 전송용이며 Suite에 별도 설치되지 않습니다. 실행 상태·모듈별 사용 여부·제목 설정과 Windows 사용량 선택은 왕복 보존합니다.

## 한 번 연결하기

1. 기존 환경이 있는 PC부터 Settings Sync → GitHub으로 로그인을 선택합니다.
2. 첫 백업에는 12자 이상의 백업 암호를 정하고 **자동 동기화 시작**을 누릅니다. 기존 백업이 있으면 먼저 가져오고, 없으면 현재 환경을 첫 백업으로 저장합니다. 이전 버전 백업도 읽습니다.
3. 다른 PC에도 위 릴리즈를 설치한 뒤 같은 GitHub 계정·백업 암호로 처음 한 번 연결합니다.
4. 이후 30초마다 변경을 확인합니다. 화면을 나가도 앱이 실행 중이면 계속하며, 앱을 다시 켜도 자동 연결됩니다. 변경이 없으면 새 백업을 올리지 않습니다. 실패하면 최대 5분 간격으로 재시도합니다. Paseo 앱이 닫혀 있으면 동기화하지 않습니다.

양쪽 PC가 동시에 바뀌면 자동 적용을 멈추고 **이 PC 사용 / 클라우드 사용**을 표시합니다. 이전 백업은 보존합니다. 앱 호스트·테마 저장소는 앱 내부 캐시 때문에 다시 읽어야 하므로, **복원 확인 완료 후 현재 창을 한 번 자동 새로고침**합니다. 설정 화면을 닫아 둔 경우에도 적용됩니다.

처음 연결할 때 이미 설치된 플러그인의 코드가 백업과 다르면, 개발 중인 원본이 예전 백업으로 바뀌지 않도록 한 번 선택을 요구합니다. 개발·원본 PC는 **이 PC 사용**, 백업을 가져올 PC는 **클라우드 사용**을 선택하세요. 플러그인이 비어 있는 새 PC는 기존 백업을 자동으로 받습니다.

키는 Windows DPAPI CurrentUser, macOS 로그인 키체인, Linux Secret Service에 보관합니다. 자동 상태와 복원 대기 데이터도 암호화합니다. GitHub 토큰은 gh가 관리합니다. **연결 해제**는 자동 동기화와 보관한 백업 키를 지우며 Gist나 gh 로그인은 삭제하지 않습니다. 다른 PC에는 같은 암호를 처음 한 번 입력해야 합니다. 암호를 잃으면 백업을 복구할 수 없으므로 별도로 보관하세요.

암호를 입력하고 **자동 동기화 시작**을 한 번 완료하면 창 이동·앱 재시작·플러그인 재로드와 업데이트 뒤에도 같은 OS 사용자와 Paseo 홈에서는 저장된 키로 연결합니다. 암호 입력란을 채우기만 하면 저장되지는 않습니다. 연결을 해제했거나 OS 사용자·키링·GitHub 계정이 바뀌면 다시 연결해야 합니다.

최초 연결에서는 기존 항목을 병합하고, 이후에는 삭제한 프로바이더·플러그인·공식 설정·원격 호스트·앱 설정도 다른 기기에 반영합니다. 코드가 같은 플러그인은 기존 설치 폴더를 유지합니다. 동기화 상태의 `pendingOperations`는 앱 적용 확인이 남은 복원 수입니다. `ready`, 최근 동기화 기록, `pendingOperations=0`을 함께 확인해야 합니다. 키를 읽을 수 없으면 대기 수는 `null`입니다.

각 PC의 앱은 그 PC의 로컬 호스트에서 자동 동기화를 연결하세요. 같은 원격 호스트에 여러 PC가 접속해도 환경을 번갈아 덮지 않도록, 데몬마다 담당 앱 하나가 자동 동기화를 실행합니다. 다른 앱에서는 해당 원격 호스트의 상태만 확인합니다. 이전 버전 연결이나 담당 앱을 바꿀 때는 **이 앱에서 동기화 담당**을 누르면 보관된 키로 이어집니다.

## 무엇이 동기화되나요?

설정 화면의 **동기화 항목**에서 아래 5개를 각각 선택하고 **범위 적용**을 누르세요. 선택은 현재 PC의 호스트에 암호화해 보관하며 재시작 후에도 유지합니다. 선택을 해제한 항목은 이 PC에서 수집·업로드·복원·삭제 전파를 건너뜁니다. 다른 PC의 선택과 기존 클라우드 데이터는 유지됩니다. 모두 해제하면 자동 동기화가 쉬고, 수동 백업·복원도 실행하지 않습니다.

토글은 저장 전 초안이므로 백그라운드 동기화나 다른 앱의 담당 상태와 관계없이 편집할 수 있습니다. 다른 앱이 담당 중이면 **이 앱에서 담당하고 범위 적용**으로 명시적으로 인계한 뒤 선택한 범위를 함께 저장합니다. 미완료 복원이 있으면 동기화 항목 바로 아래에 원인과 해결 안내를 표시하며, 기존 담당과 저장된 범위는 유지합니다.

미완료 복원과 계속 선택할 항목의 미전송 변경은 먼저 해결하세요. 오류가 난 항목은 선택을 해제해 동기화에서 뺄 수 있습니다. 다시 켠 범위는 클라우드를 먼저 확인하며, 기기별 차이가 있으면 **이 PC 사용 / 클라우드 사용**으로 선택합니다. 해제하기 전에 이미 저장한 데이터가 Gist에서 삭제되는 기능은 아닙니다.

| 항목 | 지원 범위 |
|---|---|
| 호스트 | 다른 기기에서 접근 가능한 relay·원격 TCP·SSH 연결과 접속 암호. 같은 호스트 ID의 이름·색상·목록 순서·host-order 플러그인 정렬. PC마다 로컬 연결 유지 |
| 화면 | 테마·플러그인 테마 선택·단축키·에이전트 생성 기본값·선호 편집기·변경 보기·사이드바 표시 모드·섹션 접힘·프로젝트/워크스페이스 정렬. 필요한 테마 플러그인도 설치되어야 함 |
| 프로바이더와 계정 | 선택한 호스트의 구성·API 키·프로필·모델 설정과 지원하는 CLI 로그인 인증. PC별 실행 파일·계정 경로로 복원. 최초에는 병합하며 이후 삭제도 전파 |
| 플러그인 | 코드·활성 상태·공식 plugin-settings 설정. Settings Sync 자체는 제외 |
| 서버 | 프롬프트·메타데이터 생성·터미널 프로필·도구 등 이식 가능한 설정 |

서버 도구 설정은 공식 API가 지원하는 `metadataGeneration.providers`, `browserTools.enabled`, `mcp.injectIntoAgents` 범위입니다. skills 설정은 대상에서 적용할 공식 API가 없어 제외합니다. 일반 설정 키의 삭제는 공식 API가 지원하지 않으므로 문자열·목록은 빈 값으로 초기화하세요.

0.3.0부터 **프로바이더 항목을 켜면 계정 인증도 같은 암호화 백업에 포함**됩니다. Claude의 Windows 파일·Credential Manager와 Linux 파일, Codex의 파일 인증, Cursor의 Windows·Linux CLI 인증 파일, Pi와 OpenCode 1의 인증 파일을 지원합니다. API 키·토큰 환경변수도 함께 이동합니다. 다른 계정이 이미 로그인된 대상에서는 관리 프로필로 분리하고, 같은 계정의 더 최신 인증은 유지합니다. Claude 계정 레지스트리가 있는 원본에서는 Aster가 사용하는 계정 연결도 현재 기기의 경로로 복원합니다.

복원할 때 표준 Claude·Codex·Cursor CLI가 없으면 공식 배포처에서 자동 준비합니다. Windows에서는 실행 가능한 `.exe`·`.cmd` 경로를 찾고, 원래 PC의 절대 경로를 그대로 사용하지 않습니다. 사용자 지정 실행 래퍼와 그 밖의 CLI는 대상 PC에 준비해야 합니다.

0.3.1은 호스트 표시·순서와 추가 사이드바 설정을 **백업 형식 3**에 저장합니다. **연결된 PC의 Settings Sync를 모두 0.3.1 이상으로 업데이트**하세요. 이전 버전은 새 형식을 읽지 못하므로 새 데이터를 누락한 채 재업로드하지 않습니다. 구형 백업에 없는 새 설정은 기존 PC의 값을 유지하고, 새 형식이 명시한 초기화만 반영합니다. 0.3.0의 인증 백업은 형식 2이며 계속 읽을 수 있습니다. 기존 백업에 로그인 정보가 없으면 로그인된 원본 PC에서 새 백업이 필요합니다. SSH 개인키·데몬 신원키·대화·프로젝트와 Aster 자체 설정 파일은 제외합니다.

0.3.2는 같은 백업에서 갈라진 동시 업로드를 감지해 자동 적용을 멈춥니다. **이 PC 사용 / 클라우드 사용**을 선택하면 선택한 환경을 새 백업으로 기록하고 갈라진 이전 백업도 보존합니다. 암호문 형식과 기존 백업 읽기는 유지합니다. 분기 감지를 사용하려면 연결한 PC를 모두 0.3.2 이상으로 업데이트하세요. 이전 버전의 업로드는 부모 revision 정보를 남기지 않으므로 같은 보호를 보장하지 않습니다.

0.3.3은 여러 Claude 프로바이더가 같은 프로필을 쓰는 PC와 각각 다른 프로필을 쓰는 PC 사이에서도 인증 연결이 겹치지 않게 백업합니다. 각 PC의 로컬 계정·경로와 클라우드의 기존 계정 연결을 보존하고, 새 프로바이더 연결은 별도로 추가합니다.

자동 동기화는 이미 로그인된 기기의 유효한 Claude 인증·계정 경로를 유지합니다. 0.3.6부터 로컬 인증이 만료됐고 같은 계정의 아직 만료되지 않은 인증이 백업에 있으면 기존 경로에서 자동 갱신합니다. 다른 계정의 인증이나 이미 만료된 백업으로 교체하지 않습니다. 기존 계정 메타데이터가 있는데 인증 파일이 비거나 사라진 경우에는 로그아웃과 일시적인 갱신 중단을 구분할 수 없어 자동으로 되살리지 않습니다. 인증이 전혀 없는 기기의 최초 복원과 사용자가 명시한 수동 복원은 계속 지원합니다. Windows 저장소 전환 표시가 어긋나 파일이 비어 있어도 실제 보안 저장소의 기존 로그인을 보호합니다.

0.3.7은 Claude 공식 CLI의 갱신·저장 잠금에 함께 참여해 인증을 동시에 덮어쓰지 않습니다. 갱신 중이면 현재 인증을 보존하고 재시도합니다. 정상적인 같은 계정의 백업 인증 복원은 유지하며, 인증 복원의 준비·완료·취소만 비밀정보 없이 기록합니다.

0.3.8은 인증을 수집할 때도 같은 잠금을 사용하고, 각 조각 저장 전후에 잠금 소유권을 확인합니다. 진행 중인 조각 수를 기록해 저장 실패나 중단 뒤 남은 조각까지 정리합니다. OAuth 발급 클라이언트·갱신 만료·구독 확인 필드를 보존하며, 실패한 자격증명 프로세스가 종료된 뒤 복구합니다. Windows 저장소 이름은 공식 CLI와 동일하게 환경변수의 원래 경로 표기로 계산하고 파일 잠금에는 실제 경로를 사용합니다. 인증 복원 기록에는 토큰 대신 실행 PID·프로바이더 ID·인증 만료 시각을 남깁니다.

0.3.9는 Windows 자격증명의 저장 범위를 공식 Claude CLI와 같은 Enterprise로 통일합니다. 이전 LocalMachine 방식과 섞어 쓰면 같은 항목의 파일이 Local·Roaming 양쪽에 남을 수 있습니다. 이미 두 저장본이 생긴 환경은 CLI 잠금을 확보하고 최신 인증과 완전한 기존 파일 복사본을 확인한 뒤 기존 LocalMachine 저장본을 정리할 수 있는 관리용 어댑터를 제공합니다. 인증 값은 바꾸거나 로그에 남기지 않습니다.

0.3.10은 Settings Sync가 Windows Claude 인증을 쓰기 전에 이전 값과 적용할 완전한 값을 로컬 복구 저널에 암호화합니다. 임의 AES 키는 Windows DPAPI CurrentUser로 보호하며, 정상 저장이나 복구 검증이 끝나면 저널을 지웁니다. 저장 도중 프로세스가 종료되면 다음 인증 수집에서 공식 CLI 잠금을 확보하고 완전한 한 세대로 복구합니다. 부모·실제 쓰기 자식의 PID와 시작 시각, 잠금 디렉터리의 소유권을 확인하고 Windows 프로세스 간 복구 잠금도 사용합니다. 새 로그인·계정 변경·명시적 로그아웃과 알 수 없는 외부 변경은 덮어쓰지 않습니다. 이 보호는 Settings Sync의 쓰기에 적용되며, 공식 CLI 자체의 급종료나 제공업체의 인증 철회까지 방지하지는 않습니다.

0.3.11은 같은 앱 ID로 여러 창이 동시에 동기화해도 앞선 요청의 복원 결과를 다른 창에 재사용하지 않습니다. 뒤늦게 합류한 요청은 다음 조회에서 현재 설정을 다시 확인해 복원 도중의 편집을 보존합니다. 복원 대기 상태는 스냅샷과 적용할 앱 설정을 함께 담을 수 있도록 별도의 로컬 암호화 크기 제한을 사용하며, Gist 백업의 5 MiB 제한은 유지합니다. macOS 키체인의 대화형 명령 길이를 넘는 암호는 부분 저장하기 전에 거절합니다.

0.3.12는 복원에 실패했을 때 실제로 적용한 파일과 서버 설정만 조건부로 되돌립니다. 복원 도중 사용자가 바꾼 플러그인 설정·설치 경로·프로바이더·서버 설정은 보존하며, 충돌이 있으면 다시 미리보기를 요청합니다. 인증 복원 준비 후에도 설정이 바뀌지 않았는지 재확인합니다. 서버 API는 읽기와 쓰기를 묶는 원자적 비교 기능을 제공하지 않으므로, 모든 외부 쓰기와 완전한 트랜잭션을 보장하는 기능은 아닙니다.

0.3.13은 플러그인을 종료할 때 새 동기화와 대기 중인 작업의 시작을 막고, 실행 중인 작업이 끝난 뒤 세션·자동 동기화 메모리를 정리합니다. 정상 종료 도중 암호나 복원 상태를 먼저 지우지 않습니다. Paseo가 제한 시간 뒤 프로세스를 강제로 종료하는 경우에는 다음 실행에서 저장된 복원 상태와 실제 설정을 다시 확인합니다.

0.3.14는 오래 걸리는 수동 복원을 세션·미리보기별로 한 번만 실행하고 완료 결과를 보관합니다. 기존 복원 호출이 시간 초과됐어도 같은 입력으로 재요청하면 저장된 결과를 받을 수 있습니다. 새 화면을 위한 시작·상태 조회·결과 해제 API도 추가했습니다. 실행 중인 작업과 앱에 반영할 완료 결과는 별도로 확인하며, 다른 세션에서는 조회할 수 없습니다. 결과는 세션에서 마지막 사용 후 30분 동안 메모리에 보관하며, 플러그인이나 서버 재시작 후에는 다시 연결하고 미리보기를 열어야 합니다.

0.3.15는 수동 복원 화면을 나갔다 돌아와도 같은 작업을 이어받습니다. 다른 창이나 자동 동기화가 같은 목표를 먼저 반영했다면 중복으로 쓰지 않으며, 사용자 편집이 다른 값이면 보존합니다. 원격 호스트와 로컬 주소의 경계를 정확히 구분하고, 릴리즈 설치기는 버전 하향을 거절하며 실패 시 이전 코드를 복구합니다. 지원하는 계정 인증 복원과 설치 방법 안내도 현재 동작에 맞췄습니다.

0.3.16은 Windows PowerShell 5에서 플러그인이 여러 개 설치된 경우에도 Settings Sync 항목만 선택하여 설치·업데이트·실패 복구하도록 수정했습니다. 기존 설정과 다른 플러그인은 보존합니다.

자동 동기화가 오래 걸리면 Paseo의 30초 호출 제한 전에 진행 상태를 반환합니다. 다음 조회는 같은 진행 작업을 공유하며, 완료된 복원은 기존 대기 작업을 통해 전달해 중복 실행하거나 결과를 버리지 않습니다.

0.3.6은 프로바이더 인증을 읽지 못해도 선택한 나머지 항목을 계속 동기화합니다. 상태 메시지에 **프로바이더 인증 대기**를 표시하고 로컬·클라우드의 기존 인증과 프로바이더 구성을 보존합니다. 재시작이나 앱 복원 확인 이후에도 대기 상태를 유지하고, 인증을 다시 읽을 수 있게 되면 대기 중의 프로바이더 변경을 재확인합니다. 프로바이더만 선택한 경우에는 처리한 다른 항목이 없으므로 오류로 남습니다. 대기 작업 0과 마지막 동기화 시각만으로 인증까지 완료됐다고 판단하지 마세요.

양쪽에서 수정한 범주가 다르면 기존 기준점과 비교해 자동으로 합친 뒤 새 백업을 만듭니다. 예를 들어 한 PC의 호스트 이름 변경과 다른 PC의 앱 설정 변경은 함께 반영합니다. 같은 범주가 서로 다른 값으로 바뀌었거나 백업이 분기된 경우에는 계속 명시적인 충돌 해결이 필요합니다.

서로 다른 Claude 계정이 이미 로그인된 PC도 자동 복원 뒤 각자의 계정을 유지합니다. 이 차이만으로 클라우드 계정을 번갈아 재업로드하지 않습니다. 사용할 백업 계정을 명시적으로 바꾸려면 **이 PC 사용**을 선택하세요.

계정 로그아웃·인증 철회·제공업체의 만료 정책을 동기화로 우회하지 않습니다. 일반 로그인 세션은 제공업체의 갱신 정책을 따릅니다. Claude macOS 키체인, Codex keyring, Cursor macOS 기본 키체인과 OpenCode 2 SQLite 인증은 이 버전의 파일 어댑터 대상이 아닙니다. 지원하지 않는 저장 방식을 확인하면 성공으로 표시하지 않고 해당 연결 방법을 안내합니다.

원래 PC의 localhost 연결 주소는 새 PC를 가리키므로 동기화에서 제외합니다. 이름·색상·순서는 연결 주소와 분리해 같은 호스트 ID에 적용하므로, 자기 PC의 이름을 바꾸어도 다른 PC에 반영됩니다. 아직 등록하지 않은 호스트의 표시 정보만으로 새 연결을 만들지는 않습니다. 원래 PC에도 원격 접속하려면 원래 PC의 paseo pair로 연결을 추가해야 합니다. 기존 백업에서 제외됐던 항목은 업데이트만으로 생기지 않으며 원본 PC에서 새 백업이 필요합니다. 실행 파일·터미널 경로·글꼴·SSH 키는 대상 OS에 맞게 준비하세요.

## 플러그인 복원과 실패 처리

플러그인을 수정하거나 새 버전으로 설치하면 코드·활성 상태·공식 설정의 변경도 자동 백업합니다. 같은 GitHub 계정·백업 암호로 자동 동기화한 다른 PC는 새 코드를 받아 재설치·로드합니다. 오프라인 PC는 다음 앱 실행에 가져옵니다. 양쪽에서 같은 플러그인을 수정했다면 충돌 해결이 필요합니다. **Settings Sync 자체는 자기 자신을 실행 중 덮어쓰지 않으며 위 릴리즈 설치 명령으로 업데이트합니다.**

플러그인 루트의 코드/JSON 및 client, server, shared, src, lib, dist, assets 파일을 백업합니다. 숨김 파일·node_modules·테스트·문서·symlink는 제외합니다. 런타임 의존성 설치나 준비 명령을 자동 실행하지 않습니다. 이식 가능한 자체 배포본이 필요합니다.

플러그인 설정은 공식 `PASEO_HOME/plugin-settings/<플러그인 ID>/` 저장소가 대상입니다. 0.3.6은 Aster의 `PASEO_HOME/aster/settings.json`에서 계정별 `capacities`도 별도로 가져옵니다. 백업에는 `paseo-nest.aster-settings.v1` 설정으로 담고, 복원 시 Aster 실제 설정 파일에 적용하며 이 PC의 실행 명령과 다른 값은 유지합니다. 실패 시 이 파일도 함께 복구합니다. 이 어댑터를 사용하려면 연결한 PC를 모두 0.3.6 이상으로 업데이트하세요. 그 밖의 자체 경로 파일, 열린 탭 상태, Paseo 앱 본체를 직접 수정한 코드는 범위에 포함되지 않습니다. 사이드바의 앱 저장 설정은 위 화면 범위, host-order 정렬은 호스트 범위에서 별도로 처리합니다.

terminal-tabs의 기존 @getpaseo/client 타입 의존성은 백업·복원 복사본에 SDK 타입 어댑터를 넣어 해결합니다. 원래 소스는 수정하지 않습니다. 이전 백업에도 적용됩니다. 다른 외부 런타임 의존성까지 자동 변환하지는 않습니다.

복원 파일은 새 디렉터리에 풀고, 활성 플러그인이 해당 새 경로에서 running 상태인지 확인합니다. 빌드·실행에 실패하면 성공으로 처리하지 않으며 서버 설정과 플러그인 설정을 복구합니다. 이전 상태는 PASEO_HOME/settings-sync/restore/<operation>/previous-config.json 및 previous-settings.json에 남깁니다. 서버와 앱 저장소 사이의 단일 트랜잭션은 없으며, 중단된 자동 복원은 기록을 읽고 검증 후 재개합니다.

미리보기 뒤 로컬 플러그인 코드가 바뀌면 복원을 중단하고 새 미리보기를 요구합니다. 실패한 복원에서 처음 추가한 터미널·에이전트 프로필은 빈 목록으로 초기화합니다. 공식 설정 API가 키 자체의 삭제는 지원하지 않아 빈 목록 키가 남을 수 있습니다.

~~~powershell
paseo plugin ls settings-sync
paseo plugin logs settings-sync
paseo plugin logs terminal-tabs
~~~

## 저장 방식과 제한

- AES-256-GCM, 무작위 salt/IV, PBKDF2-SHA256 600,000회. Gist에는 암호문·공개 복호화 파라미터·부모 revision 참조를 전송하며 키·암호는 전송하지 않습니다.
- Secret Gist는 링크를 아는 사람이 읽을 수 있어 암호화가 필요합니다. 백업마다 새 Gist를 만들고 이전 백업을 보존하며 자동 삭제하지 않습니다. 부모가 있는 백업은 최근 부모 revision 범위까지만 목록을 조회합니다. 부모가 없는 첫 백업은 설정이 바뀌지 않은 동안에도 전체 목록을 조회하며, 안전한 탐색 상한은 100페이지입니다. Gist API에는 원자적 비교·교환이 없으므로 동시 생성 자체를 막지 않고, 확인된 분기를 충돌로 처리합니다. GitHub는 크기·시점·백업 이력을 볼 수 있습니다.
- 데스크톱·웹의 Paseo 0.12 저장 형식용 어댑터입니다. 모바일·다음 Paseo 버전의 호환성은 보장하지 않습니다. Paseo 앱 파일을 수정하거나 비공개 UI 모듈을 호출하지 않습니다.
- 원격 호스트 목록은 연결한 앱, 서버 설정·플러그인은 선택한 호스트에 적용됩니다. 다른 원격 호스트 자체의 설정·파일은 변경하지 않습니다.
- 원문 최대 5 MiB, 플러그인당 1,500개 파일. 실패한 항목을 조용히 누락한 백업은 만들지 않습니다. 플러그인은 앱·호스트에서 코드로 실행되므로 신뢰하는 본인 계정과 호스트에서 연결하세요.

## 개발·배포

개발 PC에서만 실행합니다.

~~~powershell
pnpm install --frozen-lockfile --ignore-scripts --ignore-workspace
pnpm build
pnpm typecheck
pnpm test
pnpm test:installers
pwsh -NoProfile -File scripts/package.ps1
~~~

server/contribute.ts를 server/runtime.js로 번들하며 공식 protocol 설정 검증을 포함합니다. 호스트 제공 SDK·zod·React·React Native만 외부 참조합니다. package.ps1은 허용된 배포 파일만 새 .check/release-* 폴더에 넣고 settings-sync.zip과 SHA256SUMS를 만듭니다.

설치기 검사는 Python 3와 해당 OS의 PowerShell 또는 Bash가 필요합니다. 모의 Paseo·GitHub CLI와 임시 홈에서 검사하므로 실제 호스트·인증을 변경하지 않습니다. Windows 기본 PowerShell 5.1과 PowerShell 7, Ubuntu Bash에서 실행해 확인합니다.

RPC 계약은 shared/rpc.ts입니다. [GitHub CLI 로그인](https://cli.github.com/manual/gh_auth_login), [Gist API](https://docs.github.com/en/rest/gists/gists)를 사용합니다.

## Bundled third-party license

The server distribution includes compiled @getpaseo/protocol 0.12.0 from Paseo. The schemas are bundled without semantic changes. Upstream license:

<details>
<summary>Paseo / Apache License 2.0</summary>

<pre>
Copyright (c) 2025-present Mohamed Boudra

Portions of this software are licensed as follows:

* Third-party components incorporated into Paseo remain licensed under
  the licenses provided by their respective copyright holders.
* Except for those third-party components, Paseo is licensed under the
  Apache License, Version 2.0, reproduced below.


                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      &quot;License&quot; shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      &quot;Licensor&quot; shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      &quot;Legal Entity&quot; shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      &quot;control&quot; means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      &quot;You&quot; (or &quot;Your&quot;) shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      &quot;Source&quot; form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      &quot;Object&quot; form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      &quot;Work&quot; shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      &quot;Derivative Works&quot; shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      &quot;Contribution&quot; shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, &quot;submitted&quot;
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as &quot;Not a Contribution.&quot;

      &quot;Contributor&quot; shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a &quot;NOTICE&quot; text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an &quot;AS IS&quot; BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets &quot;[]&quot;
      replaced with your own identifying information. (Don&#39;t include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same &quot;printed page&quot; as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the &quot;License&quot;);
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an &quot;AS IS&quot; BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

</pre>
</details>


## 앱 창 없는 인증 전달

0.5.2부터 데몬이 살아 있으면 앱 창과 관계없이 Claude 인증을 호스트 사이에 전달합니다. 살아 있는 데몬 중 하나(Linux 우선)가 1분마다 전달하고, 나머지는 대기하다가 그 데몬이 멈추면 이어받습니다. 앱 창은 호스트 접속 정보를 데몬에 알려 주고, 리더가 닿지 못하는 호스트가 있을 때만 전달을 보조합니다.

접속 정보는 각 호스트의 `settings-sync/relay-peers.json`에 소유자 전용 권한으로 저장되고 백업에 포함되지 않으며 RPC로 다시 읽을 수 없습니다. **이 파일로 다른 호스트에 앱과 같은 권한으로 접속할 수 있으므로, 호스트 하나가 침해되면 목록의 다른 호스트도 위험해집니다.** 앱에서 호스트를 지우면 다음 전달 때 각 호스트의 목록에서도 빠집니다. 끄려면 설정에서 인증 전달을 끄고 이 파일을 지우세요.
