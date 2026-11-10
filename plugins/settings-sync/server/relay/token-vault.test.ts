import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chainOf } from "./credential-tokens";
import type { SharedCredential } from "./credential-types";
import {
  absorbDecision,
  dropFromVault,
  planRenewals,
  planTransfers,
  putVault,
  readVault,
  recoverRenewal,
  renewVaultRecord,
  supersedes,
  syncVaults,
  vaultAllows,
  vaultStatus,
  wantsActivity,
  type VaultPeerStatus,
} from "./token-vault";

const noRestriction = async () => {};
const identity = "a".repeat(64);
const record = (refreshToken: string, expiresAt: number, id = identity): SharedCredential => ({
  id: "claude-" + "1".repeat(24),
  vendor: "claude",
  providerIds: ["claude"],
  identity: id,
  expiresAt,
  updatedAt: 1,
  credential: { claudeAiOauth: { accessToken: "access-" + refreshToken, refreshToken, expiresAt } },
  metadata: {},
});
const home = () => mkdtemp(path.join(tmpdir(), "token-vault-"));
const save = (root: string, entry: SharedCredential) => putVault(root, entry, { restrict: noRestriction });
const rewrites = (next: Record<string, unknown> | null) => async (directory: string) => {
  const file = path.join(directory, ".credentials.json");
  const before = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify(next ?? { ...before, claudeAiOauth: {} }));
  return null;
};
const options = { restrict: noRestriction, restrictDirectory: noRestriction, now: 1000 };

test("더 늦게 만료되는 토큰이 항상 최신이다", () => {
  assert.equal(supersedes(record("new", 2000), record("old", 1000)), true);
  assert.equal(supersedes(record("old", 1000), record("new", 2000)), false);
  assert.equal(supersedes(record("x", 1000), undefined), true);
  const pair = [record("left", 1000), record("right", 1000)];
  assert.notEqual(supersedes(pair[0], pair[1]), supersedes(pair[1], pair[0]));
});

test("오래 꺼져 있던 호스트의 죽은 토큰이 새 토큰을 덮어쓰지 못한다", async () => {
  const root = await home();
  assert.equal(await save(root, record("rotated", 2000)), true);
  assert.equal(await save(root, record("dead", 1000)), false);
  assert.equal(chainOf((await readVault(root))[0]), chainOf(record("rotated", 2000)));
});

test("보관 파일은 소유자 전용이고 손상되면 비어 있는 것으로 처리한 뒤 복구된다", async () => {
  const root = await home();
  await save(root, record("r", 1000));
  const file = path.join(root, "settings-sync", "claude-vault.json");
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  await writeFile(file, "{cut off");
  const logs: string[] = [];
  assert.deepEqual(await readVault(root, (message) => logs.push(message)), []);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes("{cut"));
  assert.equal(await save(root, record("r", 1000)), true);
  assert.equal((await readVault(root)).length, 1);
});

test("권한 제한에 실패하면 기존 보관 파일을 유지한다", async () => {
  const root = await home();
  await save(root, record("r", 1000));
  await assert.rejects(putVault(root, record("n", 2000), { platform: "win32", restrict: async () => { throw new Error("denied"); } }));
  assert.equal(chainOf((await readVault(root))[0]), chainOf(record("r", 1000)));
});

test("이 호스트에서 로그아웃한 계정은 보관소에서도 지운다", async () => {
  const root = await home();
  await save(root, record("r", 1000));
  await dropFromVault(root, [identity], { restrict: noRestriction });
  assert.deepEqual(await readVault(root), []);
});

test("상태 정보에는 토큰이 없고 요약값만 있다", () => {
  const text = JSON.stringify(vaultStatus([record("secret-refresh", 1000)]));
  assert.ok(!text.includes("secret-refresh"));
  assert.ok(!text.includes("access-"));
  assert.match(text, /"chain":"[a-f0-9]{32}"/);
});

