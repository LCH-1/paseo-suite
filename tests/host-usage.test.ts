import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultCommand } from "../plugins/aster/server/paseo";
import { hostUsageReader } from "../plugins/aster/server/host-usage";

test("local usage calls the UI's API with refresh semantics and preserves custom commands", async () => {
  const requests: unknown[] = [];
  let closed = 0,
    custom = 0;
  const read = hostUsageReader(
    "synthetic",
    async () => ({
      connect: async () => {},
      close: () => {
        closed++;
      },
      invokePluginRpc: async () => {},
      listUsageReports: async (options) => {
        requests.push(options);
        return { reports: [{ id: "synthetic" }] };
      },
    }),
    async () => {
      custom++;
      return "custom-result";
    },
  );
  const signal = new AbortController().signal;
  assert.equal(
    await read(defaultCommand(), ["usage", "--json", "--refresh"], signal),
    '[{"id":"synthetic"}]',
  );
  assert.deepEqual(requests, [{ forceRefresh: true }]);
  assert.equal(closed, 1);
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
  assert.equal(requests.length, 1);
});

test("a host API failure closes the connection without a second CLI request", async () => {
  let closed = 0;
  const read = hostUsageReader(
    "synthetic",
    async () => ({
      connect: async () => {},
      close: () => {
        closed++;
      },
      invokePluginRpc: async () => {},
      listUsageReports: async () => {
        throw Error("synthetic unavailable");
      },
    }),
    async () => {
      throw Error("must not retry through CLI");
    },
  );
  await assert.rejects(
    read(defaultCommand(), ["usage", "--json"], new AbortController().signal),
    /synthetic unavailable/,
  );
  assert.equal(closed, 1);
});
