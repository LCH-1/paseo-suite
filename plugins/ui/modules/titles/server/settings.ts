import type { PluginServerContext } from "@getpaseo/plugin/server";
import { settings } from "../shared/settings";

export function registerSettings(server: PluginServerContext) {
  server.registerSettings(settings);
  return () => {};
}