test("목록 파일이 없으면 모든 계정을, 있으면 적힌 계정만 옮긴다", async () => {
  const root = await home();
  assert.equal(await vaultAllows(root, identity), true);
  await save(root, record("r", 1000));
  await writeFile(path.join(root, "settings-sync", "vault-accounts.json"), JSON.stringify(["b".repeat(64)]));
  assert.equal(await vaultAllows(root, identity), false);
  assert.equal(await vaultAllows(root, "b".repeat(64)), true);
  await writeFile(path.join(root, "settings-sync", "vault-accounts.json"), JSON.stringify("all"));
  assert.equal(await vaultAllows(root, identity), true);
  await writeFile(path.join(root, "settings-sync", "vault-accounts.json"), "{broken");
  assert.equal(await vaultAllows(root, identity), false);
});

test("프로필의 토큰은 새 로그인이면 옮기고 죽은 것이면 버린다", () => {
  const held = record("current", 2000);
  assert.equal(absorbDecision(record("new-login", 3000), held), "absorb");
  assert.equal(absorbDecision(record("dead", 1000), held), "drop");
  assert.equal(absorbDecision(record("current", 2000), held), "drop");
  assert.equal(absorbDecision(record("first", 1000), undefined), "absorb");
});

test("전달로 만료 시각만 같아진 죽은 토큰은 보관소의 토큰을 이기지 못한다", () => {
  // Relay deliveries keep a profile's refresh token and copy the expiry, so ties are normal.
  assert.equal(absorbDecision(record("forked-dead", 2000), record("alive", 2000)), "drop");
  assert.equal(absorbDecision(record("zzz-forked-dead", 2000), record("aaa-alive", 2000)), "drop");
});

test("만료 시각이 같으면 실제 갱신으로 나온 토큰이 이긴다", () => {
  const renewed = { ...record("aaa-renewed", 2000), vaultOrigin: "renewal" as const };
  const absorbed = record("zzz-absorbed", 2000);
  assert.equal(supersedes(renewed, absorbed), true);
  assert.equal(supersedes(absorbed, renewed), false);
  assert.deepEqual(
    planTransfers([
      { serverId: "a", publicKey: "k", accounts: [], declined: [], vault: [{ identity, chain: "zzz", expiresAt: 2000 }] },
      { serverId: "b", publicKey: "k", accounts: [], declined: [], vault: [{ identity, chain: "aaa", expiresAt: 2000, renewal: true }] },
    ]),
    [{ identity, from: "b", to: "a" }],
  );
});

test("만료 시각이 없는 로그인은 보관소로 옮기지 않아 프로필에서 지워지지 않는다", () => {
  assert.equal(absorbDecision({ ...record("x", 1000), expiresAt: null }, undefined), "skip");
});

test("방금 회전한 토큰은 시계가 어긋나도 보관한다", async () => {
  const root = await home();
  const old = record("old", 5000);
  await save(root, old);
  const result = await renewVaultRecord(root, old, rewrites({ claudeAiOauth: { accessToken: "a", refreshToken: "next", expiresAt: 4000 } }), { ...options, now: 1000 });
  assert.equal(result.outcome, "renewed");
  assert.equal(chainOf((await readVault(root))[0]), chainOf(record("next", 4000)));
  assert.equal((await readVault(root))[0].vaultOrigin, "renewal");
});


test("CLI가 갱신하면 새 토큰을 보관하고 임시 폴더를 지운다", async () => {
  const root = await home();
  const old = record("old", 1500);
  await save(root, old);
  let seen: { expiresAt?: number; refreshToken?: string } = {};
  const result = await renewVaultRecord(root, old, async (directory) => {
    seen = JSON.parse(await readFile(path.join(directory, ".credentials.json"), "utf8")).claudeAiOauth;
    return rewrites({ claudeAiOauth: { accessToken: "new-access", refreshToken: "new-refresh", expiresAt: 9000 } })(directory);
  }, options);
  assert.equal(result.outcome, "renewed");
  assert.equal(seen.refreshToken, "old");
  assert.ok((seen.expiresAt ?? 0) <= 1500);
  assert.equal(chainOf((await readVault(root))[0]), chainOf(result.record));
  assert.deepEqual(await readdir(path.join(root, "settings-sync", "vault-renew")), []);
});

