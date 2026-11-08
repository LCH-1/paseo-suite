import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { withLiveTestSession } from "../tools/live-test-session";

test("live cleanup keeps a new project when another workspace appears on a later page", async () => {
  const calls: string[] = [];
  let created = false,
    archived = false;
  const pageInfo = { nextCursor: null, prevCursor: null, hasMore: false };
  const client = {
    fetchWorkspaces: async (input: { page: { cursor?: string } }) => {
      if (!created) return { entries: [], pageInfo };
      if (!archived)
        return {
          entries: [{ id: "test-workspace", projectId: "new-project" }],
          pageInfo,
        };
      return input.page.cursor
        ? {
            entries: [{ id: "user-workspace", projectId: "new-project" }],
            pageInfo,
          }
        : {
            entries: [],
            pageInfo: {
              ...pageInfo,
              nextCursor: "user-workspace-page",
              hasMore: true,
            },
          };
    },
    listProjects: async () => ({ projects: [] }),
    createAgent: async () => {
      created = true;
      return { id: "test-agent", workspaceId: "test-workspace" };
    },
    deleteAgent: async () => {
      calls.push("agent");
    },
    archiveWorkspace: async () => {
      archived = true;
      calls.push("workspace");
      return { error: null };
    },
    removeProject: async () => {
      calls.push("project");
    },
  };
  await withLiveTestSession(
    client as unknown as Parameters<typeof withLiveTestSession>[0],
    { provider: "claude", cwd: "/tmp" },
    async () => "done",
  );
  assert.deepEqual(calls, ["agent", "workspace"]);
});

test("live test does not create resources when the server repeats an incomplete cursor", async () => {
  let created = false;
  const client = {
    fetchWorkspaces: async () => ({
      entries: [],
      pageInfo: { nextCursor: "repeated", prevCursor: null, hasMore: true },
    }),
    createAgent: async () => {
      created = true;
    },
  };
  await assert.rejects(
    withLiveTestSession(
      client as unknown as Parameters<typeof withLiveTestSession>[0],
      { provider: "claude", cwd: "/tmp" },
      async () => "done",
    ),
    /incomplete workspace pagination/,
  );
  assert.equal(created, false);
});

test("live test creation failure removes the workspace reported before the provider failed", async () => {
  const calls: string[] = [];
  let created = false,
    archived = false;
  const client = {
    fetchWorkspaces: async () => ({
      entries:
        created && !archived
          ? [{ id: "partial-workspace", projectId: "new-project" }]
          : [],
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
    }),
    listProjects: async () => ({ projects: [] }),
    createAgent: async (input: { onEvent?: (snapshot: unknown) => void }) => {
      created = true;
      input.onEvent?.({
        workspace: { id: "partial-workspace", projectId: "new-project" },
        workspaceId: "partial-workspace",
        phase: "workspace_ready",
      });
      throw new Error("provider refused");
    },
    deleteAgent: async () => {
      calls.push("agent");
    },
    archiveWorkspace: async () => {
      archived = true;
      calls.push("workspace");
      return { error: null };
    },
    removeProject: async () => {
      calls.push("project");
    },
  };
  await assert.rejects(
    withLiveTestSession(
      client as unknown as Parameters<typeof withLiveTestSession>[0],
      { provider: "claude", cwd: "/tmp" },
      async () => {
        assert.fail("A failed creation must not start the test");
      },
    ),
    /provider refused/,
  );
  assert.deepEqual(calls, ["workspace", "project"]);
});

test("live test cleanup still archives its workspace when the directory read fails", async () => {
  const calls: string[] = [];
  let reads = 0;
  const client = {
    fetchWorkspaces: async () => {
      if (++reads > 1) throw new Error("directory unavailable");
      return {
        entries: [],
        pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
      };
    },
    listProjects: async () => ({ projects: [] }),
    createAgent: async () => ({
      id: "test-agent",
      workspaceId: "test-workspace",
    }),
    deleteAgent: async () => {
      calls.push("agent");
    },
    archiveWorkspace: async () => {
      calls.push("workspace");
      return { error: null };
    },
    removeProject: async () => {
      calls.push("project");
    },
  };
  await assert.rejects(
    withLiveTestSession(
      client as unknown as Parameters<typeof withLiveTestSession>[0],
      { provider: "claude", cwd: "/tmp" },
      async () => {
        throw new Error("test failed");
      },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((e) => e.message),
        ["test failed", "directory unavailable"],
      );
      return true;
    },
  );
  assert.deepEqual(calls, ["agent", "workspace"]);
});

