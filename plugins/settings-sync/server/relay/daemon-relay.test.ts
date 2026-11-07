import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DaemonRelay, leadsFor, mergePeers, rankPeers, readPeers, savePeers, type PeerClient, type PeerConnection } from "./daemon-relay";
import { ownerOnlyArguments } from "./secure-file";

const peer = (serverId: string, platform?: string, updatedAt?: string): PeerConnection => ({
  serverId,
  relayEndpoint: "relay.example.invalid:443",
  useTls: true,
  daemonPublicKeyB64: "synthetic-key",
  ...(platform ? { platform } : {}),
  ...(updatedAt ? { updatedAt } : {}),
});
const noRestriction = async () => {};
async function home(selfId: string, peers: PeerConnection[]) {
  const root = await mkdtemp(path.join(tmpdir(), "daemon-relay-"));
  await writeFile(path.join(root, "server-id"), selfId);
  if (peers.length) await savePeers(root, peers, { restrict: noRestriction });
  return root;
}
const healthyLeader = { role: "leader", ageMs: 1000, reached: ["a", "b", "c"] };
type Answer = object | "offline" | "silent";
function fleet(answers: Record<string, Answer>) {
  const connected: string[] = [];
  const closed: string[] = [];
  const connect = async (target: PeerConnection): Promise<PeerClient> => {
    const answer = answers[target.serverId];
    if (answer === "offline" || answer === undefined) throw new Error("offline");
    connected.push(target.serverId);
    return {
      isConnected: true,
      close: () => closed.push(target.serverId),
      invokePluginRpc: async () => {
        if (answer === "silent") throw new Error("no answer");
        return { daemonRelay: answer };
      },
    };
  };
  return { connect, connected, closed };
}
function relay(root: string, connect: (target: PeerConnection, selfId: string) => Promise<PeerClient>, extra: object = {}) {
  const delivered: string[][] = [];
  const logs: string[] = [];
  const instance = new DaemonRelay({
    home: root,
    enabled: async () => true,
    connect,
    log: (message) => logs.push(message),
    syncVaults: (async () => ({ moved: 0, renewed: 0 })) as never,
    relay: (async (peers: { serverId: string }[]) => {
      delivered.push(peers.map((entry) => entry.serverId).sort());
      return { peers: peers.length, changed: 1, reached: peers.map((entry) => entry.serverId) };
    }) as never,
    ...extra,
  });
  return { instance, delivered, logs };
}

test("서버가 앞에 오고 모든 데몬이 같은 순서를 계산한다", () => {
  const order = rankPeers([peer("c", "win32"), peer("b"), peer("z", "linux"), peer("a", "linux")]);
  assert.deepEqual(order.map((entry) => entry.serverId), ["a", "z", "b", "c"]);
});

test("다른 창의 목록이 기존 호스트를 지우지 않고 플랫폼 정보도 유지한다", () => {
  const merged = mergePeers([peer("a", "linux"), peer("b")], [peer("a"), peer("c")]);
  assert.deepEqual(merged.map((entry) => entry.serverId), ["a", "b", "c"]);
  assert.equal(merged[0].platform, "linux");
});

test("앱에서 지운 호스트는 목록에서 빠지고 다시 추가하면 돌아온다", () => {
  const list = [peer("a"), peer("b")];
  assert.deepEqual(mergePeers(list, [peer("a")], ["b"]).map((entry) => entry.serverId), ["a"]);
  assert.deepEqual(mergePeers(list, [peer("a"), peer("b")], ["b"]).map((entry) => entry.serverId), ["a", "b"]);
});

test("오래된 창의 접속 정보가 더 새로운 정보를 덮어쓰지 않는다", () => {
  const fresh = { ...peer("a", undefined, "2026-11-07T00:00:00Z"), daemonPublicKeyB64: "fresh" };
  const stale = { ...peer("a", "linux", "2026-10-01T00:00:00Z"), daemonPublicKeyB64: "stale" };
  const [kept] = mergePeers([fresh], [stale]);
  assert.equal(kept.daemonPublicKeyB64, "fresh");
  assert.equal(kept.platform, "linux");
  assert.equal(mergePeers([stale], [fresh])[0].daemonPublicKeyB64, "fresh");
});

test("접속 정보는 소유자만 읽을 수 있는 파일에 저장되고 형식이 다르면 없는 것으로 처리한다", async () => {
  const root = await home("a", [peer("a")]);
  const file = path.join(root, "settings-sync", "relay-peers.json");
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await readPeers(root)).length, 1);
  await writeFile(file, JSON.stringify([{ serverId: "a", unexpected: true }]));
  assert.deepEqual(await readPeers(root, () => {}), []);
});

