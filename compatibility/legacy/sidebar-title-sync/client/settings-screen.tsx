import { useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import type { TitleSyncController } from "./controller";

export function TitleSyncSettings({ theme, controller }: PluginSurfaceProps & { controller: TitleSyncController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return <View style={{ gap: 16 }}>
    {!state.supported && <Text style={{ color: theme.colors.foreground }}>
      이 Paseo 버전은 탭 제목 통일 기능을 지원하지 않습니다.
    </Text>}
    <SettingsSection title="Sidebar Title Sync">
      <SettingsSwitch
        label="대화 탭에 프로젝트 이름과 작업공간 이름을 두 줄로 표시"
        hint="위에는 프로젝트 이름, 아래에는 사이드바 이름을 표시합니다. 이전 확장 앱에서는 프로젝트 이름-사이드바 이름으로 표시하며 원래 대화 제목은 보존됩니다."
        value={state.supported && state.enabled}
        disabled={!state.supported || state.status !== "ready" || state.saving}
        onValueChange={(enabled) => { void controller.setEnabled(enabled); }}
      />
      <SettingsRow label="적용 범위" hint="이 호스트의 모든 작업공간" />
      {state.status === "loading" && <SettingsRow label="설정을 불러오는 중…" />}
      {state.error && <SettingsAction label="설정 확인" error={state.error} actionLabel="다시 불러오기"
        onPress={() => { void controller.reload(); }} disabled={state.saving} />}
    </SettingsSection>
  </View>;
}
