import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

// This is a local recovery snapshot. It must never be included in a release.
const project = path.resolve(process.argv[2] ?? "../파세오");
const deployment = path.join(project, "sidebar-title-sync/deployment");
const session = JSON.parse(
  await fs.readFile(
    path.join(deployment, "normal-client-session.json"),
    "utf8",
  ),
);
const require = createRequire(
  path.join(project, "sidebar-title-sync/host/paseo/package.json"),
);
const { chromium } = require("playwright");
const output = path.join(
  os.homedir(),
  ".paseo-suite-backups",
  new Date().toISOString().replaceAll(":", "-"),
);
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const appDist = path.join(path.dirname(session.program), "resources/app-dist");
const html = await fs.readFile(path.join(appDist, "index.html"), "utf8");
const script = html.match(/src="([^"\n]*\/index-[a-f0-9]+\.js)"/)[1];
const bundle = await fs.readFile(
  path.join(appDist, script.replace(/^\//, "")),
  "utf8",
);
function moduleId(symbol) {
  const lines = bundle
    .split("\n")
    .filter(
      (line) =>
        line.includes(`.${symbol}=`) ||
        new RegExp(`Object\\.defineProperty\\([^,]+,["']${symbol}["'],`).test(
          line,
        ),
    );
  if (lines.length !== 1)
    throw new Error(`Cannot identify live state export: ${symbol}`);
  return Number(lines[0].match(/},(\d+),\[[^\]]*\]\);?$/)[1]);
}
const stateModules = {
  drafts: moduleId("flushDraftPersistStorage"),
  newWorkspace: moduleId("newWorkspaceTabsBridge"),
};
const browser = await chromium.connectOverCDP(
  `http://127.0.0.1:${session.port}`,
);
try {
  const pages = browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((page) => page.url().startsWith("paseo://app"));
  if (pages.length !== 1)
    throw new Error("Expected exactly one live Paseo page");
  const capture = () =>
    pages[0].evaluate(async (stateModules) => {
      await globalThis.__r(stateModules.drafts).flushDraftPersistStorage();
      const modules = globalThis.__PASEO_GLOBAL_TABS_MODULES__;
      const sessions = globalThis
        .__r(modules.sessions)
        .useSessionStore.getState().sessions;
      const hosts = [];
      for (const [serverId, entry] of Object.entries(sessions)) {
        if (!entry.client) continue;
        try {
          const plugins = await entry.client.listPlugins();
          hosts.push({ serverId, plugins });
        } catch {
          hosts.push({ serverId, unavailable: true });
        }
      }
      return {
        capturedAt: new Date().toISOString(),
        path: location.pathname,
        search: location.search,
        storage: Object.fromEntries(Object.entries(localStorage)),
        tabs: globalThis.__PASEO_GLOBAL_TABS__.model.entries(),
        newWorkspaceTabs: globalThis
          .__r(stateModules.newWorkspace)
          .newWorkspaceTabsBridge.getSnapshot(),
        closedTabs: globalThis
          .__r(modules.layouts)
          .useWorkspaceLayoutStore.getState().closedTabsByWorkspace,
        hosts,
        inputs: [...document.querySelectorAll("textarea,input")].map(
          (input) => ({
            testId: input.getAttribute("data-testid"),
            label: input.getAttribute("aria-label"),
            value: input.value,
            selectionStart: input.selectionStart,
            selectionEnd: input.selectionEnd,
          }),
        ),
      };
    }, stateModules);
  let live = await capture();
  await fs.writeFile(
    path.join(output, "client-state.json"),
    JSON.stringify(live),
    { mode: 0o600 },
  );
  const { installationManifest } = require(
    path.join(deployment, "installation-manifest.cjs"),
  );
  await fs.writeFile(
    path.join(output, "installation.json"),
    JSON.stringify(installationManifest(deployment), null, 2),
  );
  // Atomic JSON stores can be copied while the daemon stays alive. Include every
  // agent record; CLI histories remain at their original provider-owned paths.
  const home = path.join(os.homedir(), ".paseo");
  const records = [];
  const links = [];
  for (const name of [
    "config.json",
    "server-id",
    "daemon-keypair.json",
    "local-credential",
    "projects",
    "agents",
    "aster",
    "paseo-accounts",
    "plugin-settings",
    "settings-sync",
    "schedules",
    "creations",
  ]) {
    const source = path.join(home, name);
    try {
      await fs.cp(source, path.join(output, "paseo-home", name), {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: async (entry) => {
          if (!(await fs.lstat(entry)).isSymbolicLink()) return true;
          links.push({
            path: path.relative(home, entry),
            target: await fs.readlink(entry),
          });
          return false;
        },
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  for (const name of [
    "desktop-settings.json",
    "window-state.json",
    "Preferences",
    "Local State",
  ]) {
    try {
      await fs.cp(
        path.join(session.profile, name),
        path.join(output, "desktop", name),
        { recursive: true },
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  // Capture the final client state after the file copy, immediately before a
  // switch can begin. The profile itself remains at its existing path.
  live = await capture();
  await fs.writeFile(
    path.join(output, "client-state.json"),
    JSON.stringify(live),
    { mode: 0o600 },
  );
  async function walk(directory, relative = "") {
    for (const entry of await fs.readdir(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const child = path.join(relative, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Recovery snapshot must not contain symlinks");
      if (entry.isDirectory()) await walk(directory, child);
      else
        records.push({
          path: child.replaceAll("\\", "/"),
          sha256: hash(await fs.readFile(path.join(directory, child))),
        });
    }
  }
  await walk(output);
  await fs.writeFile(
    path.join(output, "snapshot-manifest.json"),
    JSON.stringify(
      { schemaVersion: 1, capturedAt: live.capturedAt, files: records, links },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      output,
      files: records.length,
      tabs: live.tabs.length,
      hosts: live.hosts.length,
      storageKeys: Object.keys(live.storage).length,
    }),
  );
} finally {
  await browser.close();
}
