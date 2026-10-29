# Sidebar Title Sync — 개발 빌드

Paseo의 **내장 대화 탭**을 위에는 프로젝트 이름, 아래에는 사이드바의 워크스페이스 표시 이름으로 표시합니다. 예를 들어 첫 줄은 `cursor-setting-sync`, 둘째 줄은 `main`입니다. 기본 툴팁은 `cursor-setting-sync-main`으로 표시합니다. `agent.title`과 작업공간 데이터는 수정하지 않습니다. 설정을 끄거나 플러그인을 제거하면 원래 제목 표시로 돌아갑니다.

**기존 Paseo 0.12.0에는 필요한 공개 API가 없습니다.** 이 폴더의 플러그인과 `host/`의 Paseo 소스 확장을 함께 사용해야 합니다. 일반 0.12.0에 플러그인만 설치하면 설정에 미지원 안내가 나오며 제목은 바뀌지 않습니다. 설치 앱 파일이나 DOM을 수정하는 제품이 아닙니다.

## 지원 상태

`derek`과 `CHLEE-GAMING`의 일반 Paseo 실행 항목에 확장 소스 빌드를 연결했습니다. 원래 프로필을 사용하며 별도 화면을 열 필요 없이 자동 적용됩니다. 설치·복원과 실제 검증 결과는 [적용 기록](deployment/README.md)을 확인하세요.

- 본체 기준: upstream `v0.12.0`, commit `cafe4b01c8522ff39560241c5deb01427dc8dc5b`.
- manifest의 `requirements.paseo: "0.12.0"`은 **개발 검증 환경 제약**입니다. 정식 기능 지원 버전 범위가 아닙니다.
- 확장 API를 포함하는 정식 앱 릴리스는 미정입니다. 배포 시 앱·데몬을 각각 검증하고 manifest를 그 릴리스에 맞춰 확정해야 합니다.
- 검증 내용과 남은 통합 시나리오는 [VALIDATION.md](VALIDATION.md)에 기록합니다.

## 동작

같은 호스트의 모든 작업공간에 적용합니다. 기존·신규·가져온·복원된 대화 중 실제 내장 탭으로 열린 항목이 대상입니다. 비활성 탭에도 적용하며, 같은 작업공간의 여러 대화에는 접미사 없이 같은 이름을 표시합니다.

작업공간 연결은 `(serverId, workspaceId)`로 구분합니다. 이름·경로로 다른 작업공간을 찾지 않습니다. 프로젝트 이름은 공식 작업공간 메타데이터의 사용자 지정 이름, 표시 이름 순서로 읽습니다. 새 확장 앱은 소속을 검증한 `projectLabel`과 사이드바 원문을 제공하고 각각 두 줄로 표시합니다. 이름의 하이픈을 분리해 추측하지 않습니다. 프로젝트 이름만 변경돼도 바로 갱신합니다. 이전 확장 앱에서는 기존 `프로젝트-워크스페이스` 한 줄 표시를 유지합니다. 정보가 아직 없으면 사이드바 이름을 표시하다가 정보 수신 후 갱신합니다. 소속이나 사이드바 이름이 유효하지 않으면 기본 제목을 사용합니다. 파일·터미널·브라우저·플러그인 탭과 새 대화 작성 화면에는 적용하지 않습니다.

설정 기본값은 켜짐입니다. 공식 호스트 설정 저장 기능으로 설치별 `{ schemaVersion: 1, enabled: true }`를 저장합니다. 설정 변경 이벤트와 공식 작업공간 구독을 사용합니다. 배경 작업공간을 포함해 모든 페이지와 재연결 snapshot을 캐시에 반영합니다. 조회가 실패했을 때만 제한된 재시도를 수행하며 정상 상태에서는 폴링하지 않습니다. 제목 resolver는 제공된 값과 캐시만 읽으며 네트워크나 파일에 접근하지 않습니다. 호스트별 설치이므로 플러그인이 없는 다른 호스트의 대화에는 적용되지 않습니다.

## 소스 구성

