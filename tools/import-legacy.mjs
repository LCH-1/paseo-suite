import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const root = path.resolve(import.meta.dirname, "..");
const project = path.resolve(process.argv[2]);
const sources = [
  ["terminal-tabs", project],
  ["global-workspace-tabs", path.resolve(project, "../global-tabs")],
  ["host-order", path.join(project, "host-order")],
  ["sidebar-title-sync", path.join(project, "sidebar-title-sync")],
  ["session-import", path.resolve(project, "../session-import")],
  ["aster", path.resolve(project, "../aster")],
  ["claude-windows-usage", path.resolve(project, "../claude-windows-usage")],
];
const baseline = [];
for (const [id, source] of sources) {
  const target = path.join(root, "compatibility/legacy", id);
  const manifest = JSON.parse(
    await fs.readFile(path.join(source, "paseo-plugin.json"), "utf8"),
  );
  const pkg = await fs
    .readFile(path.join(source, "package.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT")
        return { name: id, version: "0.12.0", private: true, type: "module" };
      throw error;
    });
  const entries = [
    "paseo-plugin.json",
    "index.client.ts",
    "index.client.tsx",
    "index.server.ts",
    "client",
    "server",
    "shared",
    "icon.svg",
    ...(manifest.media ?? []),
  ];
  const files = [];
  async function copy(relative) {
    const file = path.join(source, relative);
    const stat = await fs.lstat(file).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return;
    if (stat.isSymbolicLink())
      throw new Error("Legacy sources must be regular files");
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(file))
        if (
          !name.startsWith(".") &&
          !["node_modules", "tests", "deployment", "host", "evidence"].includes(
            name,
          )
        )
          await copy(path.join(relative, name));
    } else {
      if (
        /\.test\.|check-bundle|setup\.ts|status\.ts/.test(relative) ||
        !/\.(?:tsx?|[cm]?js|json|svg|png)$/.test(relative)
      )
        return;
      const body = await fs.readFile(file);
      await fs.mkdir(path.dirname(path.join(target, relative)), {
        recursive: true,
      });
      await fs.writeFile(path.join(target, relative), body);
      files.push({
        path: relative.replaceAll("\\", "/"),
        sha256: createHash("sha256").update(body).digest("hex"),
      });
    }
  }
  for (const entry of entries) await copy(entry);
  await fs.writeFile(
    path.join(target, "package.json"),
    JSON.stringify(
      { name: pkg.name, version: pkg.version, private: true, type: "module" },
      null,
      2,
    ) + "\n",
  );
  baseline.push({ id, version: pkg.version, files });
}
await fs.writeFile(
  path.join(root, "compatibility/baseline.json"),
  JSON.stringify(baseline, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    baseline.map(({ id, version, files }) => ({
      id,
      version,
      files: files.length,
    })),
  ),
);
