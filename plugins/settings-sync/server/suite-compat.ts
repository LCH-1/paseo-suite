import path from "node:path";
import { readFile } from "node:fs/promises";
import type { PluginBackup } from "../shared/model";
import { packPlugin } from "./files";
import { nativeStateKey } from "./plugin-state";
import { uiTransferKey, uiTransferSchema } from "../shared/suite-transfer";

const legacyUi = { tabs: "global-workspace-tabs", hosts: "host-order", import: "session-import", titles: "sidebar-title-sync", terminal: "terminal-tabs" } as const;
export async function suiteInstallation(home: string): Promise<{ release: string; nativeUsagePending: boolean } | null> {
  let raw: string;
  try { raw = await readFile(path.join(home, "suite/installed.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const state = JSON.parse(raw);
  if (state.schemaVersion !== 1 || typeof state.release !== "string" || !path.isAbsolute(state.release)) throw new Error("Suite 설치 상태를 확인하세요.");
  return { release: state.release, nativeUsagePending: state.nativeUsagePending === true };
}

/** Old cloud snapshots must not reinstall the five retired UI plugins or relay. */
export async function normalizeSuitePlugins(home: string, incoming: PluginBackup[]): Promise<PluginBackup[]> {
  const suite = await suiteInstallation(home);
  if (!suite) return incoming;
  const byId = new Map(incoming.map((plugin) => [plugin.id, plugin]));
  const oldUi = Object.values(legacyUi).some((id) => id !== "terminal-tabs" && byId.has(id))
    || Boolean(byId.has("terminal-tabs") && !byId.get("terminal-tabs")!.settings["paseo-ui"]);
  const oldAster = byId.get("aster");
  // Suite code is pinned by its installer; remote account settings may travel,
  // but an old peer must never replace the account/relay ownership boundary.
  const legacyAster = Boolean(oldAster);
  const windows = byId.get("claude-windows-usage");
  if (!oldUi && !legacyAster && !windows) return incoming;
  const retired = new Set<string>(oldUi ? Object.values(legacyUi) : []);
  retired.add("claude-windows-usage");
  if (legacyAster) retired.add("aster");
  const result = incoming.filter((plugin) => !retired.has(plugin.id));
  let ui = oldUi ? null : result.find((plugin) => plugin.id === "terminal-tabs");
  if (oldUi || windows && !ui) {
    const modules = Object.fromEntries(Object.entries(legacyUi).map(([id, legacy]) => [id, byId.get(legacy)?.enabled === true]));
    let enabled = Object.values(modules).some(Boolean);
    const transfer = byId.get("terminal-tabs")?.settings[uiTransferKey];
    if (transfer) {
      if (transfer.version !== 1) throw new Error("UI 호환 백업 버전을 확인하세요.");
      const remembered = uiTransferSchema.parse(transfer.values);
      const changed = Object.entries(modules).some(([key, value]) => value !== remembered.projection[key as keyof typeof remembered.projection]);
      if (!changed) { Object.assign(modules, remembered.modules); enabled = remembered.enabled; }
      else if (remembered.enabled) enabled = true;
    }
    ui = await packPlugin(home, "terminal-tabs", path.join(suite.release, "plugins/ui"), enabled);
    if (!ui) throw new Error("Suite UI 배포본이 없습니다.");
    ui = { ...ui, settings: { ...byId.get("terminal-tabs")?.settings, "paseo-ui": { version: 1, values: { modules } },
      ...(byId.get("sidebar-title-sync")?.settings["sidebar-title-sync"] ? { "sidebar-title-sync": byId.get("sidebar-title-sync")!.settings["sidebar-title-sync"] } : {}),
    } };
    result.push(ui);
  }
  if (windows && ui) {
    const replacement = { ...ui, settings: { ...ui.settings, [nativeStateKey]: { version: 1, values: { enabled: windows.enabled } } } };
    result[result.indexOf(ui)] = replacement;
  }
  if (legacyAster && oldAster) {
    const aster = await packPlugin(home, "aster", path.join(suite.release, "plugins/aster"), oldAster.enabled);
    if (!aster) throw new Error("Suite Aster 배포본이 없습니다.");
    result.push({ ...aster, settings: oldAster.settings });
  }
  return result;
}
