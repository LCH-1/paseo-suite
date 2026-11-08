import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { withLiveTestSession } from "../tools/live-test-session";

test("live test failure removes its agent, workspace and new project but preserves existing projects", async () => {
  for (const existing of [true, false]) {
    const calls: string[] = [];
    let created = false,
      archived = false;
    const client = {
      fetchWorkspaces: async () => ({
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