test("만료가 먼 토큰도 파일에는 곧 만료로 적어 CLI가 갱신하게 한다", async () => {
  const root = await home();
  const old = record("old", 8_000_000);
  await save(root, old);
  let written = 0;
  await renewVaultRecord(root, old, async (directory) => {
    written = JSON.parse(await readFile(path.join(directory, ".credentials.json"), "utf8")).claudeAiOauth.expiresAt;
    return null;
  }, options);
  assert.equal(written, 61_000);
});

test("서버가 거부해 CLI가 파일을 비우면 거부로 보고하고 보관소 토큰은 유지한다", async () => {
  const root = await home();
  const old = record("old", 1500);
  await save(root, old);
  const result = await renewVaultRecord(root, old, rewrites(null), options);
  assert.equal(result.outcome, "rejected");
  assert.equal(chainOf((await readVault(root))[0]), chainOf(old));
});

test("CLI를 실행하지 못하면 변화 없음과 원인을 보고한다", async () => {
  const root = await home();
  const old = record("old", 1500);
  await save(root, old);
  const result = await renewVaultRecord(root, old, async () => "ENOENT", options);
  assert.equal(result.outcome, "unchanged");
  assert.equal(result.failure, "ENOENT");
});

test("갱신 도중 끊겨도 임시 폴더에 남은 새 토큰을 되살린다", async () => {
  const root = await home();
  const old = record("old", 1500);
  await save(root, old);
  await renewVaultRecord(root, old, async (directory) => {
    await writeFile(path.join(directory, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "rotated", expiresAt: 9000 } }));
    throw new Error("process died");
  }, options).catch(() => {});
  const recovered = await recoverRenewal(root, old, options);
  assert.equal(chainOf(recovered), chainOf(record("rotated", 9000)));
  assert.equal(chainOf((await readVault(root))[0]), chainOf(record("rotated", 9000)));
});

test("임시 폴더의 옛 토큰은 되살리지 않는다", async () => {
  const root = await home();
  const old = record("old", 1500);
  await save(root, old);
  await renewVaultRecord(root, old, async () => { throw new Error("process died"); }, options).catch(() => {});
  assert.equal(await recoverRenewal(root, old, options), null);
  assert.equal(chainOf((await readVault(root))[0]), chainOf(old));
});

const status = (serverId: string, vault: [string, number][], extra: Partial<VaultPeerStatus> = {}): VaultPeerStatus => ({
  serverId,
  publicKey: "key-" + serverId,
  vault: vault.map(([chain, expiresAt]) => ({ identity, chain, expiresAt })),
  accounts: [identity],
  declined: [],
  ...extra,
});

test("새 호스트를 포함해 뒤처진 호스트만 최신 호스트에서 받는다", () => {
  assert.deepEqual(
    planTransfers([status("a", [["new", 2000]]), status("b", [["old", 1000]]), status("c", [])]),
    [{ identity, from: "a", to: "b" }, { identity, from: "a", to: "c" }],
  );
  assert.deepEqual(planTransfers([status("a", [["same", 2000]]), status("b", [["same", 2000]])]), []);
});

test("로그아웃한 호스트에는 보내지 않는다", () => {
  assert.deepEqual(planTransfers([status("a", [["new", 2000]]), status("b", [], { declined: [identity] })]), []);
});

