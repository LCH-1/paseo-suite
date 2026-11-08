import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

type Client = Pick<
  DaemonClient,
  | "createAgent"
  | "deleteAgent"
  | "archiveWorkspace"
  | "fetchWorkspaces"
  | "listProjects"
  | "removeProject"
>;
type Agent = Awaited<ReturnType<Client["createAgent"]>>;

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

/** Keeps live test sessions from leaving empty workspaces or projects behind. */
export async function withLiveTestSession<T>(
  client: Client,
  input: Parameters<Client["createAgent"]>[0],
  run: (agent: Agent) => Promise<T>,
): Promise<T> {
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
    if (agentId || workspaceId) {
      const errors: unknown[] = [];
      const cleanup = async (action: () => Promise<unknown>) => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };
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
      if (errors.length)
        throw new AggregateError(
          failure ? [failure, ...errors] : errors,
          `Live test cleanup failed: agent=${agentId ?? "not-created"}, workspace=${workspaceId ?? "not-created"}`,
        );
    }
  }
}
