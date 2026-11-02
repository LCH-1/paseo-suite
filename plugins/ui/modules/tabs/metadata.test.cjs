const assert = require("node:assert/strict");
const { setImmediate } = require("node:timers/promises");
const test = require("node:test");
const { createModel, STORAGE_KEY } = require("./model.js");
const { createLoader } = require("./metadata.js");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function harness(refresh, entries = [{ serverId: "host", workspaceId: "workspace", tabId: "tab", agentId: "agent" }]) {
  const data = new Map([[STORAGE_KEY, JSON.stringify({ entries })]]);
  const model = createModel({ getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value),
    get length() { return data.size; }, key: index => [...data.keys()][index] ?? null });
  const listeners = new Set();
  const calls = [];
  const session = { client: { isConnected: true }, clientGeneration: 1, agents: new Map(), agentDetails: new Map(),
    workspaces: new Map([["other-workspace", {}]]), hasHydratedAgents: true, hasHydratedWorkspaces: false };
  const state = { sessions: { host: session }, setAgentDetails(serverId, update) {
    const target = state.sessions[serverId];
    target.agentDetails = update(target.agentDetails);
    emit();
  } };
  function emit() { listeners.forEach((listener) => listener(state)); }
  const sessions = Object.assign(() => {}, { getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } });
  const loader = createLoader({ model, sessions,
    getPaseoClient(serverId) { return { agents: { ref(agentId) { return { refresh() {
      calls.push([serverId, agentId]); return refresh(serverId, agentId);
    } }; } } }; },
    normalizeAgentSnapshot: (agent, serverId) => ({ ...agent, serverId, pendingPermissions: [] }),
  });
  return { model, loader, calls, session, state, emit, listeners, saved: () => JSON.parse(data.get(STORAGE_KEY)) };
}
const result = (title = "복원된 대화") => ({ agent: { id: "agent", workspaceId: "workspace", title }, project: { workspaceId: "workspace" } });

test("unrelated session updates do not rewrite unchanged cached titles while renamed titles still update", async () => {
  const app = harness(async () => result());
  await setImmediate();
  const rememberTitle = app.model.rememberTitle;
  let updates = 0;
  app.model.rememberTitle = (...args) => { updates++; rememberTitle(...args); };
  for (let index = 0; index < 20; index++) {
    app.emit();
    await setImmediate();
  }
  assert.equal(updates, 0);
  app.session.agentDetails.set("agent", { ...app.session.agentDetails.get("agent"), title: "바뀐 제목" });
  app.emit();
  await setImmediate();
  assert.equal(updates, 1);
  assert.equal(app.model.entries()[0].title, "바뀐 제목");
  app.loader.dispose();
});

test("restored inactive tab fetches metadata without reading history or replacing the active directory", async () => {
  const app = harness(async () => result());
  await setImmediate();
  assert.deepEqual(app.calls, [["host", "agent"]]);
  assert.equal(app.session.agentDetails.get("agent").title, "복원된 대화");
  assert.equal(app.session.agents.size, 0);
  assert.equal(app.saved().entries[0].title, "복원된 대화");
  assert.equal(app.model.entries().length, 1);
  assert.equal(app.loader.state(app.model.entries()[0]).tag, "ready");
  app.emit();
  await setImmediate();
  assert.equal(app.calls.length, 1);
  app.loader.dispose();
});

test("deduplicates metadata requests for two retained tabs of one agent", async () => {
  const app = harness(async () => result(), [
    { serverId: "host", workspaceId: "workspace", tabId: "one", agentId: "agent" },
    { serverId: "host", workspaceId: "workspace", tabId: "two", agentId: "agent" },
  ]);
  await setImmediate();
  assert.equal(app.calls.length, 1);
  assert.equal(app.saved().entries.length, 1);
  assert.ok(app.saved().entries.every((entry) => entry.title === "복원된 대화"));
  app.loader.dispose();
});

test("an authoritative null lookup ends loading without deleting the saved tab", async () => {
  const app = harness(async () => null);
  await setImmediate();
  const entry = app.model.entries()[0];
  assert.equal(app.loader.state(entry).tag, "missing");
  app.emit();
  await setImmediate();
  assert.equal(app.calls.length, 1);
  assert.equal(app.model.entries().length, 1);
  assert.equal(app.saved().entries[0].agentId, "agent");
  app.loader.dispose();
});

test("waits for an offline host and retries after reconnect", async () => {
  const app = harness(async () => result());
  app.session.client.isConnected = false;
  await setImmediate();
  assert.equal(app.calls.length, 0);
  assert.equal(app.loader.state(app.model.entries()[0]).tag, "waiting");
  app.session.client = { isConnected: true };
  app.session.clientGeneration++;
  app.emit();
  await setImmediate();
  assert.equal(app.calls.length, 1);
  assert.equal(app.loader.state(app.model.entries()[0]).tag, "ready");
  app.loader.dispose();
});

