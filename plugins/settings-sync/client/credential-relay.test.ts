import assert from "node:assert/strict";
import { test } from "node:test";
import { peerConnectionsOf, relayCredentials, startCredentialRelay, type RelayPeer } from "./credential-relay";
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

function fuller(serverId: string, accounts: { identity: string; expiresAt: number | null }[], received: unknown[], extra: Record<string, unknown> = {}): RelayPeer {
  return {
    serverId,
    endpoint: "aster",
    client: {
      async invokePluginRpc(_, method, input: any) {
        if (method.endsWith("status"))
          return { version: 1, publicKey: key, ...extra, accounts: accounts.map((a) => ({ ...a, revision: null })) };
        if (method.endsWith("export")) return { from: serverId, identities: input.identities };
        received.push({ to: serverId, input });
        return { changed: 1 };
      },
    },
  };
}
const hour = 3_600_000;
test("a host keeps its own usable login even when another host has a newer one", async () => {
  const received: unknown[] = [];
  const result = await relayCredentials(
    [fuller("newer", [{ identity: id, expiresAt: 8 * hour }], received), fuller("usable", [{ identity: id, expiresAt: hour }], received)],
    0,
  );
  assert.equal(result.changed, 0);
  assert.deepEqual(received, []);
});
test("a login about to expire is replaced before its own refresh can consume a stale token", async () => {
  const received: any[] = [];
  await relayCredentials(
    [fuller("fresh", [{ identity: id, expiresAt: 8 * hour }], received), fuller("expiring", [{ identity: id, expiresAt: 5 * 60_000 }], received)],
    0,
  );
  assert.deepEqual(received.map((r) => [r.to, r.input.from]), [["expiring", "fresh"]]);
});
test("no host's near-expiry copy is passed around when nobody has a usable one", async () => {
  const received: unknown[] = [];
  await relayCredentials(
    [fuller("a", [{ identity: id, expiresAt: 9 * 60_000 }], received), fuller("b", [{ identity: id, expiresAt: 5 * 60_000 }], received)],
    0,
  );
  assert.deepEqual(received, []);
});
test("the host's own healthy alias is preferred over a newer copy elsewhere", async () => {
  const received: any[] = [];
  const own = fuller("own", [{ identity: id, expiresAt: null }], received);
  const invoke = own.client.invokePluginRpc;
  own.client.invokePluginRpc = async (...args) => {
    const value: any = await invoke(...args);
    if (args[1].endsWith("status")) value.accounts[0].availableExpiresAt = hour;
    return value;
  };
  await relayCredentials([fuller("remote", [{ identity: id, expiresAt: 8 * hour }], received), own], 0);
  assert.deepEqual(received.map((r) => [r.to, r.input.from]), [["own", "own"]]);
});
test("an account logged in on one host reaches hosts that have never seen it, except where declined", async () => {
  const received: any[] = [];
  const other = "b".repeat(64);
  const provision = { provision: true };
  await relayCredentials(
    [
      fuller("login", [{ identity: id, expiresAt: 8 * hour }, { identity: other, expiresAt: 8 * hour }], received, provision),
      fuller("blank", [{ identity: id, expiresAt: 8 * hour }], received, provision),
      fuller("signedout", [{ identity: id, expiresAt: 8 * hour }], received, { provision: true, declined: [other] }),
      fuller("old-plugin", [{ identity: id, expiresAt: 8 * hour }], received),
    ],
    0,
  );
  assert.deepEqual(received.map((r) => [r.to, r.input.identities]), [["blank", [other]]]);
});

