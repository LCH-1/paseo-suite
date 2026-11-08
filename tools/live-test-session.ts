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

/** Keeps live test sessions from leaving empty workspaces or projects behind. */
export async function withLiveTestSession<T>(
  client: Client,
  input: Parameters<Client["createAgent"]>[0],
  run: (agent: Agent) => Promise<T>,
): Promise<T> {
  const existingWorkspaces = new Set(
    (
      await client.fetchWorkspaces({
        includeBackground: true,
        page: { limit: 200 },
      })
    ).entries.map((w) => w.id),
  );
  const existingProjects = new Set(
    (await client.listProjects()).projects.map((p) => p.projectId),
  );
  let agent: Agent | undefined;
  let failure: unknown;
  try {
    agent = await client.createAgent(input);
    return await run(agent);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (agent) {
      const errors: unknown[] = [];
      const cleanup = async (action: () => Promise<unknown>) => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };
      await cleanup(() => client.deleteAgent(agent!.id));
      const workspaceId = agent.workspaceId;
      if (workspaceId && !existingWorkspaces.has(workspaceId)) {
        const owned = (
          await client.fetchWorkspaces({
            includeBackground: true,
            page: { limit: 200 },
          })
        ).entries.find((w) => w.id === workspaceId);
        await cleanup(async () => {
          const result = await client.archiveWorkspace(workspaceId);
          if (result.error)
            throw new Error(`Test workspace ${workspaceId}: ${result.error}`);
        });
        if (owned && !existingProjects.has(owned.projectId)) {
          await cleanup(async () => {
            const remaining = await client.fetchWorkspaces({
              includeBackground: true,
              page: { limit: 200 },
            });
            if (!remaining.entries.some((w) => w.projectId === owned.projectId))
              await client.removeProject(owned.projectId);
          });
        }
      }
      if (errors.length)
        throw new AggregateError(
          failure ? [failure, ...errors] : errors,
          `Live test cleanup failed: agent=${agent.id}, workspace=${workspaceId}`,
        );
    }
  }
}