| 경로 | 역할 |
| --- | --- |
| `index.client.tsx`, `client/` | 설정 화면, 설정 변경 관찰, resolver 수명주기 |
| `client/project-title-cache.ts` | 설치별 프로젝트 이름 캐시, 작업공간 전체 페이지·변경·재연결 구독 |
| `index.server.ts`, `server/` | 공식 설정 등록만 수행 |
| `shared/settings.ts` | 호스트별 설정 스키마·공식 RPC 계약 |
| `host/` | 정확한 Paseo 릴리스의 본체 확장 소스와 재적용 가능한 패치 |
| `tests/` | 원문 보존, 설치 격리, 설정 충돌·재연결·해제 회귀 검사 |

플러그인에서는 앱 내부 `/client/host`, 내부 store, 번들 경로를 가져오지 않습니다. `client/sdk-extension.ts`는 미출시 API의 선택적 타입 계약이며, 런타임에서는 메서드의 존재를 확인합니다. provider 서브에이전트 탭은 `agentId`로 소유 부모를 검증하고 선택적 `subagentId`로 대상을 구분합니다.

## 개발 검증

```powershell
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run check:bundle
pnpm run package
```

`pnpm run package`는 ZIP을 지원하는 `tar`(Windows 기본 bsdtar)를 이용해 `dist/sidebar-title-sync-0.3.0-dev.zip`을 만듭니다. 플러그인 사용자는 pnpm이나 개발 의존성을 설치할 필요가 없습니다. Paseo가 TS/TSX와 공식 런타임 모듈을 제공합니다.

`host/README.md`의 본체 소스 빌드가 준비되어 있으면 해당 릴리스의 공식 컴파일러로 검사할 수 있습니다. 이 명령은 앱 파일이나 플러그인 설치 상태를 변경하지 않습니다.

```powershell
node scripts/verify-runtime.mjs host/paseo/packages/server/dist/server/server/plugins/compiler.js
```

이 내부 컴파일러 경로는 개발 검사에만 쓰며 플러그인 런타임에는 포함하지 않습니다.

## 설치·비활성화·제거

먼저 `host/README.md`에 따라 확장을 포함한 클라이언트를 준비하세요. ZIP 사용 시 새 폴더에 압축을 푼 후 **대상 호스트**에 디렉터리를 설치합니다. 한 호스트에 설치해도 다른 호스트에 설치되지는 않습니다.

```powershell
paseo plugin install 'C:\path\to\sidebar-title-sync'
paseo plugin ls
```

Paseo 설정 → Plugins → Sidebar Title Sync에서 `대화 탭에 프로젝트 이름과 작업공간 이름을 두 줄로 표시`를 켜거나 끕니다. 기능을 지원하지 않는 앱에서는 스위치가 비활성화되고 미지원 안내가 표시됩니다. 글로벌 `pluginsEnabled`가 꺼져 있으면 먼저 Paseo에서 플러그인을 활성화해야 합니다.

```powershell
# 소스를 변경한 뒤 다시 불러오기
paseo plugin reload sidebar-title-sync

# 전체 플러그인 비활성화 / 다시 활성화
paseo plugin disable sidebar-title-sync
paseo plugin enable sidebar-title-sync

# 등록 제거 (원본 소스 폴더는 보존)
paseo plugin remove sidebar-title-sync
```

등록 ID를 `--id`로 바꿔 설치했다면 위 명령에도 해당 ID를 사용하세요. 저장 제목을 변경하지 않으므로 별도 제목 백업·복원 절차는 없습니다.

## 공식 자료

- [플러그인 공개 API와 설정·수명주기](https://paseo.sh/docs/plugins/reference)
- [v0.12.0 본체 소스](https://github.com/getpaseo/paseo/tree/cafe4b01c8522ff39560241c5deb01427dc8dc5b)

현재 공개 문서에는 미출시 기능도 포함될 수 있습니다. 이 개발 빌드는 위 커밋의 코드·타입과 실제 0.12.0 컴파일러를 기준으로 검증합니다.