test("live test cleanup reads every page before deciding an existing workspace is disposable", async () => {
  const calls: string[] = [];
  const client = {
    fetchWorkspaces: async (input: { page: { cursor?: string } }) =>
      input.page.cursor
        ? {
            entries: [
              { id: "existing-workspace", projectId: "existing-project" },
            ],
            pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
          }
        : {
            entries: [{ id: "first-page", projectId: "other" }],
            pageInfo: {
              nextCursor: "second-page",
              prevCursor: null,
              hasMore: true,
            },
          },
    listProjects: async () => ({
      projects: [{ projectId: "existing-project" }],
    }),
    createAgent: async () => ({
      id: "test-agent",
      workspaceId: "existing-workspace",
    }),
    deleteAgent: async () => {
      calls.push("delete-agent");
    },
    archiveWorkspace: async () => {
      calls.push("archive-existing-workspace");
      return { error: null };
    },
    removeProject: async () => {
      calls.push("remove-existing-project");
    },
  };
  await withLiveTestSession(
    client as unknown as Parameters<typeof withLiveTestSession>[0],
    { provider: "claude", cwd: "/tmp" },
    async () => "done",
  );
  assert.deepEqual(calls, ["delete-agent"]);
});

test("live test failure removes its agent, workspace and new project but preserves existing projects", async () => {
  for (const existing of [true, false]) {
    const calls: string[] = [];
    let created = false,
      archived = false;
    const client = {
      fetchWorkspaces: async () => ({
        pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        entries:
          created && !archived
            ? [{ id: "test-workspace", projectId: "project" }]
            : [],
      }),
      listProjects: async () => ({
        projects: existing ? [{ projectId: "project" }] : [],
      }),
      createAgent: async () => {
        created = true;
        return { id: "test-agent", workspaceId: "test-workspace" };
      },
      deleteAgent: async (id: string) => {
        calls.push(`agent:${id}`);
      },
      archiveWorkspace: async (id: string) => {
        archived = true;
        calls.push(`workspace:${id}`);
        return { error: null };
      },
      removeProject: async (id: string) => {
        calls.push(`project:${id}`);
      },
    };
    await assert.rejects(
      withLiveTestSession(
        client as unknown as Parameters<typeof withLiveTestSession>[0],
        { provider: "claude", cwd: "/tmp" },
        async () => {
          throw new Error("test failed");
        },
      ),
      /test failed/,
    );
    assert.deepEqual(calls, [
      "agent:test-agent",
      "workspace:test-workspace",
      ...(existing ? [] : ["project:project"]),
    ]);
  }
});
import {
  localWebsocketTarget,
  registerLegacyCredentialRpc,
} from "../plugins/aster/server/legacy-credential-rpc";

test("legacy forwarding only targets the same machine's websocket", () => {
  assert.equal(
    localWebsocketTarget("127.0.0.1:6767"),
    "ws://127.0.0.1:6767/ws",
  );
  assert.equal(localWebsocketTarget("0.0.0.0:6767"), "ws://127.0.0.1:6767/ws");
  assert.equal(localWebsocketTarget("[::]:6767"), "ws://[::1]:6767/ws");
  for (const target of [
    "192.0.2.1:6767",
    "user:password@localhost:6767",
    "https://localhost:6767",
    "localhost:0",
  ])
    assert.throws(() => localWebsocketTarget(target));
});
test("Aster forwards old calls once to Sync and closes its connection on success, failure and teardown", async () => {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const calls: unknown[] = [];
  const server = {
    handle: (
      contract: { name: string },
      handle: (input: unknown) => Promise<unknown>,
    ) => handlers.set(contract.name, handle),
  } as unknown as PluginServerContext;
  let closed = 0;
  const dispose = registerLegacyCredentialRpc(
    server,
    "/synthetic",
    async () => ({
      connect: async () => {},
      close: () => {
        closed++;
      },
      invokePluginRpc: async (...args) => {
        calls.push(args);
        if (args[1].includes("receive")) throw Error("synthetic busy");
        return { version: 1 };
      },
    }),
  );
  assert.deepEqual(await handlers.get("aster.credentials.status")!({}), {
    version: 1,
  });
  assert.deepEqual(calls[0], [
    "settings-sync",
    "sync.credentials.status.request",
    {},
  ]);
  await assert.rejects(
    handlers.get("aster.credentials.receive")!({ opaque: true }),
    /busy/,
  );
  assert.equal(calls.length, 2);
  assert.equal(closed, 2);
  dispose();
  await assert.rejects(handlers.get("aster.credentials.status")!({}), /해제/);
  assert.equal(calls.length, 2);
});