test("a refresh token held by two hosts stays on one, preferring a Linux host", async () => {
  const released: unknown[] = [];
  const holder = (serverId: string, platform: string, chains: string[]): RelayPeer => ({
    serverId,
    endpoint: "sync",
    client: {
      async invokePluginRpc(_, method, input) {
        if (method.includes("status"))
          return { version: 1, publicKey: key, borrow: true, platform, accounts: [{ identity: id, expiresAt: 8 * hour, revision: null, chains }] };
        if (method.includes("release")) released.push([serverId, input]);
        return { changed: 0 };
      },
    },
  });
  await relayCredentials(
    [holder("a-windows", "win32", ["c1"]), holder("b-linux", "linux", ["c1"]), holder("c-linux", "linux", ["c1"]), holder("d-own-login", "linux", ["c2"])],
    0,
  );
  assert.deepEqual(released, [
    ["c-linux", { identity: id, chain: "c1" }],
    ["a-windows", { identity: id, chain: "c1" }],
  ]);
});

const relayStatus = (daemonRelay: object) => ({ version: 1, publicKey: key, accounts: [{ identity: id, expiresAt: 1, revision: null }], daemonRelay });
function daemonPeer(serverId: string, daemonRelay: object, calls: string[]): RelayPeer {
  return {
    serverId,
    endpoint: "sync",
    client: {
      async invokePluginRpc(_, method, input) {
        calls.push(method + ":" + serverId);
        if (method.includes("status")) return relayStatus(daemonRelay);
        if (method.includes("peers")) return { peers: (input as any).peers.length };
        throw new Error("no credentials here");
      },
    },
  };
}
const connection = (serverId: string) => ({ serverId, relayEndpoint: "relay.example.invalid:443", useTls: true, daemonPublicKeyB64: "synthetic" });

test("데몬 리더가 정상이고 같은 범위에 닿으면 창은 전달을 양보한다", async () => {
  const calls: string[] = [];
  const leader = { role: "leader", activeAt: 1000, reachable: 2 };
  await relayCredentials([daemonPeer("a", leader, calls), daemonPeer("b", { role: "standby" }, calls)], 2000, undefined, { deferToDaemon: true });
  assert.ok(calls.every((call) => call.includes("status")));
});

test("리더가 오래됐거나 더 적은 호스트에만 닿으면 창이 전달을 계속한다", async () => {
  for (const leader of [{ role: "leader", activeAt: 0, reachable: 2 }, { role: "leader", activeAt: 999_990, reachable: 1 }]) {
    const calls: string[] = [];
    const other = { ...peer("b", 9_000_000, []) };
    await relayCredentials([daemonPeer("a", leader, calls), other], 1_000_000, undefined, { deferToDaemon: true });
    assert.ok(calls.some((call) => call.includes("receive")));
  }
});

test("창은 호스트 접속 정보를 플랫폼과 함께 한 번만 전달한다", async () => {
  const calls: string[] = [];
  const sent: any[] = [];
  const target = daemonPeer("a", { role: "idle" }, calls);
  const invoke = target.client.invokePluginRpc;
  target.client.invokePluginRpc = async (plugin, method, input) => {
    if (method.includes("peers")) sent.push(input);
    return invoke(plugin, method, input);
  };
  const shared = new Map<string, string>();
  const options = { connections: [connection("a"), connection("b")], shared, deferToDaemon: true };
  await relayCredentials([target], 2000, undefined, options);
  await relayCredentials([target], 2000, undefined, options);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].peers.map((p: any) => p.serverId), ["a", "b"]);
});

test("저장된 호스트에서 릴레이 접속 정보만 뽑고 형식이 다르면 빈 목록이다", () => {
  const list = peerConnectionsOf([
    { serverId: "a", password: "synthetic", connections: [{ type: "directTcp" }, { type: "relay", relayEndpoint: "r:443", daemonPublicKeyB64: "k" }] },
    { serverId: "b", connections: [{ type: "directTcp" }] },
    { nope: true },
  ]);
  assert.deepEqual(list, [{ serverId: "a", relayEndpoint: "r:443", useTls: true, daemonPublicKeyB64: "k", password: "synthetic" }]);
  assert.deepEqual(peerConnectionsOf("x"), []);
});
