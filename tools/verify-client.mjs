import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, "..");
const project = path.resolve(process.argv[2]);
const baseline = JSON.parse(
  await fs.readFile(path.resolve(process.argv[3], "client-state.json"), "utf8"),
);
const session = JSON.parse(
  await fs.readFile(
    path.join(
      project,
      "sidebar-title-sync/deployment/normal-client-session.json",
    ),
    "utf8",
  ),
);
const require = createRequire(path.join(root, "../paseo-core/package.json"));
const { chromium } = require("playwright");
const browser = await chromium.connectOverCDP(
  `http://127.0.0.1:${session.port}`,
);
try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => page.url().startsWith("paseo://app"));
  await page.waitForFunction(
    () =>
      Boolean(
        globalThis.__PASEO_GLOBAL_TABS__ &&
          globalThis.__PASEO_GLOBAL_TABS_MODULES__,
      ),
    undefined,
    { timeout: 90000 },
  );
  const result = await page.evaluate(
    async ({ baseline, serverId }) => {
      const ids = globalThis.__PASEO_GLOBAL_TABS_MODULES__;
      const require = globalThis.__r;
      const registry = require(ids.registry).pluginRegistry;
      const installed = registry
        .getSnapshot()
        .filter((plugin) => plugin.serverId === serverId);
      const client = require(ids.sessions).useSessionStore.getState().sessions[
        serverId
      ].client;
      const plugins = await client.listPlugins();
      const modules = await client.invokePluginRpc(
        "terminal-tabs",
        "settings.paseo-ui.read",
        {},
      );
      const layout = require(ids.layouts).useWorkspaceLayoutStore;
      let sequence = 0;
      const closedTabs = Object.fromEntries(
        Object.entries(baseline.closedTabs).map(([key, entries]) => [
          key,
          entries.map((entry) => {
            sequence = Math.max(sequence, entry.sequence ?? 0);
            return {
              ...entry,
              ...(entry.globalEntry
                ? { origin: "global-workspace-tabs", position: entry.index }
                : {}),
            };
          }),
        ]),
      );
      layout.setState({
        closedTabsByWorkspace: closedTabs,
        closedTabSequence: sequence,
      });
      const changedStorage = Object.keys(baseline.storage).filter(
        (key) => localStorage.getItem(key) !== baseline.storage[key],
      );
      return {
        route: location.pathname,
        tabs: globalThis.__PASEO_GLOBAL_TABS__.model.entries(),
        plugins: plugins.map(({ id, status, error }) => ({
          id,
          status,
          error,
        })),
        clientPlugins: installed.map((plugin) => ({
          id: plugin.id,
          legacyIds: plugin.legacyIds,
          screens: plugin.surfaces.map((screen) => screen.id),
        })),
        evaluationErrors: ["terminal-tabs", "aster", "settings-sync"].map(
          (id) => registry.getEvaluationError(serverId, id) ?? null,
        ),
        modules,
        changedStorage,
        changedDrafts: changedStorage.filter((key) => /draft/i.test(key)),
        closedTabs: Object.values(
          layout.getState().closedTabsByWorkspace,
        ).reduce((sum, entries) => sum + entries.length, 0),
        hasHistory: Boolean(ids.reopen),
        revision: globalThis.__PASEO_GLOBAL_TABS_LEASE__?.revision,
        unpreservedInputs: baseline.inputs.filter((input) => input.value)
          .length,
        tabLabels: [
          ...document.querySelectorAll('[data-testid^="workspace-tab-"]'),
        ].filter((tab) => tab.getBoundingClientRect().width).length,
      };
    },
    {
      baseline,
      serverId: process.argv[4] ?? baseline.path.match(/^\/h\/([^/]+)/)?.[1],
    },
  );
  await fs.writeFile(
    path.join(root, ".local/client-verification.json"),
    JSON.stringify(result, null, 2),
  );
  assert.equal(result.route, baseline.path);
  assert.deepEqual(
    result.tabs.map((tab) => tab.key),
    baseline.tabs.map((tab) => tab.key),
  );
  assert.equal(result.unpreservedInputs, 0);
  assert.deepEqual(result.changedDrafts, []);
  assert.deepEqual(result.evaluationErrors, [null, null, null]);
  for (const id of ["terminal-tabs", "aster", "settings-sync"]) {
    assert.equal(
      result.plugins.find((plugin) => plugin.id === id)?.status,
      "running",
    );
    assert.ok(result.clientPlugins.some((plugin) => plugin.id === id));
  }
  assert.equal(
    result.clientPlugins.find((plugin) => plugin.id === "terminal-tabs")
      .legacyIds.length,
    4,
  );
  assert.ok(result.hasHistory);
  assert.equal(result.modules.status, "ready");
  console.log(
    JSON.stringify({
      passed: true,
      tabs: result.tabs.length,
      routePreserved: true,
      draftsPreserved: true,
      closedTabs: result.closedTabs,
      plugins: result.plugins,
      evaluationErrors: result.evaluationErrors,
      changedStorageKeys: result.changedStorage,
      globalTabHistory: result.hasHistory,
    }),
  );
} finally {
  await browser.close();
}
