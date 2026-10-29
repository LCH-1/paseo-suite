import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { TitleSyncController } from "./client/controller";
import { TitleSyncSettings } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  const controller = new TitleSyncController(client);
  function Settings(props: PluginSurfaceProps) {
    return <TitleSyncSettings {...props} controller={controller} />;
  }
  const removeSettings = client.addSettingsScreen({
    id: "titles", title: "Sidebar Title Sync", icon: "PanelTop", Component: Settings,
  });
  controller.start();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    controller.stop();
    removeSettings();
  };
}
