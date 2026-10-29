import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const project = path.resolve(process.argv[2]);
const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "../paseo-core/package.json"));
const { chromium } = require("playwright");
const session = JSON.parse(
  await fs.readFile(
    path.join(
      project,
      "sidebar-title-sync/deployment/normal-client-session.json",
    ),
    "utf8",
  ),
);
const browser = await chromium.connectOverCDP(
  `http://127.0.0.1:${session.port}`,
);
try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((entry) => entry.url().startsWith("paseo://app"));
  const inventory = await page.evaluate(async () => {
    const sessions = globalThis
      .__r(globalThis.__PASEO_GLOBAL_TABS_MODULES__.sessions)
      .useSessionStore.getState().sessions;
    const client = sessions.srv_IVIF3P9ChzEO.client;
    const projectId = "prj_63dbf729c700bca3";
    const [workspaces, agents, plugins] = await Promise.all([
      client.fetchWorkspaces({ filter: { projectId }, page: { limit: 200 } }),
      client.fetchAgents({ filter: { projectId }, page: { limit: 200 } }),
      client.listPlugins(),
    ]);
    const workspaceIds = new Set(
      workspaces.entries.map((entry) => (entry.workspace ?? entry).id),
    );
    return {
      projectId,
      workspaces: workspaces.entries,
      agents: agents.entries
        .map((entry) => entry.agent ?? entry)
        .filter((agent) => workspaceIds.has(agent.workspaceId))
        .map((agent) => {
          return {
            id: agent.id,
            workspaceId: agent.workspaceId,
            status: agent.status,
            hasActiveTurn: Boolean(agent.activeTurn),
            pendingPermissions: agent.pendingPermissions?.length,
          };
        }),
      plugins: plugins.map((plugin) => ({
        id: plugin.id,
        path: plugin.path,
        enabled: plugin.enabled,
        status: plugin.status,
        source: plugin.installation?.identity?.kind,
      })),
      route: location.pathname,
      tabs: globalThis.__PASEO_GLOBAL_TABS__.model
        .entries()
        .map(({ serverId, workspaceId, agentId }) => ({
          serverId,
          workspaceId,
          agentId,
        })),
    };
  });
  await fs.mkdir(path.join(root, ".local"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".local/live-inventory.json"),
    JSON.stringify(inventory, null, 2),
  );
  console.log(
    JSON.stringify({
      workspaces: inventory.workspaces.map(({ id, name, status }) => ({
        id,
        name,
        status,
      })),
      agents: inventory.agents,
      plugins: inventory.plugins.map(({ id, enabled, status }) => ({
        id,
        enabled,
        status,
      })),
      tabs: inventory.tabs.length,
      route: inventory.route,
    }),
  );
} finally {
  await browser.close();
}
