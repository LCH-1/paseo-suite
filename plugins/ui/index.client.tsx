import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import tabs from "./modules/tabs/index.client.js";
import titles from "./modules/titles/index.client";
import hosts from "./modules/hosts/index.client";
import importSessions from "./modules/import/index.client";
import terminal from "./modules/terminal/index.client";
import { UiModules } from "./client/modules";
import { installUsagePolling } from "./client/usage-polling";
import { methods, moduleIds, settings } from "./shared/settings";

const labels = {
  tabs: "전역 탭",
  hosts: "호스트 순서",
  import: "기록 불러오기",
  titles: "제목 표시",
  terminal: "터미널 대화 화면",
};
function ModulesSettings() {
  const state = useSettings(settings);
  return (
    <SettingsSection title="Paseo UI">
      {moduleIds.map((id) => (
        <SettingsSwitch
          key={id}
          label={labels[id]}
          value={state.status === "ready" && state.values.modules[id]}
          disabled={state.status !== "ready" || state.saving}
          onValueChange={(enabled) => {
            if (state.status === "ready")
              void state.save(
                { modules: { ...state.values.modules, [id]: enabled } },
                state.revision,
              );
          }}
        />
      ))}
    </SettingsSection>
  );
}

export default function contribute(client: PluginClientContext) {
  const extended = client as PluginClientContext & {
    addLegacyId?(id: string): () => void;
  };
  if (typeof extended.addLegacyId !== "function")
    throw new Error("Paseo UI: 통합본 Paseo 빌드가 필요합니다.");
  const modules = new UiModules({
    tabs: () => tabs(client),
    hosts: () => hosts(client),
    import: () => importSessions(),
    titles: () => titles(client),
    terminal: () => terminal(client),
  });
  const cleanups = [
    installUsagePolling(),
    ...[
      "global-workspace-tabs",
      "host-order",
      "session-import",
      "sidebar-title-sync",
    ].map((id) => extended.addLegacyId!(id)),
    client.addSettingsScreen({
      id: "modules",
      title: "Paseo UI",
      icon: "PanelsTopLeft",
      Component: ModulesSettings,
    }),
  ];
  let stopped = false;
  let pending: Promise<void> = Promise.resolve();
  const refresh = () => {
    pending = pending
      .catch(() => {})
      .then(async () => {
        if (stopped) return;
        const result = await client.rpc(methods.read, {});
        if (stopped) return;
        if (result.status !== "ready") throw new Error(result.error);
        modules.apply(settings.schema.parse(result.values));
      });
    void pending.catch((error) => {
      if (!stopped)
        console.error("[paseo-ui] 설정을 적용하지 못했습니다.", error);
    });
  };
  const observation = client.paseo.observeEvents([
    "status.plugin_settings_changed",
  ]);
  const unsubscribe = observation.subscribe({
    snapshot: refresh,
    update: (event) => {
      if (event.type === "status" && event.payload.settingsId === settings.id)
        refresh();
    },
    error: (error) =>
      console.error("[paseo-ui] 설정 관찰이 중단되었습니다.", error),
  });
  void observation.ready.catch((error) =>
    console.error("[paseo-ui] 설정 관찰을 시작하지 못했습니다.", error),
  );
  refresh();
  return async () => {
    stopped = true;
    unsubscribe();
    try {
      await modules.dispose();
    } finally {
      cleanups.reverse().forEach((cleanup) => cleanup());
      await observation.release();
    }
  };
}