test("a에서 로그인하고 b에 복제된 뒤 a가 꺼지면 켜지는 c는 b에서 받는다", () => {
  // a is gone from the peer list; b holds the copy that a handed over earlier.
  assert.deepEqual(planTransfers([status("b", [["from-a", 2000]]), status("c", [])]), [{ identity, from: "b", to: "c" }]);
});

const now = 1_000_000;
const due = now + 60_000;
const renewalTargets = (...args: Parameters<typeof planRenewals>) =>
  planRenewals(...args)
    .filter((item) => item.reason !== "busy")
    .map(({ identity: id, serverId }) => ({ identity: id, serverId }));
test("만료가 임박하면 순서상 첫 호스트 한 곳에만 갱신을 맡긴다", () => {
  const peers = [status("win", [["c", due]]), status("linux2", [["c", due]]), status("linux1", [["c", due]])];
  assert.deepEqual(renewalTargets(peers, ["linux1", "linux2", "win"], now, null), [{ identity, serverId: "linux1" }]);
  assert.deepEqual(renewalTargets([status("a", [["c", now + 3_600_000]])], ["a"], now, null), []);
});

test("최신 토큰을 받지 못한 호스트에는 갱신을 맡기지 않는다", () => {
  const peers = [status("stale", [["old", due - 1000]]), status("fresh", [["new", due]])];
  assert.deepEqual(renewalTargets(peers, ["stale", "fresh"], now, null), [{ identity, serverId: "fresh" }]);
});

test("로그아웃했거나 계정이 없는 호스트는 갱신 대상에서 뺀다", () => {
  const peers = [status("out", [["c", due]], { declined: [identity] }), status("none", [["c", due]], { accounts: [] }), status("ok", [["c", due]])];
  assert.deepEqual(renewalTargets(peers, ["out", "none", "ok"], now, null), [{ identity, serverId: "ok" }]);
  assert.deepEqual(renewalTargets([status("none", [["c", due]], { accounts: [] })], ["none"], now, null), []);
});

test("혼자 켜져 있고 토큰이 이미 만료됐으면 다른 호스트를 잠시 기다린다", () => {
  const expired = [status("a", [["c", now - 1000]])];
  assert.deepEqual(renewalTargets(expired, ["a"], now, 60_000), []);
  assert.deepEqual(renewalTargets(expired, ["a"], now, 11 * 60_000), [{ identity, serverId: "a" }]);
  assert.deepEqual(renewalTargets(expired, ["a"], now, null), [{ identity, serverId: "a" }]);
  // Not expired yet: nobody can have renewed it, so there is nothing to wait for.
  assert.deepEqual(renewalTargets([status("a", [["c", due]])], ["a"], now, 60_000), [{ identity, serverId: "a" }]);
});

/** `running` answers only hosts listed in it, and only when asked; the rest act like older versions. */
function fleet(
  initial: Record<string, { chain: string; expiresAt: number } | null>,
  renewTo?: { chain: string; expiresAt: number },
  renewStatus = "renewed",
  running: Record<string, number> = {},
) {
  const held = new Map(Object.entries(initial));
  const calls: string[] = [];
  const asked: string[] = [];
  const peer = (serverId: string) => ({
    serverId,
    client: {
      async invokePluginRpc(_: string, method: string, input: any) {
        calls.push(method.replace("sync.credentials.", "").replace(".request", "") + ":" + serverId);
        if (method.includes("status")) {
          const entry = held.get(serverId);
          if (input?.activity) asked.push(serverId);
          return {
            publicKey: "key-" + serverId,
            accounts: [{ identity }],
            declined: [],
            vault: entry ? [{ identity, ...entry }] : [],
            ...(input?.activity && serverId in running ? { claudeRunning: running[serverId] } : {}),
          };
        }
        if (method.includes("export")) return { entry: held.get(serverId) };
        if (method.includes("receive")) { held.set(serverId, input.entry); return { changed: true }; }
        if (method.includes("renew")) { if (renewTo) held.set(serverId, renewTo); return { status: renewStatus }; }
        throw new Error("unexpected " + method);
      },
    },
  });
  return { peers: Object.keys(initial).map(peer), held, calls, asked, running };
}
const context = (order: string[], known = order.length) => ({
  order,
  known,
  now,
  state: { retryAt: new Map<string, number>(), failed: new Map<string, Set<string>>(), aloneSince: null, askActivity: false, heldLogAt: new Map<string, number>() },
  log: (_message: string) => {},
});
const renewCalls = (f: ReturnType<typeof fleet>) => f.calls.filter((call) => call.startsWith("vault.renew"));

