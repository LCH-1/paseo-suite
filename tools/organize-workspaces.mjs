import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, "..");
const project = path.resolve(process.argv[2]);
const serverId = process.argv[3],
  projectId = process.argv[4];
const apply = process.argv.includes("--apply");
if (!serverId || !projectId)
  throw Error("Specify project directory, server ID and project ID");
const require = createRequire(path.join(root, "../paseo-core/package.json"));
const { chromium } = require("playwright");
const metadata = JSON.parse(
  await fs.readFile(
    path.join(
      project,
      "sidebar-title-sync/deployment/normal-client-session.json",
    ),
    "utf8",
  ),
);
const roles = [
  {
    key: "core",
    title: "01 · Paseo Core",
    directory: path.resolve(root, "../paseo-core"),
  },
  {
    key: "ui",
    title: "02 · Paseo UI",
    directory: path.join(root, "plugins/ui"),
  },
  {
    key: "aster",
    title: "03 · Aster",
    directory: path.join(root, "plugins/aster"),
  },
  {
    key: "sync",
    title: "04 · Settings Sync",
    directory: path.join(root, "plugins/settings-sync"),
  },
  { key: "release", title: "05 · 통합·배포", directory: root },
];
const legacyRoles = {
  채팅창: "core",
  클로드2개: "aster",
  호스트터미널접속관련: "core",
  사이드바: "core",
  플러그인전체: "release",
  "프로젝트 그룹핑": "core",
  "탭 수정": "ui",
  상단바: "core",
  셋팅싱크: "sync",
  "파세오 세션 전체 설정 추가": "core",
  터미널: "ui",
  코덱스에러재시작: "core",
  "호스트 오더링": "ui",
};
const browser = await chromium.connectOverCDP(
  `http://127.0.0.1:${metadata.port}`,
);
try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => page.url().startsWith("paseo://app"));
  const result = await page.evaluate(
    async ({ serverId, projectId, roles, legacyRoles, apply }) => {
      const client = globalThis
        .__r(globalThis.__PASEO_GLOBAL_TABS_MODULES__.sessions)
        .useSessionStore.getState().sessions[serverId].client;
      const workspaces = (
        await client.fetchWorkspaces({
          filter: { projectId, includeBackground: true },
          page: { limit: 200 },
        })
      ).entries.map((entry) => entry.workspace ?? entry);
      const canonical = [];
      for (const role of roles) {
        let workspace = workspaces.find(
          (item) =>
            !item.background &&
            (item.title === role.title || item.name === role.title),
        );
        if (!workspace && apply)
          workspace = (
            await client.createWorkspace({
              source: { kind: "directory", path: role.directory, projectId },
              title: role.title,
              background: false,
            })
          ).workspace;
        canonical.push({ ...role, id: workspace?.id ?? null });
        for (const empty of workspaces.filter(
          (item) => item.background && item.title === role.title,
        )) {
          const agents = (
            await client.fetchAgents({
              filter: { projectId, includeBackground: true },
              page: { limit: 200 },
            })
          ).entries
            .map((entry) => entry.agent ?? entry)
            .filter((agent) => agent.workspaceId === empty.id);
          if (apply && !agents.length) await client.archiveWorkspace(empty.id);
        }
      }
      const legacy = [];
      for (const workspace of workspaces) {
        const title = workspace.title ?? workspace.name;
        const original = title.startsWith("기록 · ")
          ? title.split(" · ").at(-1)
          : title;
        const role = legacyRoles[original];
        if (!role) continue;
        // Re-read running/open state directly before every archival decision.
        const agents = (
          await client.fetchAgents({
            filter: { projectId },
            page: { limit: 200 },
          })
        ).entries
          .map((entry) => entry.agent ?? entry)
          .filter((agent) => agent.workspaceId === workspace.id);
        const tabs = globalThis.__PASEO_GLOBAL_TABS__.model.entries();
        const current = location.pathname.includes(
          `/workspace/${workspace.id}`,
        );
        const open = tabs.some(
          (tab) =>
            tab.serverId === serverId && tab.workspaceId === workspace.id,
        );
        const busy = agents.some(
          (agent) =>
            !["idle", "done", "closed", "error"].includes(agent.status) ||
            agent.activeTurn ||
            agent.pendingPermissions?.length,
        );
        let archived = false;
        if (apply) {
          const label = roles
            .find((item) => item.key === role)
            .title.replace(/^\d+ · /, "");
          await client.setWorkspaceTitle(
            workspace.id,
            `기록 · ${label} · ${original}`,
          );
          if (!current && !open && !busy && workspace.status !== "archived") {
            await client.archiveWorkspace(workspace.id);
            archived = true;
          }
        }
        legacy.push({
          id: workspace.id,
          original,
          role,
          current,
          open,
          busy,
          archived,
        });
      }
      return {
        canonical,
        legacy,
        route: location.pathname,
        tabs: globalThis.__PASEO_GLOBAL_TABS__.model.entries().length,
      };
    },
    { serverId, projectId, roles, legacyRoles, apply },
  );
  await fs.mkdir(path.join(root, ".local"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".local/workspace-map.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
