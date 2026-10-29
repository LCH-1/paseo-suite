import assert from "node:assert/strict";
import { test } from "node:test";
import { relayCredentials, startCredentialRelay, type RelayPeer } from "./credential-relay";
const id = "a".repeat(64),
  key = "-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----";
function peer(
  serverId: string,
  expiry: number | null,
  received: unknown[],
  identity = id,
): RelayPeer {
  return {
    serverId,
    endpoint: "aster",
    client: {
      async invokePluginRpc(_, method, input) {
        if (method.endsWith("status"))
          return {
            version: 1,
            publicKey: key,
            accounts: [{ identity, expiresAt: expiry, revision: null }],
          };
        if (method.endsWith("export")) return { opaque: true, source: serverId };
        received.push({ serverId, input });
        return { changed: 1 };
      },
    },
  };
}
test("relays only the newest same-account credential to older and cleared peers", async () => {
  const received: unknown[] = [];
  const result = await relayCredentials(
    [peer("new", 900000, received), peer("old", 500000, received), peer("cleared", null, received)],
    0,
  );
  assert.equal(result.changed, 2);
  assert.deepEqual(received, [
    { serverId: "old", input: { opaque: true, source: "new" } },
    { serverId: "cleared", input: { opaque: true, source: "new" } },
  ]);
});

test("negotiates Sync and legacy Aster hosts independently without replaying a receive", async () => {
  const received: unknown[] = [];
  const current = peer("current", 900000, received);
  const legacy = peer("legacy", 1, received);
  const currentInvoke = current.client.invokePluginRpc;
  const legacyInvoke = legacy.client.invokePluginRpc;
  const calls: string[] = [];
  delete current.endpoint;
  delete legacy.endpoint;
  current.client.invokePluginRpc = async (id, method, input) => {
    calls.push(`${id}:${method}`);
    assert.equal(id, "settings-sync");
    assert.match(method, /^sync\.credentials\.[a-z]+\.request$/);
    return currentInvoke("aster", method.replace("sync.credentials.", "aster.credentials.").replace(/\.request$/, ""), input);
  };
  legacy.client.invokePluginRpc = async (id, method, input) => {
    if (id !== "aster") throw Error("Unknown plugin RPC");
    return legacyInvoke(id, method, input);
  };
  const result = await relayCredentials([current, legacy], 0);
  assert.equal(result.changed, 1);
  assert.deepEqual(received, [{ serverId: "legacy", input: { opaque: true, source: "current" } }]);
  assert.ok(calls.includes("settings-sync:sync.credentials.export.request"));
});
test("different accounts, expired sources and equal versions are left unchanged", async () => {
  const received: unknown[] = [];
  await relayCredentials(
    [
      peer("a", 500000, received),
      peer("b", 500000, received),
      peer("foreign", 900000, received, "b".repeat(64)),
    ],
    0,
  );
  assert.equal(received.length, 0);
  await relayCredentials([peer("expired", 100, received), peer("empty", null, received)], 0);
  assert.equal(received.length, 0);
});
test("unsupported hosts do not prevent other configured peers from synchronizing", async () => {
  const received: unknown[] = [];
  const bad: RelayPeer = {
    serverId: "legacy",
    client: {
      async invokePluginRpc() {
        throw Error("No RPC");
      },
    },
  };
  const result = await relayCredentials(
    [bad, peer("new", 900000, received), peer("old", 1, received)],
    0,
  );
  assert.equal(result.peers, 2);
  assert.equal(result.changed, 1);
});
test("disposed relays do not forward encrypted credentials", async () => {
  const received: unknown[] = [],
    abort = new AbortController();
  abort.abort();
  await relayCredentials(
    [peer("new", 900000, received), peer("old", 1, received)],
    0,
    abort.signal,
  );
  assert.equal(received.length, 0);
});

test("a stalled host has a deadline and does not block healthy peers", async () => {
  const received: unknown[] = [];
  const stalled: RelayPeer = {
    serverId: "stalled",
    client: { invokePluginRpc: () => new Promise(() => {}) },
  };
  const result = await Promise.race([
    relayCredentials(
      [stalled, peer("new", 900000, received), peer("old", 1, received)],
      0,
      undefined,
      { rpcTimeoutMs: 20 },
    ),
    new Promise<"stalled">((resolve) => {
      const timer = setTimeout(() => resolve("stalled"), 1000);
      timer.unref();
    }),
  ]);
  assert.notEqual(result, "stalled");
  assert.equal((result as any).changed, 1);
});

test("a failed newest exporter falls back to another current same-account source", async () => {
  const received: unknown[] = [],
    latest = peer("latest", 900000, received),
    invoke = latest.client.invokePluginRpc;
  latest.client.invokePluginRpc = async (...args) => {
    if (args[1].endsWith("export")) throw Error("refresh busy");
    return invoke(...args);
  };
  await relayCredentials([latest, peer("middle", 700000, received), peer("old", 1, received)], 0);
  assert.ok(
    received.some((value: any) => value.serverId === "old" && value.input.source === "middle"),
  );
});

test("an exception while reading current sessions is contained and can retry", async () => {
  let attempts = 0;
  const relay = startCredentialRelay(() => {
    if (++attempts === 1) throw Error("session state changing");
    return [];
  });
  try {
    await relay.tick();
    await relay.tick();
    assert.equal(attempts, 2);
  } finally {
    relay.dispose();
  }
});

test("one server can repair its own older physical alias with its newest credential", async () => {
  const received: unknown[] = [],
    own = peer("only", 1, received),
    invoke = own.client.invokePluginRpc;
  own.client.invokePluginRpc = async (...args) => {
    const value: any = await invoke(...args);
    if (args[1].endsWith("status")) value.accounts[0].availableExpiresAt = 900000;
    return value;
  };
  const result = await relayCredentials([own], 0);
  assert.equal(result.changed, 1);
  assert.deepEqual(received, [{ serverId: "only", input: { opaque: true, source: "only" } }]);
});

test("dispose releases a cycle waiting for a nonresponsive status without forwarding", async () => {
  const abort = new AbortController();
  const task = relayCredentials(
    [{ serverId: "stalled", client: { invokePluginRpc: () => new Promise(() => {}) } }],
    0,
    abort.signal,
  );
  abort.abort();
  assert.deepEqual(await task, { peers: 0, changed: 0 });
});
