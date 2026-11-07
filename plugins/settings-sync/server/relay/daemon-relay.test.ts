import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DaemonRelay, mergePeers, rankPeers, readPeers, savePeers, type PeerClient, type PeerConnection } from "./daemon-relay";

const peer = (serverId: string, platform?: string): PeerConnection => ({
  serverId,
  relayEndpoint: "relay.example.invalid:443",
  useTls: true,
  daemonPublicKeyB64: "synthetic-key",
  ...(platform ? { platform } : {}),
});
async function home(selfId: string, peers: PeerConnection[]) {
  const root = await mkdtemp(path.join(tmpdir(), "daemon-relay-"));
  await writeFile(path.join(root, "server-id"), selfId);
  if (peers.length) await savePeers(root, peers);
  return root;
}
function fleet(answers: Record<string, boolean | "offline" | "silent">) {
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
        return { daemonRelay: { capable: answer } };
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
    relay: (async (peers: { serverId: string }[]) => {
      delivered.push(peers.map((entry) => entry.serverId).sort());
      return { peers: peers.length, changed: 1 };
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

test("접속 정보는 소유자만 읽을 수 있는 파일에 저장되고 손상되면 없는 것으로 처리한다", async () => {
  const root = await home("a", [peer("a")]);
  const file = path.join(root, "settings-sync", "relay-peers.json");
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await readPeers(root)).length, 1);
  await writeFile(file, JSON.stringify([{ serverId: "a", unexpected: true }]));
  assert.deepEqual(await readPeers(root), []);
});

test("가장 앞선 데몬이 전체에 전달한다", async () => {
  const root = await home("a", [peer("a", "linux"), peer("b", "linux"), peer("c", "win32")]);
  const f = fleet({ a: true, b: true, c: true });
  const r = relay(root, f.connect);
  await r.instance.tick();
  assert.deepEqual(r.delivered, [["a", "b", "c"]]);
  const state = await r.instance.snapshot();
  assert.equal(state.role, "leader");
  assert.equal(state.capable, true);
  assert.equal(state.reachable, 3);
  assert.ok(state.activeAt);
});

test("앞선 데몬이 살아 있으면 대기하고 그 연결만 유지한다", async () => {
  const root = await home("b", [peer("a", "linux"), peer("b", "linux"), peer("c", "win32")]);
  const f = fleet({ a: true, b: true, c: true });
  const r = relay(root, f.connect);
  await r.instance.tick();
  assert.deepEqual(r.delivered, []);
  assert.deepEqual(f.connected, ["a"]);
  assert.equal((await r.instance.snapshot()).role, "standby");
});

test("앞선 데몬이 꺼지면 이어받는다", async () => {
  const root = await home("b", [peer("a", "linux"), peer("b", "linux")]);
  const answers: Record<string, boolean | "offline"> = { a: true, b: true };
  const f = fleet(answers);
  let connected = true;
  const r = relay(root, async (target, self) => {
    const client = await f.connect(target);
    return target.serverId === "a"
      ? Object.defineProperty({ ...client }, "isConnected", { get: () => connected }) as PeerClient
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

test("응답만 하고 전달 기능이 없는 호스트에는 양보하지 않는다", async () => {
  const root = await home("b", [peer("a", "linux"), peer("b", "linux")]);
  for (const answer of [false, "silent"] as const) {
    const f = fleet({ a: answer, b: true });
    const r = relay(root, f.connect);
    await r.instance.tick();
    assert.equal((await r.instance.snapshot()).role, "leader");
    r.instance.dispose();
  }
});

test("꺼진 호스트에는 매 분 다시 연결하지 않는다", async () => {
  const root = await home("a", [peer("a", "linux"), peer("b", "win32")]);
  let attempts = 0;
  let now = 1000;
  const f = fleet({ a: true });
  const r = relay(
    root,
    async (target, self) => {
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
  const f = fleet({ a: true });
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

test("오류 로그와 상태에 접속 정보가 나타나지 않는다", async () => {
  const root = await home("a", [peer("a", "linux")]);
  const r = relay(root, async () => {
    throw new Error("relay.example.invalid synthetic-key");
  });
  await r.instance.tick();
  assert.ok(!JSON.stringify([r.logs, await r.instance.snapshot()]).includes("synthetic-key"));
});

test("같은 시각의 중복 실행은 하나로 합친다", async () => {
  const root = await home("a", [peer("a", "linux")]);
  const f = fleet({ a: true });
  const r = relay(root, f.connect);
  await Promise.all([r.instance.tick(), r.instance.tick()]);
  assert.equal(r.delivered.length, 1);
});