test("손상된 목록은 다음 전달로 복구된다", async () => {
  const root = await home("a", []);
  await mkdir(path.join(root, "settings-sync"), { recursive: true });
  await writeFile(path.join(root, "settings-sync", "relay-peers.json"), "{cut off");
  const logs: string[] = [];
  assert.deepEqual(await readPeers(root, (message) => logs.push(message)), []);
  assert.equal(logs.length, 1);
  assert.equal(await savePeers(root, [peer("a")], { restrict: noRestriction }), 1);
  assert.equal((await readPeers(root)).length, 1);
});

test("권한 제한에 실패해도 쓰던 목록은 남고 임시 파일도 남지 않는다", async () => {
  const root = await home("a", [peer("a")]);
  await assert.rejects(savePeers(root, [peer("b")], { platform: "win32", restrict: async () => { throw new Error("denied"); } }));
  assert.deepEqual((await readPeers(root)).map((entry) => entry.serverId), ["a"]);
  assert.deepEqual(await readdir(path.join(root, "settings-sync")), ["relay-peers.json"]);
  // Nothing new to write: a failed re-check keeps the list and does not fail the call.
  assert.equal(await savePeers(root, [peer("a")], { platform: "win32", restrict: async () => { throw new Error("denied"); } }), 1);
});

test("권한은 이름을 쓰기 전 임시 파일에 먼저 적용한다", async () => {
  const root = await home("a", []);
  const restricted: string[] = [];
  await savePeers(root, [peer("a")], { platform: "win32", restrict: async (file) => void restricted.push(path.basename(file)) });
  assert.equal(restricted.length, 1);
  assert.match(restricted[0], /\.tmp$/);
});

test("Windows에서는 상속 권한을 끊고 소유자와 SYSTEM만 SID로 남긴다", () => {
  assert.deepEqual(ownerOnlyArguments("C:\\p\\relay-peers.json", "S-1-5-21-1-2-3-1001"), [
    "C:\\p\\relay-peers.json",
    "/inheritance:r",
    "/grant:r",
    "*S-1-5-21-1-2-3-1001:F",
    "*S-1-5-18:F",
  ]);
});

test("실제로 이 호스트까지 전달 중인 최근 리더에게만 양보한다", () => {
  assert.equal(leadsFor(healthyLeader as never, "b"), true);
  assert.equal(leadsFor({ ...healthyLeader, reached: ["a"] } as never, "b"), false);
  assert.equal(leadsFor({ ...healthyLeader, ageMs: 10 * 60_000 } as never, "b"), false);
  assert.equal(leadsFor({ ...healthyLeader, ageMs: null } as never, "b"), false);
  assert.equal(leadsFor({ ...healthyLeader, role: "standby" } as never, "b"), false);
  assert.equal(leadsFor({ capable: true } as never, "b"), false);
  assert.equal(leadsFor(undefined, "b"), false);
});

test("가장 앞선 데몬이 전체에 전달한다", async () => {
  const root = await home("a", [peer("a", "linux"), peer("b", "linux"), peer("c", "win32")]);
  const f = fleet({ a: {}, b: {}, c: {} });
  const r = relay(root, f.connect);
  await r.instance.tick();
  assert.deepEqual(r.delivered, [["a", "b", "c"]]);
  const state = await r.instance.snapshot();
  assert.equal(state.role, "leader");
  assert.equal(state.capable, true);
  assert.equal(state.reachable, 3);
  assert.deepEqual([...state.reached].sort(), ["a", "b", "c"]);
  assert.equal(typeof state.ageMs, "number");
});

test("앞선 데몬이 살아서 전달 중이면 대기하고 그 연결만 유지한다", async () => {
  const root = await home("b", [peer("a", "linux"), peer("b", "linux"), peer("c", "win32")]);
  const f = fleet({ a: healthyLeader, b: {}, c: {} });
  const r = relay(root, f.connect);
  await r.instance.tick();
  assert.deepEqual(r.delivered, []);
  assert.deepEqual(f.connected, ["a"]);
  assert.equal((await r.instance.snapshot()).role, "standby");
});

test("앞선 데몬이 꺼지면 이어받는다", async () => {
  const root = await home("b", [peer("a", "linux"), peer("b", "linux")]);
  const answers: Record<string, Answer> = { a: healthyLeader, b: {} };
  const f = fleet(answers);
  let connected = true;
  const r = relay(root, async (target) => {
    const client = await f.connect(target);
    return target.serverId === "a"
      ? (Object.defineProperty({ ...client }, "isConnected", { get: () => connected }) as PeerClient)
      : client;
  });
  await r.instance.tick();
  assert.equal((await r.instance.snapshot()).role, "standby");
  connected = false;
  answers.a = "offline";
  await r.instance.tick();
  assert.equal((await r.instance.snapshot()).role, "leader");
  assert.deepEqual(r.delivered, [["b"]]);
});

