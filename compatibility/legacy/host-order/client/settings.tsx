import { useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import type { Controller } from "./controller";

export function HostOrderSettings({
  theme,
  controller,
}: PluginSurfaceProps & { controller: Controller | null }) {
  if (!controller)
    return (
      <SettingsSection title="호스트 순서">
        <SettingsRow
          label="현재 Paseo 버전에서는 호스트 순서를 변경할 수 없습니다."
          hint="데스크톱 또는 웹의 지원되는 Paseo 버전에서 사용하세요."
        />
      </SettingsSection>
    );
  return <HostList theme={theme} controller={controller} />;
}

function HostList({
  theme,
  controller,
}: {
  theme: PluginSurfaceProps["theme"];
  controller: Controller;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  function moveButton(serverId: string, label: string, direction: -1 | 1, disabled: boolean) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label} ${direction === -1 ? "위로" : "아래로"}`}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => controller.move(serverId, direction)}
        style={({ pressed }) => ({
          minWidth: 44,
          minHeight: 40,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
          backgroundColor: theme.colors.surface0,
          opacity: disabled ? 0.3 : pressed ? 0.6 : 1,
        })}
      >
        <Text style={{ fontSize: 17, color: theme.colors.foreground }}>
          {direction === -1 ? "↑" : "↓"}
        </Text>
      </Pressable>
    );
  }
  return (
    <View style={{ gap: 16 }}>
      <SettingsSection title="호스트 순서">
        <SettingsRow
          label="사이드바에서 호스트 바를 드래그해 순서 변경"
          hint="위아래 버튼으로도 바꿀 수 있으며 변경 즉시 이 앱에 저장됩니다. 로컬 호스트도 이동할 수 있고 새 호스트는 목록 끝에 표시됩니다."
        />
        {state.hosts.length === 0 && <SettingsRow label="등록된 호스트가 없습니다." />}
        {state.hosts.map((host, index) => (
          <SettingsRow key={host.serverId} label={`${index + 1}. ${host.label}`}>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {moveButton(host.serverId, host.label, -1, index === 0)}
              {moveButton(host.serverId, host.label, 1, index === state.hosts.length - 1)}
            </View>
          </SettingsRow>
        ))}
        <SettingsAction
          label="기본 순서"
          hint="사용자 지정 순서를 지우고 Paseo 기본 표시 순서로 돌아갑니다."
          actionLabel="복원"
          disabled={!state.custom && !state.error}
          onPress={() => controller.reset()}
          error={state.error || null}
        />
      </SettingsSection>
    </View>
  );
}