test("한 번의 처리로 뒤처진 호스트를 채우고 갱신한 뒤 새 토큰까지 다시 복제한다", async () => {
  const f = fleet({ a: { chain: "c1", expiresAt: due }, b: { chain: "c1", expiresAt: due }, c: null }, { chain: "c2", expiresAt: now + 8 * 3_600_000 });
  const result = await syncVaults(f.peers, context(["a", "b", "c"]));
  assert.equal(result.renewed, 1);
  assert.equal(f.calls.filter((call) => call.startsWith("vault.renew")).length, 1);
  assert.deepEqual(f.calls.find((call) => call.startsWith("vault.renew")), "vault.renew:a");
  for (const serverId of ["a", "b", "c"]) assert.equal(f.held.get(serverId)?.chain, "c2");
});

test("리더 둘이 동시에 처리해도 같은 호스트에 맡긴다", async () => {
  const f = fleet({ a: { chain: "c", expiresAt: due }, b: { chain: "c", expiresAt: due } }, undefined, "not-due");
  await syncVaults(f.peers, context(["a", "b"]));
  await syncVaults([...f.peers].reverse(), context(["a", "b"]));
  assert.deepEqual(f.calls.filter((call) => call.startsWith("vault.renew")), ["vault.renew:a", "vault.renew:a"]);
});

test("갱신이 실패하면 일정 시간 재시도하지 않는다", async () => {
  const f = fleet({ a: { chain: "c", expiresAt: due } }, undefined, "unchanged");
  const ctx = context(["a"]);
  await syncVaults(f.peers, ctx);
  await syncVaults(f.peers, ctx);
  assert.equal(f.calls.filter((call) => call.startsWith("vault.renew")).length, 1);
  await syncVaults(f.peers, { ...ctx, now: now + 11 * 60_000 });
  assert.equal(f.calls.filter((call) => call.startsWith("vault.renew")).length, 2);
});

test("혼자일 때 기다린 시간을 기억한다", async () => {
  const f = fleet({ a: { chain: "c", expiresAt: now - 1000 } }, { chain: "c2", expiresAt: now + 3_600_000 });
  const ctx = context(["a", "b"], 2);
  await syncVaults(f.peers, ctx);
  assert.equal(f.calls.filter((call) => call.startsWith("vault.renew")).length, 0);
  await syncVaults(f.peers, { ...ctx, now: now + 11 * 60_000 });
  assert.equal(f.calls.filter((call) => call.startsWith("vault.renew")).length, 1);
});

test("보관소를 모르는 옛 버전 호스트는 건너뛴다", async () => {
  const old = { serverId: "old", client: { invokePluginRpc: async () => ({ publicKey: "k", accounts: [] }) } };
  const f = fleet({ a: { chain: "c", expiresAt: now + 3_600_000 } });
  const result = await syncVaults([old, ...f.peers], context(["old", "a"]));
  assert.deepEqual(result, { moved: 0, renewed: 0 });
});

test("로그에 토큰이 나타나지 않는다", async () => {
  const logs: string[] = [];
  const failing = { serverId: "a", client: { invokePluginRpc: async (_: string, method: string) => {
    if (method.includes("status")) return { publicKey: "k", accounts: [{ identity }], vault: [{ identity, chain: "c", expiresAt: due }] };
    throw new Error("secret-refresh-token");
  } } };
  await syncVaults([failing], { ...context(["a"]), log: (message) => logs.push(message) });
  assert.ok(logs.length > 0);
  assert.ok(!logs.join().includes("secret-refresh-token"));
});

