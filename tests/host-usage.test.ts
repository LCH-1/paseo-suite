import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultCommand } from "../plugins/aster/server/paseo";
import { hostUsageReader } from "../plugins/aster/server/host-usage";
import { LocalDaemon } from "../plugins/aster/server/local-daemon";

test("local usage calls the UI's API with refresh semantics over one kept connection and preserves custom commands", async () => {
  const requests: unknown[] = [];
  let created = 0,
    closed = 0,
    custom = 0;
  const daemon = new LocalDaemon("synthetic", async () => {
    created++;
    return {
      connect: async () => {},
      close: () => {
        closed++;
      },
      invokePluginRpc: async () => {},
      listUsageReports: async (options: unknown) => {
        requests.push(options);
        return { reports: [{ id: "synthetic" }] };
      },
    } as never;
  });
  const read = hostUsageReader("synthetic", daemon, async () => {
    custom++;
    return "custom-result";
  });
  const signal = new AbortController().signal;
  assert.equal(
    await read(defaultCommand(), ["usage", "--json", "--refresh"], signal),
    '[{"id":"synthetic"}]',
  );
  assert.equal(
    await read(defaultCommand(), ["usage", "--json"], signal),
    '[{"id":"synthetic"}]',
  );
  assert.deepEqual(requests, [{ forceRefresh: true }, { forceRefresh: false }]);
  assert.equal(created, 1);
  assert.equal(closed, 0);
  assert.equal(custom, 0);
  assert.equal(
    await read(
      { file: "explicit-custom-command", args: [] },
      ["usage", "--json"],
      signal,
    ),
    "custom-result",
  );
  assert.equal(custom, 1);
  assert.equal(requests.length, 2);
  daemon.close();
  assert.equal(closed, 1);
});

test("a host API failure is neither asked again nor retried through the CLI, and the connection stays", async () => {
  let closed = 0,
    asked = 0;
  const daemon = new LocalDaemon(
    "synthetic",
    async () =>
      ({
        connect: async () => {},
        close: () => {
          closed++;
        },
        invokePluginRpc: async () => {},
        listUsageReports: async () => {
          asked++;
          throw Error("synthetic unavailable");
        },
      }) as never,
  );
  const read = hostUsageReader("synthetic", daemon, async () => {
    throw Error("must not retry through CLI");
  });
  await assert.rejects(
    read(defaultCommand(), ["usage", "--json"], new AbortController().signal),
    /synthetic unavailable/,
  );
  assert.equal(asked, 1);
  assert.equal(closed, 0);
  daemon.close();
});
