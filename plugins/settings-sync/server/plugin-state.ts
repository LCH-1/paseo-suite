import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PluginBackup } from "../shared/model";

const asterStateKey = "paseo-nest.aster-settings.v1";
export const nativeStateKey = "paseo-suite.windows-usage.v1";
const nativeSchema = z.object({ enabled: z.boolean() }).strict();
const capacities = z.record(z.string().min(1).max(200), z.number().finite().positive()).refine(value => Object.keys(value).length <= 200);
const stateSchema = z.object({ capacities }).strict();

async function asterSettings(home: string) {
  const directory = path.join(home, "aster"), file = path.join(directory, "settings.json");
  for (const entry of [directory, file]) {
    const stat = await lstat(entry).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!stat) return { file, raw: null, values: z.record(z.string(), z.json()).parse({}) };
    if (stat.isSymbolicLink() || (entry === directory ? !stat.isDirectory() : !stat.isFile() || stat.size > 65_536)) throw new Error("Aster 설정 경로나 크기를 확인하세요. 연결된 파일은 동기화하지 않습니다.");
  }
  const raw = await readFile(file, "utf8");
  const values = z.record(z.string(), z.json()).parse(JSON.parse(raw));
  return { file, raw, values };
}

export async function capturePluginState(home: string, id: string, settings: PluginBackup["settings"]): Promise<PluginBackup["settings"]> {
  if (id === "terminal-tabs") {
    const file = path.join(home, "plugin-settings/claude-windows-usage/native.json");
    let enabled: boolean;
    try { enabled = nativeSchema.parse(JSON.parse(await readFile(file, "utf8")).values).enabled; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      let config;
      try { config = JSON.parse(await readFile(path.join(home, "config.json"), "utf8")); }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ENOENT") return settings; throw failure; }
      const legacy = config.plugins?.["claude-windows-usage"];
      const suite = await lstat(path.join(home, "suite/installed.json")).catch((failure: NodeJS.ErrnoException) => { if (failure.code === "ENOENT") return null; throw failure; });
      if (!legacy && !suite) return settings;
      enabled = legacy ? config.pluginsEnabled === true && legacy.enabled !== false : true;
    }
    return { ...settings, [nativeStateKey]: { version: 1, values: { enabled } } };
  }
  if (id !== "aster") return settings;
  const next = { ...settings };
  delete next[asterStateKey];
  const current = await asterSettings(home);
  if (current.raw !== null) next[asterStateKey] = { version: 1, values: stateSchema.parse({ capacities: current.values.capacities ?? {} }) };
  return next;
}

export async function preparePluginState(home: string, plugin: PluginBackup) {
  if (plugin.id === "terminal-tabs" && plugin.settings[nativeStateKey]) {
    const incoming = plugin.settings[nativeStateKey];
    if (incoming.version !== 1) throw new Error("Windows 사용량 설정 백업 버전을 지원하지 않습니다.");
    const values = nativeSchema.parse(incoming.values);
    const file = path.join(home, "plugin-settings/claude-windows-usage/native.json");
    let previous: string | null;
    try { previous = await readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; previous = null; }
    const raw = JSON.stringify({ version: 1, values });
    return previous === raw ? null : { file, previous, raw };
  }
  if (plugin.id !== "aster" || !plugin.settings[asterStateKey]) return null;
  const incoming = plugin.settings[asterStateKey];
  if (incoming.version !== 1) throw new Error("Aster 설정 백업 버전을 지원하지 않습니다.");
  const values = stateSchema.parse(incoming.values), current = await asterSettings(home);
  if (current.raw !== null && JSON.stringify(current.values.capacities ?? {}) === JSON.stringify(values.capacities)) return null;
  return { file: current.file, previous: current.raw, raw: JSON.stringify({ ...current.values, capacities: values.capacities }) };
}