test("다른 호스트가 갱신 중이면 같은 토큰을 맡기지 않는다", () => {
  const peers = [status("a", [["c", due]], { renewing: identity }), status("b", [["c", due]])];
  assert.deepEqual(renewalTargets(peers, ["b", "a"], now, null), []);
});

test("첫 호스트가 CLI를 실행하지 못하면 다음 차례에 다른 호스트가 갱신한다", async () => {
  const f = fleet({ a: { chain: "c", expiresAt: due }, b: { chain: "c", expiresAt: due } }, undefined, "unchanged");
  const ctx = context(["a", "b"]);
  await syncVaults(f.peers, ctx);
  await syncVaults(f.peers, ctx);
  assert.deepEqual(f.calls.filter((call) => call.startsWith("vault.renew")), ["vault.renew:a", "vault.renew:b"]);
  // Both failed: the wait starts, then the first host is tried again.
  await syncVaults(f.peers, ctx);
  assert.equal(f.calls.filter((call) => call.startsWith("vault.renew")).length, 2);
  await syncVaults(f.peers, { ...ctx, now: now + 11 * 60_000 });
  assert.equal(f.calls.filter((call) => call.startsWith("vault.renew")).length, 3);
});

test("거부된 토큰의 대기가 새 로그인을 막지 않는다", async () => {
  const f = fleet({ a: { chain: "dead", expiresAt: due } }, undefined, "rejected");
  const ctx = context(["a"]);
  await syncVaults(f.peers, ctx);
  await syncVaults(f.peers, ctx);
  assert.equal(f.calls.filter((call) => call.startsWith("vault.renew")).length, 1);
  f.held.set("a", { chain: "fresh-login", expiresAt: due + 1000 });
  await syncVaults(f.peers, ctx);
  assert.equal(f.calls.filter((call) => call.startsWith("vault.renew")).length, 2);
});

const early = now + 40 * 60_000;
const plan = (peers: VaultPeerStatus[], order: string[], at = now) =>
  planRenewals(peers, order, at, null).map(({ serverId, reason, running }) => ({ serverId, reason, running }));

test("만료 60분 안이고 그 계정을 쓰는 호스트가 모두 쉬면 미리 갱신한다", () => {
  const peers = [status("a", [["c", early]], { claudeRunning: 0 }), status("b", [["c", early]], { claudeRunning: 0 })];
  assert.deepEqual(plan(peers, ["b", "a"]), [{ serverId: "b", reason: "idle", running: 0 }]);
  assert.deepEqual(plan([status("a", [["c", now + 61 * 60_000]], { claudeRunning: 0 })], ["a"]), []);
});

test("만료 60분 안이라도 Claude 작업이 진행 중인 호스트가 있으면 보류한다", () => {
  const peers = [status("a", [["c", early]], { claudeRunning: 0 }), status("b", [["c", early]], { claudeRunning: 2 })];
  assert.deepEqual(plan(peers, ["a", "b"]), [{ serverId: "a", reason: "busy", running: 2 }]);
});

test("그 계정을 쓰지 않거나 로그아웃한 호스트의 작업은 따지지 않는다", () => {
  const peers = [
    status("a", [["c", early]], { claudeRunning: 0 }),
    status("other", [], { accounts: [], claudeRunning: 4 }),
    status("out", [], { declined: [identity], claudeRunning: 3 }),
  ];
  assert.deepEqual(plan(peers, ["a"]), [{ serverId: "a", reason: "idle", running: 0 }]);
});