test("ignores an old connection response and accepts metadata from its replacement", async () => {
  const first = deferred();
  const second = deferred();
  let count = 0;
  const app = harness(() => (++count === 1 ? first.promise : second.promise));
  await setImmediate();
  app.session.client = { isConnected: true };
  app.session.clientGeneration++;
  app.emit();
  await setImmediate();
  first.resolve(result("오래된 이름"));
  await setImmediate();
  assert.equal(app.session.agentDetails.size, 0);
  second.resolve(result("최신 이름"));
  await setImmediate();
  assert.equal(app.session.agentDetails.get("agent").title, "최신 이름");
  app.loader.dispose();
});

test("does not overwrite a newer snapshot received while metadata is loading", async () => {
  const pending = deferred();
  const app = harness(() => pending.promise);
  await setImmediate();
  app.session.agents.set("agent", { id: "agent", title: "실시간 이름" });
  app.emit();
  pending.resolve(result("이전 이름"));
  await setImmediate();
  assert.equal(app.session.agentDetails.size, 0);
  assert.equal(app.saved().entries[0].title, "실시간 이름");
  app.loader.dispose();
});

test("authoritative workspace metadata repairs retained ownership without a permanent mismatch", async () => {
  const mismatch = result();
  mismatch.agent.workspaceId = "other-workspace";
  const app = harness(async () => mismatch);
  await setImmediate();
  assert.equal(app.loader.state(app.model.entries()[0]).tag, "ready");
  assert.equal(app.session.agentDetails.get("agent").workspaceId, "other-workspace");
  assert.equal(app.model.entries()[0].workspaceId, "other-workspace");
  assert.equal(app.saved().entries.length, 1);
  app.emit();
  await setImmediate();
  assert.equal(app.calls.length, 1);
  app.loader.dispose();
});

test("a different response agent is rejected without changing ownership", async () => {
  const mismatch = result();
  mismatch.agent.id = "other-agent";
  const app = harness(async () => mismatch);
  await setImmediate();
  assert.equal(app.loader.state(app.model.entries()[0]).tag, "mismatch");
  assert.equal(app.session.agentDetails.size, 0);
  assert.equal(app.model.entries()[0].workspaceId, "workspace");
  assert.equal(app.saved().entries.length, 1);
  app.loader.dispose();
});

test("authoritative archived metadata survives workspace correction and deduplication", async () => {
  const snapshot = result();
  snapshot.agent.workspaceId = "removed-workspace";
  snapshot.agent.archivedAt = "2026-10-23T00:00:00Z";
  const app = harness(async () => snapshot, [
    { serverId: "host", workspaceId: "stale-one", tabId: "one", agentId: "agent" },
    { serverId: "host", workspaceId: "stale-two", tabId: "two", agentId: "agent" },
  ]);
  await setImmediate();
  assert.equal(app.calls.length, 1);
  assert.equal(app.model.entries().length, 1);
  assert.equal(app.model.entries()[0].workspaceId, "removed-workspace");
  assert.equal(app.session.agentDetails.get("agent").archivedAt, snapshot.agent.archivedAt);
  assert.equal(app.loader.state(app.model.entries()[0]).tag, "ready");
  app.loader.dispose();
});

test("metadata failures preserve entries and retry once on a new connection", async (t) => {
  t.mock.method(console, "warn", () => {});
  let count = 0;
  const app = harness(async () => { if (++count === 1) throw new Error("offline"); return result(); });
  await setImmediate();
  assert.equal(app.loader.state(app.model.entries()[0]).tag, "error");
  app.emit();
  await setImmediate();
  assert.equal(count, 1);
  app.session.clientGeneration++;
  app.emit();
  await setImmediate();
  assert.equal(count, 2);
  assert.equal(app.loader.state(app.model.entries()[0]).tag, "ready");
  app.loader.dispose();
});

test("dispose cancels local subscriptions and ignores in-flight metadata", async () => {
  const pending = deferred();
  const app = harness(() => pending.promise);
  await setImmediate();
  app.loader.dispose();
  pending.resolve(result());
  await setImmediate();
  assert.equal(app.listeners.size, 0);
  assert.equal(app.session.agentDetails.size, 0);
  assert.equal(app.saved().entries[0].title, undefined);
});

test("bounds parallel metadata work at four requests without polling", async () => {
  const pending = Array.from({ length: 7 }, deferred);
  let count = 0;
  const entries = pending.map((_item, i) => ({ serverId: "host", workspaceId: "workspace", tabId: "tab-" + i, agentId: "agent-" + i }));
  const app = harness(() => pending[count++].promise, entries);
  await setImmediate();
  assert.equal(count, 4);
  pending.slice(0, 4).forEach((item) => item.resolve(null));
  await setImmediate();
  assert.equal(count, 7);
  pending.slice(4).forEach((item) => item.resolve(null));
  await setImmediate();
  assert.equal(app.saved().entries.length, 7);
  assert.equal(count, 7);
  app.loader.dispose();
});
