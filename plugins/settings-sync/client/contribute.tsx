import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { SyncSettings } from "./settings";
import { AutoClient } from "./automation";
import { rpc } from "../shared/rpc";

export default function contribute(client: PluginClientContext) {
  const automation = new AutoClient({
    status: () => client.rpc(rpc.autoStatus, {}),
    enable: (input) => client.rpc(rpc.autoEnable, input),
    claim: (input) => client.rpc(rpc.autoClaim, input),
    configure: (input) => client.rpc(rpc.autoConfigure, input),
    disable: () => client.rpc(rpc.autoDisable, {}),
    tick: (input) => client.rpc(rpc.autoTick, input),
    acknowledge: (input) => client.rpc(rpc.autoAck, input),
  });
  function Settings(props: PluginSurfaceProps) { return <SyncSettings {...props} automation={automation} />; }
  function SyncSidebar() {
    return <SidebarRow icon="Cloud" onPress={() => client.openSettings("sync")} />;
  }

  const cleanups = [
    automation.start(),
    client.addSettingsScreen({ id: "sync", title: "Settings Sync", icon: "Cloud", Component: Settings }),
    client.addSidebarHeaderItem({ id: "sync", title: "Settings Sync", Component: SyncSidebar }),
    client.addCommandCenterItem({ id: "sync", title: "Settings Sync 열기", icon: "Cloud", keywords: ["sync", "settings", "동기화", "설정"], context: "global", onSelect: ({ openSettings }) => openSettings("sync") }),
  ];
  return () => cleanups.reverse().forEach((cleanup) => cleanup());
}