test("만료 15분 안에서는 작업이 진행 중이어도 지금처럼 갱신한다", () => {
  const peers = [status("a", [["c", due]], { claudeRunning: 3 }), status("b", [["c", due]])];
  assert.deepEqual(plan(peers, ["a", "b"]), [{ serverId: "a", reason: "due", running: 3 }]);
  const deadline = now + 15 * 60_000;
  assert.deepEqual(plan([status("a", [["c", deadline]], { claudeRunning: 1 })], ["a"]), [{ serverId: "a", reason: "due", running: 1 }]);
});

test("작업 상태를 알리지 않는 옛 버전 호스트가 섞여도 15분 마감선은 그대로다", () => {
  // Left out of the count: the host that did report decides.
  const mixed = [status("old", [["c", early]]), status("new", [["c", early]], { claudeRunning: 0 })];
  assert.deepEqual(plan(mixed, ["old", "new"]), [{ serverId: "old", reason: "idle", running: 0 }]);
  const busy = [status("old", [["c", early]]), status("new", [["c", early]], { claudeRunning: 1 })];
  assert.deepEqual(plan(busy, ["old", "new"]), [{ serverId: "old", reason: "busy", running: 1 }]);
  // Nobody reported, so nothing says it is idle: the deadline renews it as before.
  const old = [status("old1", [["c", early]]), status("old2", [["c", early]])];
  assert.deepEqual(plan(old, ["old1", "old2"]), [{ serverId: "old1", reason: "busy", running: null }]);
  assert.deepEqual(plan(old, ["old1", "old2"], early - 15 * 60_000), [{ serverId: "old1", reason: "due", running: null }]);
  assert.deepEqual(renewalTargets(busy, ["old", "new"], early - 14 * 60_000, null), [{ identity, serverId: "old" }]);
});

test("다른 호스트가 갱신 중이면 유휴 구간에서도 같은 토큰을 맡기지 않는다", () => {
  const peers = [status("a", [["c", early]], { renewing: identity, claudeRunning: 0 }), status("b", [["c", early]], { claudeRunning: 0 })];
  assert.deepEqual(plan(peers, ["b", "a"]), []);
});

test("유휴 구간에 가까운 토큰이 있을 때만 작업 상태를 묻는다", () => {
  assert.equal(wantsActivity([status("a", [["c", now + 3 * 3_600_000]])], now), false);
  assert.equal(wantsActivity([status("a", [["c", now + 61 * 60_000]])], now), true);
  assert.equal(wantsActivity([status("a", [["c", early]])], now), true);
  // Renewed or waited on whatever runs, so asking would only cost.
  assert.equal(wantsActivity([status("a", [["c", due]])], now), false);
  assert.equal(wantsActivity([status("a", [["c", now - 3_600_000]])], now), false);
});

test("유휴 구간에서만 작업 상태를 묻고 모두 쉬는 순간 갱신한 뒤 다시 묻지 않는다", async () => {
  const f = fleet(
    { a: { chain: "c1", expiresAt: early }, b: { chain: "c1", expiresAt: early } },
    { chain: "c2", expiresAt: now + 8 * 3_600_000 },
    "renewed",
    { a: 0, b: 1 },
  );
  const logs: string[] = [];
  const ctx = { ...context(["a", "b"]), log: (message: string) => void logs.push(message) };
  await syncVaults(f.peers, ctx);
  assert.equal(f.asked.length, 0);
  assert.equal(logs.length, 0);
  await syncVaults(f.peers, { ...ctx, now: now + 60_000 });
  assert.deepEqual([...f.asked].sort(), ["a", "b"]);
  assert.deepEqual(renewCalls(f), []);
  assert.deepEqual(logs, [`[settings-sync] ${identity.slice(0, 6)} 토큰 갱신 보류: 실행 중인 Claude 작업 1개 (만료까지 39분)`]);
  f.running.b = 0;
  await syncVaults(f.peers, { ...ctx, now: now + 120_000 });
  assert.deepEqual(renewCalls(f), ["vault.renew:a"]);
  assert.ok(logs.includes(`[settings-sync] ${identity.slice(0, 6)} 토큰 갱신: 유휴 시점 (만료까지 38분)`));
  for (const serverId of ["a", "b"]) assert.equal(f.held.get(serverId)?.chain, "c2");
  const asked = f.asked.length;
  await syncVaults(f.peers, { ...ctx, now: now + 180_000 });
  assert.equal(f.asked.length, asked);
});