test("켜져 있어도 전달하지 않는 앞선 호스트에는 양보하지 않는다", async () => {
  const root = await home("b", [peer("a", "linux"), peer("b", "linux")]);
  for (const answer of [{ capable: true, role: "idle" }, { ...healthyLeader, reached: ["a"] }, { ...healthyLeader, ageMs: 600_000 }, "silent"] as const) {
    const f = fleet({ a: answer, b: {} });
    const r = relay(root, f.connect);
    await r.instance.tick();
    assert.equal((await r.instance.snapshot()).role, "leader", JSON.stringify(answer));
    assert.equal(r.delivered.length, 1);
    r.instance.dispose();
  }
});

test("모든 호스트에 연결하지 못하면 리더라고 보고하지 않고 실패를 한 번만 기록한다", async () => {
  const root = await home("a", [peer("a", "linux"), peer("b", "linux")]);
  let now = 1000;
  const r = relay(root, async () => { throw new Error("relay.example.invalid synthetic-key"); }, { now: () => now });
  await r.instance.tick();
  const state = await r.instance.snapshot();
  assert.equal(state.role, "idle");
  assert.equal(state.activeAt, null);
  now += 6 * 60_000;
  await r.instance.tick();
  assert.equal(r.logs.filter((line) => line.includes("연결 실패")).length, 2);
  assert.ok(!r.logs.join().includes("synthetic-key"));
  assert.ok(!r.logs.join().includes("example.invalid"));
});

test("꺼진 호스트에는 매 분 다시 연결하지 않는다", async () => {
  const root = await home("a", [peer("a", "linux"), peer("b", "win32")]);
  let attempts = 0;
  let now = 1000;
  const f = fleet({ a: {} });
  const r = relay(
    root,
    async (target) => {
      if (target.serverId === "b") attempts++;
      return f.connect(target);
    },
    { now: () => now },
  );
  await r.instance.tick();
  now += 60_000;
  await r.instance.tick();
  assert.equal(attempts, 1);
  now += 5 * 60_000;
  await r.instance.tick();
  assert.equal(attempts, 2);
});

test("전달 설정을 끄면 연결을 모두 닫고 아무 일도 하지 않는다", async () => {
  const root = await home("a", [peer("a", "linux")]);
  let on = true;
  const f = fleet({ a: {} });
  const r = relay(root, f.connect, { enabled: async () => on });
  await r.instance.tick();
  assert.deepEqual(r.delivered.length, 1);
  on = false;
  await r.instance.tick();
  assert.equal((await r.instance.snapshot()).role, "idle");
  assert.deepEqual(f.closed, ["a"]);
  assert.equal(r.delivered.length, 1);
});

test("접속 정보가 없으면 데몬은 연결을 시도하지 않는다", async () => {
  const root = await home("a", []);
  const f = fleet({});
  const r = relay(root, f.connect);
  await r.instance.tick();
  assert.deepEqual(f.connected, []);
  assert.equal((await r.instance.snapshot()).capable, false);
});

test("상태 응답에 접속 정보가 나타나지 않는다", async () => {
  const root = await home("a", [peer("a", "linux")]);
  const f = fleet({ a: {} });
  const r = relay(root, f.connect);
  await r.instance.tick();
  const text = JSON.stringify([r.logs, await r.instance.snapshot()]);
  assert.ok(!text.includes("synthetic-key"));
  assert.ok(!text.includes("example.invalid"));
  assert.ok((await readFile(path.join(root, "server-id"), "utf8")).length > 0);
});

test("같은 시각의 중복 실행은 하나로 합친다", async () => {
  const root = await home("a", [peer("a", "linux")]);
  const f = fleet({ a: {} });
  const r = relay(root, f.connect);
  await Promise.all([r.instance.tick(), r.instance.tick()]);
  assert.equal(r.delivered.length, 1);
});

test("폴더 권한은 안쪽 파일까지 상속되게 건다", () => {
  assert.deepEqual(ownerOnlyArguments("C:\\d", "S-1-5-21-1", true).slice(3), ["*S-1-5-21-1:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F"]);
});

test("토큰 복제가 실패해도 액세스 토큰 전달은 계속한다", async () => {
  const root = await home("a", [peer("a", "linux")]);
  const f = fleet({ a: {} });
  const r = relay(root, f.connect, { syncVaults: async () => { throw new Error("vault down"); } });
  await r.instance.tick();
  assert.equal(r.delivered.length, 1);
  assert.ok(r.logs.some((line) => line.includes("토큰 복제 확인 실패")));
  assert.ok(!r.logs.join().includes("vault down"));
});
