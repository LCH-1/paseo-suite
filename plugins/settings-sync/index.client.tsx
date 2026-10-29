import type { PluginClientContext } from "@getpaseo/plugin/client";
import contributeBackup from "./client/contribute";
import { contributeRelay } from "./client/relay-runtime";
import { suiteMethods, suiteSettings } from "./shared/suite-settings";

export default function contribute(client: PluginClientContext) {
  let stopped = false;
  let backup: ReturnType<typeof contributeBackup> | undefined;
  let relay: (() => void) | undefined;
  let pending: Promise<void> = Promise.resolve();
  const refresh = () => {
    pending = pending.catch(() => {}).then(async () => {
      if (stopped) return;
      const result = await client.rpc(suiteMethods.read, {});
      if (stopped) return;
      if (result.status !== "ready") throw new Error(result.error);
      const flags = suiteSettings.schema.parse(result.values);
      if (flags.backup && !backup) backup = contributeBackup(client);
      if (!flags.backup && backup) { backup(); backup = undefined; }
      if (flags.relay && !relay) relay = contributeRelay();
      if (!flags.relay && relay) { relay(); relay = undefined; }
    });
    void pending.catch((error) => { if (!stopped) console.error("[settings-sync] 모듈 설정을 적용하지 못했습니다.", error); });
  };
  const observation = client.paseo.observeEvents(["status.plugin_settings_changed"]);
  const unsubscribe = observation.subscribe({
    snapshot: refresh,
    update: (event) => { if (event.type === "status" && event.payload.settingsId === suiteSettings.id) refresh(); },
    error: (error) => console.error("[settings-sync] 모듈 설정 관찰이 중단되었습니다.", error),
  });
  void observation.ready.catch((error) => console.error("[settings-sync] 모듈 설정 관찰을 시작하지 못했습니다.", error));
  refresh();
  return async () => {
    stopped = true;
    unsubscribe();
    relay?.();
    backup?.();
    await observation.release();
  };
}
