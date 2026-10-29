import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const root = path.resolve(process.argv[2]);
const installedSync = path.resolve(process.argv[3]);
const suite = path.resolve(import.meta.dirname, "..");
const sources = [
  ["ui/modules/terminal", root, "terminal-tabs"],
  [
    "ui/modules/tabs",
    path.resolve(root, "../global-tabs"),
    "global-workspace-tabs",
  ],
  [
    "ui/modules/titles",
    path.join(root, "sidebar-title-sync"),
    "sidebar-title-sync",
  ],
  ["ui/modules/hosts", path.join(root, "host-order"), "host-order"],
  [
    "ui/modules/import",
    path.resolve(root, "../session-import"),
    "session-import",
  ],
  ["aster", path.resolve(root, "../aster"), "aster"],
  ["settings-sync", installedSync, "settings-sync"],
];
const provenance = [];
const hash = (value) => createHash("sha256").update(value).digest("hex");
for (const [destination, source, id] of sources) {
  const target = path.join(suite, "plugins", destination);
  const pkg = JSON.parse(
    await fs.readFile(path.join(source, "package.json"), "utf8"),
  );
  const entries = new Set([
    ...(pkg.files ?? []),
    "package.json",
    "tsconfig.json",
    "tests",
    "scripts",
  ]);
  if (id === "global-workspace-tabs") {
    for (const entry of [
      "index.client.ts",
      "client.js",
      "model.js",
      "metadata.js",
      "module-maps.json",
      "build-plugin.cjs",
      "tests.cjs",
      "metadata.test.cjs",
      "compatibility.test.cjs",
    ])
      entries.add(entry);
  }
  const files = [];
  async function copy(relative) {
    const file = path.join(source, relative);
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink())
      throw new Error(`Unexpected link: ${id}/${relative}`);
    if (stat.isDirectory()) {
      for (const child of await fs.readdir(file)) {
        if (
          [
            "node_modules",
            ".git",
            ".agent",
            ".check",
            "deployment",
            "host",
            "evidence",
            ".preview",
            ".preview-dist",
            "dist",
            "assets",
          ].includes(child)
        )
          continue;
        await copy(path.join(relative, child));
      }
    } else {
      if (!/\.(?:[cm]?jsx?|tsx?|json|svg|png|ico|md|ps1|sh)$/.test(relative))
        return;
      if (/HANDOFF|OVERVIEW|\.log$/.test(relative)) return;
      await fs.mkdir(path.dirname(path.join(target, relative)), {
        recursive: true,
      });
      const body = await fs.readFile(file);
      await fs.writeFile(path.join(target, relative), body);
      files.push({ path: relative.replaceAll("\\", "/"), sha256: hash(body) });
    }
  }
  for (const entry of entries) await copy(entry.replace(/\/$/, ""));
  // Release directories contain the authoritative runtime, while the development
  // directory supplies tests and build tooling. Never overwrite runtime sources.
  if (id === "settings-sync") {
    const development = path.join(root, "settings-sync");
    for (const relative of ["tests", "scripts", "tsconfig.json"]) {
      try {
        await fs.cp(
          path.join(development, relative),
          path.join(target, relative),
          { recursive: true, force: false, errorOnExist: true },
        );
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ERR_FS_CP_EEXIST")
          throw error;
      }
    }
  }
  provenance.push({
    id,
    version: pkg.version,
    destination: `plugins/${destination}`,
    files,
  });
}
await fs.writeFile(
  path.join(suite, "source-baseline.json"),
  JSON.stringify({ schemaVersion: 1, sources: provenance }, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    provenance.map(({ id, version, files }) => ({
      id,
      version,
      files: files.length,
    })),
  ),
);
