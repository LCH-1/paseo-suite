# Paseo 개발용 호스트 확장

이 패치는 공개 Paseo `v0.12.0`, 커밋 `cafe4b01c8522ff39560241c5deb01427dc8dc5b`를 기준으로 작성했다. 공개 릴리스에 포함되거나 현재 설치 앱에 적용된 변경이 아니다. `BASELINE.json`에 정확한 기준점이 있다.

## 적용

별도 소스 체크아웃에서 적용한다. 설치된 앱의 번들을 수정하는 패치가 아니다.

```powershell
git clone --branch v0.12.0 --single-branch https://github.com/getpaseo/paseo.git paseo-title-sync
Set-Location paseo-title-sync
git rev-parse HEAD
git apply --check <배포폴더>/host/sidebar-title-resolver.patch
git apply <배포폴더>/host/sidebar-title-resolver.patch
```

`HEAD`가 위 커밋과 다르면 먼저 일치하는 소스에서 검증한다. SDK 확장과 앱 클라이언트 코드를 함께 빌드해야 한다. 기존 0.12.0 바이너리에 플러그인만 설치하면 미지원 안내가 표시된다. 지원 릴리스 번호와 배포용 버전 범위는 아직 정해지지 않았다. 데몬 프로토콜이나 저장 데이터 변경은 없다.

## 의존성과 검증

원본 저장소는 npm workspace와 `package-lock.json`을 사용한다. pnpm에서는 체크아웃 전용 `pnpm-workspace.yaml`을 만들고 원본 잠금 파일을 변환한다. 범위 의존성을 새로 해석하면 원본과 다른 xterm 번들이 설치될 수 있다.

```yaml
packages:
  - packages/*
  - plugins
linkWorkspacePackages: true
nodeLinker: hoisted
```

```powershell
pnpm --config.verify-deps-before-run=false import
pnpm install --ignore-scripts --frozen-lockfile --config.verify-deps-before-run=false
pnpm --config.verify-deps-before-run=false exec patch-package --patch-dir patches --error-on-fail
node packages/protocol/scripts/generate-validation-aot.mjs
pnpm --config.verify-deps-before-run=false --dir packages/protocol exec tsc -p tsconfig.json --incremental false
pnpm --config.verify-deps-before-run=false --dir packages/relay exec tsc -p tsconfig.json --incremental false
pnpm --config.verify-deps-before-run=false --dir packages/client exec tsc -p tsconfig.json --incremental false
pnpm --config.verify-deps-before-run=false --dir packages/plugin exec tsc -p tsconfig.json --incremental false
pnpm --config.verify-deps-before-run=false --dir packages/highlight exec tsc -p tsconfig.json --incremental false
pnpm --config.verify-deps-before-run=false --dir packages/expo-two-way-audio exec tsc --types 'node,react'
pnpm --config.verify-deps-before-run=false --dir packages/app run typecheck
pnpm --config.verify-deps-before-run=false --dir packages/app exec vitest run src/plugins/evaluate.test.ts src/plugins/agent-tab-titles/resolve.test.ts src/plugins/catalog-sync.test.tsx src/plugins/registry.test.ts src/components/sidebar/sidebar-workspace-title.test.ts src/hooks/sidebar-workspaces-view-model.test.ts --bail=1 --project unit
```

pnpm 12의 자동 의존성 재설치가 원본 lifecycle의 npm 명령을 실행하지 않도록 위 옵션을 유지한다. 선택한 플랫폼에서 필요한 네이티브 빌드는 별도로 수행한다. 전체 앱 빌드·린트·플랫폼 테스트는 호스트 배포 전에 필요하다.

브라우저 통합 테스트는 실제 플러그인 소스와 원본 저장소의 격리된 테스트 데몬·Expo 앱을 사용한다.

```powershell
$env:PASEO_TITLE_SYNC_PLUGIN_SOURCE = '<배포폴더>'
pnpm --config.verify-deps-before-run=false --dir packages/app exec playwright install chromium
pnpm --config.verify-deps-before-run=false --dir packages/app exec playwright test e2e/browser/sidebar-title-sync.spec.ts --project=browser --workers=1
```

테스트 실행 상태와 남은 검증은 상위 `VALIDATION.md`를 확인한다. 단위 검증만으로 실제 앱 통합을 완료했다고 판정하지 않는다.

## 공개 API

`client.addAgentTabTitleResolver({ id, resolve })`는 `{ invalidate(), remove() }` 핸들을 반환한다. `resolve` 입력은 읽기 전용 `serverId`, `workspaceId`, `agentId`, `defaultLabel`, `sidebarLabel` 및 선택적인 `subagentId`다. provider subagent 탭의 `agentId`는 소유 부모 에이전트다.

- `sidebarLabel`은 같은 클라이언트의 사이드바 이름 함수·설정·작업공간 캐시를 사용한다. 원문 공백과 Unicode를 보존한다.
- 반환 문자열이 비어 있으면 기본 표시로 위임한다. 예외·잘못된 결과는 격리하며 잘못 반환한 promise의 rejection도 처리한다.
- `(serverId, workspaceId)`와 에이전트의 소속을 검사한다. 다른 호스트의 설치는 개입하지 않는다.
- 우선순위는 플러그인 ID, 등록 ID의 코드 단위 오름차순이다. 첫 유효 문자열을 사용한다.
- 일반 대화·자식 대화·provider subagent 내장 탭의 label·기본 tooltip·loading state만 바꾼다. subtitle·아이콘·상태·탭 ID·저장 제목은 유지한다.
- 등록 제거는 멱등적이다. 플러그인 비활성화·제거·리로드·호스트 제거·setup 실패가 소유 등록을 해제한다. setup 후 비동기로 추가한 등록도 추적한다.
- 일시적 연결 해제는 설치와 캐시 이름을 보존한다. 재연결의 authoritative catalog를 받으면 설치 수명과 설정 관찰을 새로 만든다.

SDK의 `/client` 타입·앱 런타임·내장 descriptor·공개 레퍼런스를 함께 바꾼다. 플러그인이 `/client/host`, 내부 store, DOM에 접근할 필요가 없다.

`LICENSE`는 패치 기준 Paseo의 Apache-2.0 라이선스다.
