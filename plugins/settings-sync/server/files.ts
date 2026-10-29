import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ID, MAX_BYTES, pluginId, pluginSchema, settingsId, type PluginBackup } from "../shared/model";
import { portablePlugin } from "./plugin-compat";
import { capturePluginState } from "./plugin-state";

const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".woff", ".woff2", ".wasm"]);
const directories = new Set(["client", "server", "shared", "src", "lib", "dist", "assets"]);
const ignored = new Set(["node_modules", "tests", "test", "coverage", "docs", "settings-sync"]);
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function checkedRelative(relative: string) {
  const parts = relative.split("/");
  if (!relative || parts.some((part) => !part || part.startsWith(".") || /[\\:<>"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))) {
    throw new Error(`백업에 허용하지 않는 파일 경로가 있습니다: ${relative}`);
  }
  return parts;
}

export async function readOptional(file: string) {
  try { return await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function atomicWrite(file: string, raw: string | Buffer) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, raw, { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}

export async function readPluginSettings(home: string, id: string) {
  pluginId.parse(id);
  const root = path.join(home, "plugin-settings", id);
  const settings: PluginBackup["settings"] = {};
  let entries: Dirent[];
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = []; else throw error; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const name = entry.name.slice(0, -5);
    settingsId.parse(name);
    checkedRelative(entry.name);
    const raw = await readFile(path.join(root, entry.name), "utf8");
    if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error(`${id} 설정 크기 제한 초과`);
    settings[name] = z.object({ version: z.number().int().positive(), values: z.json() }).parse(JSON.parse(raw));
  }
  return capturePluginState(home, id, settings);
}

export async function packPlugin(home: string, id: string, directory: string, enabled: boolean): Promise<PluginBackup | null> {
  pluginId.parse(id);
  const manifest = z.object({ id: z.string() }).parse(JSON.parse(await readFile(path.join(directory, "paseo-plugin.json"), "utf8")));
  if (manifest.id === ID) return null;
  const files: Record<string, string> = {};
  let bytes = 0;
  async function walk(root: string, prefix = "") {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || ignored.has(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      checkedRelative(relative);
      if (entry.isSymbolicLink()) throw new Error(`${id}: 심볼릭 링크는 백업할 수 없습니다 (${relative}).`);
      if (entry.isDirectory()) {
        if (prefix || directories.has(entry.name)) await walk(path.join(root, entry.name), relative);
      } else if (entry.isFile() && extensions.has(path.extname(entry.name)) && !/lock\.json$/.test(entry.name)) {
        const stat = await lstat(path.join(root, entry.name));
        bytes += stat.size;
        if (bytes > MAX_BYTES || Object.keys(files).length >= 1500) throw new Error(`${id}: 플러그인 백업 크기 제한을 초과했습니다.`);
        files[relative] = (await readFile(path.join(root, entry.name))).toString("base64");
      }
    }
  }
  await walk(directory);
  return pluginSchema.parse(portablePlugin({ id, enabled, files, settings: await readPluginSettings(home, id) }));
}

export async function unpackPlugin(root: string, plugin: PluginBackup) {
  plugin = portablePlugin(plugin);
  pluginSchema.parse(plugin);
  if (plugin.id === ID) throw new Error("Settings Sync 자체는 복원 대상에서 제외됩니다.");
  if (!plugin.files["paseo-plugin.json"] || !Object.keys(plugin.files).some((name) => /^index\.(client|server)\.tsx?$/.test(name))) throw new Error(`${plugin.id}: 플러그인 진입 파일이 없습니다.`);
  const manifest = z.object({ id: z.string() }).parse(JSON.parse(Buffer.from(plugin.files["paseo-plugin.json"], "base64").toString("utf8")));
  if (manifest.id === ID) throw new Error("Settings Sync 자체는 복원 대상에서 제외됩니다.");
  let bytes = 0;
  const paths = new Set<string>();
  for (const [relative, encoded] of Object.entries(plugin.files)) {
    checkedRelative(relative);
    const normalized = relative.toLowerCase();
    if (paths.has(normalized)) throw new Error("대소문자만 다른 중복 파일 경로가 있습니다.");
    paths.add(normalized);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("플러그인 파일 인코딩이 올바르지 않습니다.");
    bytes += Buffer.byteLength(encoded, "base64");
  }
  if (bytes > MAX_BYTES) throw new Error("플러그인 파일 크기 제한을 초과했습니다.");
  const target = path.join(root, plugin.id);
  await mkdir(target, { recursive: false, mode: 0o700 });
  for (const [relative, encoded] of Object.entries(plugin.files)) {
    const file = path.join(target, ...checkedRelative(relative));
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, Buffer.from(encoded, "base64"), { flag: "wx", mode: 0o600 });
  }
  return target;
}
