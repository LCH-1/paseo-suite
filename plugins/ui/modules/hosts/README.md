# Host Order

Paseo 설정의 **호스트 순서** 화면에서 위·아래 버튼으로 순서를 바꿉니다. 변경은 현재 앱에 즉시 저장되고, 호스트 선택 목록과 다른 플러그인의 호스트 목록에 반영됩니다. 로컬 호스트도 이동할 수 있습니다.

- 새 호스트는 사용자 지정 목록 끝에 추가됩니다. 연결이 끊긴 호스트도 순서를 유지합니다.
- **기본 순서 → 복원**을 누르면 사용자 지정 순서를 지우고 로컬 호스트가 우선인 Paseo 기본 동작으로 돌아갑니다.
- 순서는 앱/브라우저별로 저장합니다. 서버 연결 정보와 인증값은 변경하지 않습니다.
- 플러그인을 끄면 기본 표시 순서를 사용합니다. 다시 켜면 저장한 순서를 적용합니다.

## 설치

```powershell
paseo plugin install "C:\path\to\host-order"
```

설정을 열고 호스트의 플러그인 항목에서 **호스트 순서**를 선택합니다. 명령 팔레트에서도 **호스트 순서 설정**을 검색할 수 있습니다.

## 개발

```powershell
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm check:bundle
pnpm package
```

`pnpm build`는 설치된 Windows Paseo 앱의 bundle에서 호스트 runtime과 정렬 모듈을 확인해 `client/module-maps.ts`를 생성합니다. 별도 app-dist 경로를 인자로 지정할 수도 있습니다.

Paseo 0.12.0의 공개 SDK에는 호스트 순서 mutation이 없어, 이 플러그인은 지원 bundle의 `getHosts`와 `orderHostsLocalFirst`를 감쌉니다. 원본 호스트 배열과 registry는 수정하지 않고, 전용 `@paseo:host-order` 저장소에 serverId 배열만 씁니다. 다른 호스트에 중복 설치해도 앱 안에서 controller 하나를 공유하며 마지막 설치가 종료될 때 wrapper를 복원합니다.

설정·명령 등록이 중간에 실패하면 이미 등록한 항목과 해당 설치의 controller 소유권을 함께 해제합니다. 이후 다시 불러오면 남은 wrapper 없이 초기화합니다. 해제 과정의 일부 오류가 다른 항목의 정리를 막지 않습니다.

앱 업데이트로 bundle이 바뀌면 모듈 맵을 다시 생성하고 플러그인을 다시 불러오세요. 확인되지 않은 bundle과 모바일 앱은 설정에 지원 안내를 표시합니다.
