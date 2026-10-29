import type { PluginServerContext } from "@getpaseo/plugin/server";
import { settings } from "./shared/settings";
import { settings as titleSettings } from "./modules/titles/shared/settings";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(settings);
  server.registerSettings(titleSettings);
  return () => {};
}
