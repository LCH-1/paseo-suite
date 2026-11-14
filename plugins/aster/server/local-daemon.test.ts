import assert from "node:assert/strict";
import test from "node:test";
import type { Connection } from "./legacy-credential-rpc";
import { closeLocalDaemons, LocalDaemon, localDaemon } from "./local-daemon";

/** What the client says when the socket went away before an answer (as DaemonClient does). */
const lost = () =>
  Object.assign(Error("Transport closed (code 1006)"), {
    code: "DAEMON_CONNECTION_LOST",
  });

/**
 * Connections as the daemon's address file would open them. Each one counts its connects and
 * closes; `next` decides how the next opened connection answers.
 */
function daemonFixture() {
  const opened: Array<{ connects: number; closes: number; asked: string[] }> =
    [];
  let connect: (index: number) => Promise<void> = async () => {};
  let answer: (method: string, index: number) => Promise<unknown> = async (
    method,
  ) => ({ method });
  let creates = 0,
    failCreate = false;
  const create = async () => {
    creates++;
    if (failCreate) throw Error("ENOENT paseo.pid");
    const index = opened.length;
    const state = { connects: 0, closes: 0, asked: [] as string[] };
    opened.push(state);
    return {
      connect: async () => {
        state.connects++;
        await connect(index);
      },
      close: () => {
        state.closes++;
      },
      invokePluginRpc: async (_plugin: string, method: string) => {
        state.asked.push(method);
        return answer(method, index);
      },
    } as unknown as Connection;
  };
  return {
    opened,
    create,
    creates: () => creates,
    onConnect: (action: typeof connect) => {
      connect = action;
    },
    onAsk: (action: typeof answer) => {
      answer = action;
    },
    failCreate: (value: boolean) => {
      failCreate = value;
    },
  };
}
const ask = (daemon: LocalDaemon, method: string, signal?: AbortSignal) =>
  daemon.use((client) => client.invokePluginRpc("plugin", method, {}), {
    signal,
  });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("로컬 데몬 연결은 처음 물을 때 열고, 이어지는 호출과 동시에 묻는 호출이 모두 그 한 연결을 쓴다", async () => {
  const fixture = daemonFixture();
  const daemon = new LocalDaemon("synthetic", fixture.create);
  try {
    assert.equal(fixture.creates(), 0);
    for (const method of ["profiles", "usage", "profiles"])
      assert.deepEqual(await ask(daemon, method), { method });
    await Promise.all(["a", "b", "c"].map((method) => ask(daemon, method)));
    assert.equal(fixture.creates(), 1);
    assert.deepEqual(fixture.opened[0].asked, [
      "profiles",
      "usage",
      "profiles",
      "a",
      "b",
      "c",
    ]);
    assert.equal(fixture.opened[0].closes, 0);
  } finally {
    daemon.close();
  }
  assert.equal(fixture.opened[0].closes, 1);
});

test("질문 중 연결이 끊기면 새 연결로 한 번만 다시 묻고, 데몬이 답한 거절은 다시 묻지 않으며 연결도 그대로 둔다", async () => {
  const fixture = daemonFixture();
  const daemon = new LocalDaemon("synthetic", fixture.create);
  try {
    await ask(daemon, "warm");
    // The daemon drops the socket while the question is out: asked again once, on a new connection.
    fixture.onAsk(async (method, index) => {
      if (index === 0) throw lost();
      return { method, index };
    });
    assert.deepEqual(await ask(daemon, "profiles"), {
      method: "profiles",
      index: 1,
    });
    assert.equal(fixture.creates(), 2);
    assert.equal(fixture.opened[0].closes, 1);
    // Lost again on the new one as well: the caller learns of it, with no third attempt.
    fixture.onAsk(async () => {
      throw lost();
    });
    await assert.rejects(ask(daemon, "usage"), /Transport closed/);
    assert.equal(fixture.creates(), 3);
    // A refusal is the daemon's answer: not asked again, and the connection stays.
    fixture.onAsk(async () => {
      throw Error(
        "Plugin claude-usage-source does not contribute RPC claude.profiles.read.request",
      );
    });
    await assert.rejects(ask(daemon, "profiles"), /does not contribute/);
    const before = fixture.creates();
    await assert.rejects(ask(daemon, "profiles"), /does not contribute/);
    assert.equal(fixture.creates(), before);
    assert.equal(fixture.opened.at(-1)!.asked.length, 2);
  } finally {
    daemon.close();
  }
});

