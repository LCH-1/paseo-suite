import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import path from "node:path";

type Client = Pick<
  DaemonClient,
  | "createAgent"
  | "deleteAgent"
  | "archiveWorkspace"
  | "fetchWorkspaces"
  | "fetchAgents"
  | "listProjects"
  | "removeProject"
>;
type Agent = Awaited<ReturnType<Client["createAgent"]>>;

function absoluteProjectRoot(value: string | undefined) {
  if (!value) return undefined;
  if (/^[a-z]:[\\/]|^\\\\/i.test(value))
    return path.win32
      .normalize(value)
      .replaceAll("\\", "/")
      .toLowerCase()
      .replace(/\/$/, "");
  if (value.startsWith("/"))
    return path.posix.normalize(value).replace(/\/$/, "");
  return undefined;
}

async function listWorkspaces(client: Client) {
  const entries: Awaited<ReturnType<Client["fetchWorkspaces"]>>["entries"] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await client.fetchWorkspaces({
      includeBackground: true,
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    entries.push(...page.entries);
    if (!page.pageInfo.hasMore) return entries;
    const next = page.pageInfo.nextCursor;
    if (!next || cursors.has(next))
      throw new Error(
        "Cannot establish live test ownership: incomplete workspace pagination",
      );
    cursors.add(next);
    cursor = next;
  }
}

/**
 * Keeps live test sessions from leaving empty workspaces or projects behind.
 * Pass ownedDirectory only for a directory created exclusively for this test;
 * it permits recovery when creation fails before reporting resource IDs.
 */
export async function withLiveTestSession<T>(
  client: Client,
  input: Parameters<Client["createAgent"]>[0],
  run: (agent: Agent) => Promise<T>,
  ownership?: { ownedDirectory: string },
): Promise<T> {
  const requestedRoot = absoluteProjectRoot(input.cwd ?? input.config?.cwd);
  if (
    ownership &&
    (!requestedRoot ||
      absoluteProjectRoot(ownership.ownedDirectory) !== requestedRoot)
  )
    throw new Error(
      "Owned test directory must match the absolute creation root",
    );
  const existingWorkspaces = new Set(
    (await listWorkspaces(client)).map((w) => w.id),
  );
  // A caller-supplied workspace is never owned by this temporary session.
  if (input.workspaceId) existingWorkspaces.add(input.workspaceId);
  const existingProjects = new Set(
    (await client.listProjects()).projects.map((p) => p.projectId),
  );
  let agent: Agent | undefined;
  let observedAgentId: string | undefined;
  let observedWorkspace:
    | Awaited<ReturnType<typeof listWorkspaces>>[number]
    | undefined;
  let failure: unknown;
  try {
    agent = await client.createAgent({
      ...input,
      onEvent: (snapshot) => {
        if (snapshot.agent) observedAgentId = snapshot.agent.id;
        if (snapshot.workspace) observedWorkspace = snapshot.workspace;
        input.onEvent?.(snapshot);
      },
    });
    return await run(agent);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const agentId = agent?.id ?? observedAgentId;
    const workspaceId = agent?.workspaceId ?? observedWorkspace?.id;
    const errors: unknown[] = [];
    const cleanup = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    };
    if (agentId || workspaceId) {
      if (agentId) await cleanup(() => client.deleteAgent(agentId));
      if (workspaceId && !existingWorkspaces.has(workspaceId)) {
        let owned:
          | Awaited<ReturnType<typeof listWorkspaces>>[number]
          | undefined;
        if (observedWorkspace?.id === workspaceId) owned = observedWorkspace;
        else
          await cleanup(async () => {
            owned = (await listWorkspaces(client)).find(
              (w) => w.id === workspaceId,
            );
          });
        await cleanup(async () => {
          const result = await client.archiveWorkspace(workspaceId);
          if (result.error)
            throw new Error(`Test workspace ${workspaceId}: ${result.error}`);
        });
        const projectId = owned?.projectId;
        if (projectId && !existingProjects.has(projectId)) {
          await cleanup(async () => {
            const remaining = await listWorkspaces(client);
            if (!remaining.some((w) => w.projectId === projectId))
              await client.removeProject(projectId);
          });
        }
      }
    }
    // Admission can register a project, then reject before emitting a creation snapshot.
    if (
      failure &&
      !agentId &&
      !workspaceId &&
      !input.workspaceId &&
      requestedRoot
    ) {
      await cleanup(async () => {
        const candidates = (await client.listProjects()).projects.filter(
          (project) =>
            !existingProjects.has(project.projectId) &&
            absoluteProjectRoot(project.projectRootPath) === requestedRoot,
        );
        if (candidates.length > 1)
          throw new Error("Ambiguous live test project ownership");
        const owned = candidates[0];
        if (!owned) return;
        const attached = (await listWorkspaces(client)).filter(
          (w) => w.projectId === owned.projectId,
        );
        if (attached.length && !ownership) return;
        if (
          attached.some(
            (w) =>
              existingWorkspaces.has(w.id) ||
              absoluteProjectRoot(w.workspaceDirectory ?? w.projectRootPath) !==
                requestedRoot,
          )
        )
          throw new Error("Unconfirmed workspace in owned test project");
        if (attached.length) {
          // Only an explicitly exclusive test directory authorizes recovery without snapshots.
          const workspaceIds = new Set(attached.map((w) => w.id));
          const agentIds = new Set<string>();
          const cursors = new Set<string>();
          let cursor: string | undefined;
          for (;;) {
            const page = await client.fetchAgents({
              filter: { includeArchived: true, includeBackground: true },
              page: { limit: 200, ...(cursor ? { cursor } : {}) },
            });
            for (const { agent } of page.entries)
              if (agent.workspaceId && workspaceIds.has(agent.workspaceId))
                agentIds.add(agent.id);
            if (!page.pageInfo.hasMore) break;
            const next = page.pageInfo.nextCursor;
            if (!next || cursors.has(next))
              throw new Error("Incomplete owned test agent pagination");
            cursors.add(next);
            cursor = next;
          }
          for (const id of agentIds) await client.deleteAgent(id);
          for (const workspace of attached) {
            const result = await client.archiveWorkspace(workspace.id);
            if (result.error)
              throw new Error(
                `Test workspace ${workspace.id}: ${result.error}`,
              );
          }
        }
        if (
          !(await listWorkspaces(client)).some(
            (w) => w.projectId === owned.projectId,
          )
        )
          await client.removeProject(owned.projectId);
      });
    }
    if (errors.length)
      throw new AggregateError(
        failure ? [failure, ...errors] : errors,
        `Live test cleanup failed: agent=${agentId ?? "not-created"}, workspace=${workspaceId ?? "not-created"}`,
      );
  }
}
