import type { PluginClientContext } from "@getpaseo/plugin/client";
import { TerminalScreen } from "./client/terminal";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({ id: "terminal", title: "Terminal Tabs", Component: TerminalScreen }),
  ];
  return () => cleanups.reverse().forEach((cleanup) => cleanup());
}