test("끊긴 연결은 다음 호출에서 다시 붙고, 다시 붙지 못하면 데몬 주소를 다시 읽어 한 번 더 열며, 처음부터 열리지 않으면 그대로 실패한다", async () => {
  const fixture = daemonFixture();
  const daemon = new LocalDaemon("synthetic", fixture.create);
  try {
    // Not running yet (no address published): the caller fails, and nothing is kept.
    fixture.failCreate(true);
    await assert.rejects(ask(daemon, "early"), /paseo\.pid/);
    fixture.failCreate(false);
    fixture.onConnect(async (index) => {
      if (index === 0) throw Error("connect ECONNREFUSED");
    });
    await assert.rejects(ask(daemon, "early"), /ECONNREFUSED/);
    assert.equal(fixture.creates(), 2);

    fixture.onConnect(async () => {});
    await ask(daemon, "first");
    const kept = fixture.opened.at(-1)!;
    // Each call connects again: a connection the daemon dropped while idle is opened again there.
    await ask(daemon, "second");
    assert.equal(kept.connects, 2);
    assert.equal(fixture.creates(), 3);

    // The daemon restarted elsewhere: the kept connection cannot reach it, a fresh read can.
    const restartedAt = fixture.opened.length;
    fixture.onConnect(async (index) => {
      if (index < restartedAt) throw Error("connect ECONNREFUSED");
    });
    assert.deepEqual(await ask(daemon, "after restart"), {
      method: "after restart",
    });
    assert.equal(fixture.creates(), 4);
    assert.equal(kept.closes, 1);
  } finally {
    daemon.close();
  }
});

test("기다리기를 그만둔 호출(취소·시간 초과)은 같은 연결의 다른 호출을 끊지 않는다", async () => {
  const fixture = daemonFixture();
  const daemon = new LocalDaemon("synthetic", fixture.create);
  const answers: Array<() => void> = [];
  fixture.onAsk(
    (method) =>
      new Promise((resolve) => answers.push(() => resolve({ method }))),
  );
  try {
    const stopped = new AbortController();
    const abandoned = ask(daemon, "abandoned", stopped.signal);
    const late = daemon.use(
      (client) => client.invokePluginRpc("plugin", "late", {}),
      { timeoutMs: 20 },
    );
    const waiting = ask(daemon, "waiting");
    for (let turn = 0; turn < 20 && answers.length < 3; turn++) await tick();
    stopped.abort(Error("synthetic stop"));
    await assert.rejects(abandoned, /synthetic stop/);
    await assert.rejects(late, (error: Error) => error.name === "TimeoutError");
    for (const answer of answers) answer();
    assert.deepEqual(await waiting, { method: "waiting" });
    assert.equal(fixture.creates(), 1);
    assert.equal(fixture.opened[0].closes, 0);
    // An aborted caller is refused before anything is asked.
    await assert.rejects(
      ask(daemon, "never", stopped.signal),
      /synthetic stop/,
    );
    assert.deepEqual(fixture.opened[0].asked, ["abandoned", "late", "waiting"]);
  } finally {
    daemon.close();
  }
});

test("쓰지 않는 연결은 정해진 시간 뒤 닫고 다음 호출에서 다시 연다", async () => {
  const fixture = daemonFixture();
  const daemon = new LocalDaemon("synthetic", fixture.create, 30);
  try {
    await ask(daemon, "first");
    await ask(daemon, "soon after");
    assert.equal(fixture.opened[0].closes, 0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(fixture.opened[0].closes, 1);
    await ask(daemon, "later");
    assert.equal(fixture.creates(), 2);
  } finally {
    daemon.close();
  }
});

test("해제되면 연결을 닫고, 연결 중인 호출도 멈춘 채 남기지 않으며 다시 열지 않는다", async () => {
  const fixture = daemonFixture();
  const daemon = new LocalDaemon("synthetic", fixture.create);
  fixture.onConnect(() => new Promise(() => {}));
  const connecting = ask(daemon, "never connects");
  for (let turn = 0; turn < 5; turn++) await tick();
  daemon.close();
  await assert.rejects(connecting, /해제/);
  assert.equal(fixture.opened[0].closes, 1);
  await assert.rejects(ask(daemon, "after"), /해제/);
  assert.equal(fixture.creates(), 1);
});

test("한 프로세스는 데몬 폴더마다 연결 하나를 함께 쓰고, 플러그인이 멈추면 모두 닫고 다시 열지 않는다", async () => {
  const first = localDaemon("synthetic-home");
  assert.equal(localDaemon("synthetic-home"), first);
  assert.notEqual(localDaemon("other-home"), first);
  closeLocalDaemons();
  await assert.rejects(ask(first, "after"), /해제/);
  await assert.rejects(ask(localDaemon("new-home"), "after"), /해제/);
});
