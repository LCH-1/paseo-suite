import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const localPrograms = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs/Paseo");
const roots = process.argv.slice(2);
if (!roots.length) {
  roots.push("C:/Program Files/Paseo/resources/app-dist");
  if (localPrograms) {
    const entries = await readdir(localPrograms, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isDirectory()) roots.push(path.join(localPrograms, entry.name, "resources/app-dist"));
    }
  }
}
const maps = new Map();
for (const directory of roots) {
  let html;
  try { html = await readFile(path.join(directory, "index.html"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") continue; throw error; }
  const reference = html.match(/src="([^"\n]*\/index-[a-f0-9]+\.js)"/);
  if (!reference) throw new Error(`Paseo bundle missing: ${directory}`);
  const source = await readFile(path.join(directory, reference[1].replace(/^\//, "")), "utf8");
  const modules = source.split("\n");
  function moduleId(symbol) {
    const matches = modules.filter((line) => line.includes(`.${symbol}=`)
      || new RegExp(`Object\\.defineProperty\\([^,]+,["']${symbol}["'],`).test(line));
    if (matches.length !== 1) throw new Error(`Ambiguous export: ${symbol} (${directory})`);
    const id = matches[0].match(/},(\d+),\[[^\]]*\]\);?$/);
    if (!id) throw new Error(`Module ID missing: ${symbol}`);
    return Number(id[1]);
  }
  const bundle = path.basename(reference[1]);
  maps.set(bundle, { bundle, runtime: moduleId("getHostRuntimeStore"), ordering: moduleId("orderHostsLocalFirst"), desktop: moduleId("getDesktopDaemonStatus") });
}
if (!maps.size) throw new Error("No supported Paseo bundles found");
const mapsPath = path.join(root, "client/module-maps.ts");
const previous = await readFile(mapsPath, "utf8");
const previousMaps = JSON.parse(previous.replace(/^export default\s+/, "").replace(/;\s*$/, ""));
const mergedMaps = new Map(previousMaps.map((entry) => [entry.bundle, entry]));
for (const [bundle, entry] of maps) mergedMaps.set(bundle, entry);
await writeFile(mapsPath, `export default ${JSON.stringify([...mergedMaps.values()], null, 2)};\n`);
console.log(`Built module maps for ${mergedMaps.size} Paseo bundles`);
