import path from "node:path";
import { z } from "zod";
import type { PluginBackup } from "../shared/model";
import { packPlugin } from "./files";
import { suiteInstallation } from "./suite-compat";
import { nativeStateKey } from "./plugin-state";
import { uiTransferKey, uiIds, uiModulesSchema } from "../shared/suite-transfer";

export async function legacyTransfer(home: string, plugins: PluginBackup[]): Promise<PluginBackup[]> {
  const suite = await suiteInstallation(home);
  if (!suite || !plugins.length) return plugins;
  const ui = plugins.find((plugin) => plugin.id === "terminal-tabs");
  const result = plugins.filter((plugin) => !["terminal-tabs", "aster"].includes(plugin.id));
  const legacy = async (id: string, enabled: boolean, settings: PluginBackup["settings"]) => {
    const packed = await packPlugin(home, id, path.join(suite.release, "compatibility/plugins", id), enabled);
    if (!packed) throw new Error("구버전 호스트용 호환 배포본이 없습니다.");
    return { ...packed, settings };
  };
  if (ui) {
    const rawModules = ui.settings["paseo-ui"]?.values;
    const modules = uiModulesSchema.parse(z.object({ modules: z.unknown() }).parse(rawModules).modules);
    const projection = Object.fromEntries(Object.keys(uiIds).map((id) => [id, ui.enabled && modules[id as keyof typeof modules]]));
    for (const [key, id] of Object.entries(uiIds)) {
      const settings: PluginBackup["settings"] = id === "terminal-tabs" ? {
        ...ui.settings, [uiTransferKey]: { version: 1, values: { enabled: ui.enabled, modules, projection } },
      } : id === "sidebar-title-sync" && ui.settings["sidebar-title-sync"] ? { "sidebar-title-sync": ui.settings["sidebar-title-sync"] } : {};
      result.push(await legacy(id, ui.enabled && modules[key as keyof typeof modules], settings));
    }
    const enabled = z.object({ enabled: z.boolean() }).parse(ui.settings[nativeStateKey]?.values ?? { enabled: true }).enabled;
    result.push(await legacy("claude-windows-usage", enabled, {}));
  }
  const aster = plugins.find((plugin) => plugin.id === "aster");
  if (aster) result.push(await legacy("aster", aster.enabled, aster.settings));
  return result;
}