test("보류 로그는 계정마다 10분에 한 줄이고 마감선에서는 작업 중이어도 갱신한다", async () => {
  const f = fleet({ a: { chain: "c", expiresAt: now + 30 * 60_000 } }, { chain: "c2", expiresAt: now + 8 * 3_600_000 }, "renewed", { a: 2 });
  const logs: string[] = [];
  const ctx = { ...context(["a"]), log: (message: string) => void logs.push(message) };
  ctx.state.askActivity = true;
  for (let minute = 0; minute < 15; minute++) await syncVaults(f.peers, { ...ctx, now: now + minute * 60_000 });
  assert.equal(logs.filter((line) => line.includes("보류")).length, 2);
  assert.deepEqual(renewCalls(f), []);
  await syncVaults(f.peers, { ...ctx, now: now + 15 * 60_000 });
  assert.deepEqual(renewCalls(f), ["vault.renew:a"]);
  assert.ok(logs.includes(`[settings-sync] ${identity.slice(0, 6)} 토큰 갱신: 만료 임박, 실행 중인 Claude 작업 2개 (만료까지 15분)`));
});

test("이른 갱신을 받지 않는 옛 버전 호스트에는 마감선까지만 다시 묻지 않는다", async () => {
  const f = fleet({ old: { chain: "c", expiresAt: now + 20 * 60_000 }, new: { chain: "c", expiresAt: now + 20 * 60_000 } }, undefined, "not-due", { new: 0 });
  const ctx = context(["old", "new"]);
  ctx.state.askActivity = true;
  await syncVaults(f.peers, ctx);
  await syncVaults(f.peers, { ...ctx, now: now + 60_000 });
  assert.deepEqual(renewCalls(f), ["vault.renew:old"]);
  // The deadline, not the usual ten minutes later.
  await syncVaults(f.peers, { ...ctx, now: now + 5 * 60_000 });
  assert.deepEqual(renewCalls(f), ["vault.renew:old", "vault.renew:old"]);
});

test("유휴 갱신은 한 번의 처리에 하나만 하고 마감선에 걸린 토큰은 그대로 이어서 갱신한다", async () => {
  const second = "b".repeat(64);
  const renews: string[] = [];
  const host = (secondExpiresAt: number) => ({
    serverId: "a",
    client: {
      async invokePluginRpc(_: string, method: string, input: any) {
        if (method.includes("status"))
          return {
            publicKey: "k",
            accounts: [{ identity }, { identity: second }],
            declined: [],
            claudeRunning: 0,
            vault: [{ identity, chain: "c1", expiresAt: early }, { identity: second, chain: "c2", expiresAt: secondExpiresAt }],
          };
        if (method.includes("renew")) {
          renews.push(input.identity);
          return { status: "unchanged" };
        }
        throw new Error("unexpected " + method);
      },
    },
  });
  const ctx = context(["a"]);
  ctx.state.askActivity = true;
  // What was idle before a renewal that took a while is looked at again on the next pass.
  await syncVaults([host(early)], ctx);
  assert.deepEqual(renews, [identity]);
  await syncVaults([host(early)], { ...ctx, now: now + 60_000 });
  assert.deepEqual(renews, [identity, second]);
  renews.length = 0;
  const fresh = context(["a"]);
  fresh.state.askActivity = true;
  await syncVaults([host(due)], fresh);
  assert.deepEqual(renews, [identity, second]);
});
