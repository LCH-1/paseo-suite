# Session Import

Paseo의 공통 세션 불러오기 확장입니다. Aster 설치 여부와 관계없이 동작하며 인증·계정 자동 분배·대화 파일을 수정하지 않습니다.

- 경로: 해당 프로젝트 경로(기본값), 모든 경로
- 모델: 모든 모델(기본값), Claude, Codex
- 닫고 다시 열면 기본값으로 돌아갑니다.
- 새 워크스페이스 화면에서는 현재 작성 탭에서 선택한 프로젝트 경로를 사용합니다. 마지막으로 열었던 workspace와 호스트가 달라도 현재 선택을 우선하며, 채팅·터미널 작성 탭을 각각 격리합니다.
- 사이드바에서는 같은 호스트의 마지막 선택 workspace 작업 경로를 사용합니다. 프로젝트가 없으면 안내하고 전체 조회는 직접 선택해야 합니다.

Claude 계정별 기록은 하나의 Claude 필터로 묶으며 실제 불러오기는 원래 provider/session ID를 사용합니다. 같은 기록과 이미 열린 기록을 중복 표시하지 않고 호스트·경로별 캐시를 분리합니다. 같은 workspace의 여러 Claude 대화는 탭 제목으로 구별합니다.

기존 Aster 0.1.12 이하가 불러오기 화면을 확장하고 있다면, 화면 소유권을 분리한 Aster 0.1.13도 함께 적용합니다. 이후 Session Import와 Aster는 서로의 해제에 영향을 주지 않습니다.

설치: `paseo plugin install "."`. 지원 범위는 Paseo 0.12이며 앱의 모듈 exports와 의존성 계약을 검증한 후 적용합니다. 호환되지 않으면 원본 화면을 유지하고 오류를 보고합니다. 여러 호스트가 같은 확장 수명을 공유하며 마지막 해제에서 원본을 복원합니다.

개발 검증: `pnpm test`, `pnpm typecheck`, `pnpm verify:bundle`.

`client/import-component.ts`는 `client/import-sheet-source.tsx`와 `client/import-sheet-view-model.tsx`에서 생성합니다. `node server/build-import-component.cjs <Paseo packages/app 경로>`로 재생성하며 앱 경로는 빌드 도구·스타일 변환·원본 라이선스를 제공합니다.

원본 컴포넌트: https://github.com/getpaseo/paseo (Apache-2.0). 원본의 LICENSE·NOTICE 고지는 생성 컴포넌트에 포함됩니다. 플러그인에서 경로·모델 필터, 계정 기록 통합 및 호스트별 캐시를 수정했습니다.
