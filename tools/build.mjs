import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { isBuiltin } from "node:module";
import { buildUsageModules } from "./build-usage-modules.mjs";

const root = path.resolve(import.meta.dirname, "..");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7);
if (only && !["ui", "aster", "settings-sync"].includes(only))
  throw Error("Unknown plugin build target");
const output = path.resolve(
  root,
  process.argv.find((arg) => arg.startsWith("--out="))?.slice(6) ?? "dist",
);
const core = path.resolve(
  process.argv.find((arg) => arg.startsWith("--core="))?.slice(7) ??
    path.join(root, "../paseo-core"),
);
if (!only || only === "settings-sync")
  await import("../plugins/settings-sync/scripts/build.mjs");
const appDist = path.join(core, "packages/app/dist");
const hasApp = await fs
  .stat(path.join(appDist, "index.html"))
  .catch(() => null);
if ((!only || only === "ui") && hasApp) await buildUsageModules(appDist);
if (!only || only === "ui")
  execFileSync(
    process.execPath,
    [
      "plugins/ui/modules/tabs/build-plugin.cjs",
      ...(hasApp ? [] : ["--existing-maps"]),
    ],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, ...(hasApp ? { PASEO_APP_DIST: appDist } : {}) },
    },
  );
const hash = (value) => createHash("sha256").update(value).digest("hex");
const plugins = [];
const compatibility = [];
const legacyIds = [
  "terminal-tabs",
  "global-workspace-tabs",
  "host-order",
  "sidebar-title-sync",
  "session-import",
  "aster",
  "claude-windows-usage",
];
const packageSources = [
  ...["ui", "aster", "settings-sync"].map((name) => ({
    name,
    source: `plugins/${name}`,
    prefix: "plugins",
    legacy: false,
  })),
  ...legacyIds.map((name) => ({
    name,
    source: `compatibility/legacy/${name}`,
    prefix: "compatibility/plugins",
    legacy: true,
  })),
];
const apache = await fs.readFile(path.join(core, "LICENSE"), "utf8");
async function licenseBanner(inputs) {
  const notices = [
    "Copyright (c) 2025-present Mohamed Boudra. Bundled Paseo components.\n" +
      apache,
  ];
  const seen = new Set([hash(apache)]);
  const packages = new Set();
  for (const input of Object.keys(inputs)) {
    if (!input.includes("node_modules")) continue;
    let directory = path.dirname(path.resolve(root, input));
    while (directory.includes(`${path.sep}node_modules${path.sep}`)) {
      const pkg = await fs
        .readFile(path.join(directory, "package.json"), "utf8")
        .then(JSON.parse)
        .catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      if (pkg?.name) {
        if (!packages.has(directory)) {
          packages.add(directory);
          for (const name of [
            "LICENSE",
            "LICENSE.md",
            "LICENSE.txt",
            "license",
            "license.md",
          ]) {
            const text = await fs
              .readFile(path.join(directory, name), "utf8")
              .catch((error) => {
                if (error.code === "ENOENT") return null;
                throw error;
              });
            if (!text) continue;
            if (!seen.has(hash(text))) {
              seen.add(hash(text));
              notices.push(`${pkg.name} ${pkg.version}\n${text}`);
            }
            break;
          }
        }
        break;
      }
      directory = path.dirname(directory);
    }
  }
  return `/*!\n${notices.join("\n\n").replaceAll("*/", "* /")}\n*/\n`;
}
await fs.mkdir(output, { recursive: true });
for (const item of packageSources.filter(
  (item) => !only || (!item.legacy && item.name === only),
)) {
  const { name } = item;
  const source = path.join(root, item.source);
  const destination = path.join(output, item.prefix, name);
  await fs.mkdir(destination, { recursive: true });
  const manifest = JSON.parse(
    await fs.readFile(path.join(source, "paseo-plugin.json"), "utf8"),
  );
  const pkg = JSON.parse(
    await fs.readFile(path.join(source, "package.json"), "utf8"),
  );
  const files = [];
  const put = async (relative, body) => {
    if (
      /C:(?:\\+|\/)Users(?:\\+|\/)ckdgh/i.test(body.toString()) ||
      /\b(?:gh[opusr]_|github_pat_|sk-ant-|sk-proj-)[A-Za-z0-9_-]{24,}\b/.test(
        body.toString(),
      )
    )
      throw new Error(`Development path in release: ${name}/${relative}`);
    await fs.mkdir(path.dirname(path.join(destination, relative)), {
      recursive: true,
    });
    await fs.writeFile(path.join(destination, relative), body);
    files.push({ path: relative, sha256: hash(body) });
  };
  for (const runtime of ["client", "server"]) {
    const entry = await Promise.all(
      ["ts", "tsx"].map(async (ext) => {
        const file = path.join(source, `index.${runtime}.${ext}`);
        return (await fs.stat(file).catch(() => null)) ? file : null;
      }),
    ).then((entries) => entries.find(Boolean));
    if (!entry) continue;
    const result = await build({
      absWorkingDir: root,
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: runtime === "client" ? "browser" : "node",
      format: "esm",
      target: "es2022",
      external: [
        "@getpaseo/plugin",
        "@getpaseo/plugin/*",
        "zod",
        ...(runtime === "client" ? ["react", "react/*", "react-native"] : []),
      ],
      metafile: true,
      legalComments: "inline",
      minify: true,
      plugins: [
        {
          name: "node-prefix",
          setup(builder) {
            builder.onResolve({ filter: /^[^./]/ }, (args) =>
              isBuiltin(args.path)
                ? {
                    path: args.path.startsWith("node:")
                      ? args.path
                      : `node:${args.path}`,
                    external: true,
                  }
                : null,
            );
          },
        },
      ],
    });
    for (const bundle of Object.values(result.metafile.outputs)) {
      for (const item of bundle.imports) {
        if (
          item.external &&
          !item.path.startsWith("node:") &&
          !/^(?:@getpaseo\/plugin(?:\/|$)|zod$|react(?:\/|$)|react-native$)/.test(
            item.path,
          )
        )
          throw new Error(`Unbundled dependency: ${item.path}`);
      }
    }
    await put(
      `${runtime}/index.js`,
      (await licenseBanner(result.metafile.inputs)) +
        result.outputFiles[0].text,
    );
    await put(
      `index.${runtime}.ts`,
      `export { default } from "./${runtime}/index.js";\n`,
    );
  }
  await put("paseo-plugin.json", JSON.stringify(manifest, null, 2) + "\n");
  for (const asset of pkg.paseoRuntimeAssets ?? []) {
    if (
      path.isAbsolute(asset) ||
      asset.split(/[\\/]/).some((part) => part === "..")
    )
      throw Error("Invalid runtime asset path");
    await put(asset, await fs.readFile(path.join(source, asset)));
  }
  await put(
    "package.json",
    JSON.stringify(
      { name: pkg.name, version: pkg.version, private: true, type: "module" },
      null,
      2,
    ) + "\n",
  );
  // Icon paths are relative to the plugin root at runtime.
  for (const icon of new Set([
    "icon.svg",
    "icon.png",
    ...(manifest.media ?? []),
  ])) {
    if (
      path.isAbsolute(icon) ||
      icon.split(/[\\/]/).some((part) => part === "..")
    )
      throw Error("Invalid plugin asset path");
    const body = await fs.readFile(path.join(source, icon)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (body) await put(icon, body);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  (item.legacy ? compatibility : plugins).push({
    id: manifest.id,
    name,
    version: pkg.version,
    files,
  });
}
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: core,
  encoding: "utf8",
  windowsHide: true,
}).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], {
  cwd: core,
  encoding: "utf8",
  windowsHide: true,
}).trim();
const lock = {
  schemaVersion: 1,
  suiteVersion: "1.0.6",
  core: {
    repository: "https://github.com/LCH-1/paseo",
    revision,
    dirty: Boolean(dirty),
    protocolVersion: "0.12.0",
  },
  plugins,
  compatibility,
};
lock.treeHash = hash(JSON.stringify(lock));
await fs.writeFile(
  path.join(output, "suite-lock.json"),
  JSON.stringify(lock, null, 2) + "\n",
);
const bootstrap = await build({
  absWorkingDir: root,
  entryPoints: ["tools/bootstrap.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "inline",
});
await fs.writeFile(
  path.join(output, "bootstrap.mjs"),
  bootstrap.outputFiles[0].contents,
);
await fs.writeFile(
  path.join(output, "bundled-setup.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      entrypoint: "suite/bootstrap.mjs",
      sha256: hash(bootstrap.outputFiles[0].contents),
      daemonVersion: lock.core.protocolVersion,
      updateFeed: { owner: "LCH-1", repo: "paseo-suite", private: true },
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    treeHash: lock.treeHash,
    core: revision,
    dirty: Boolean(dirty),
    plugins: plugins.map(({ id, version, files }) => ({
      id,
      version,
      files: files.length,
    })),
  }),
);
