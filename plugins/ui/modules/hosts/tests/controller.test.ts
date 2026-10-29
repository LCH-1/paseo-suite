import assert from "node:assert/strict";
import test from "node:test";
import {
  createController,
  parseOrder,
  projectHosts,
  storageKey,
  type Host,
  type Ordering,
  type Storage,
} from "../client/controller";

function host(serverId: string, label = serverId.toUpperCase()) {
  return {
    serverId,
    label,
    appearance: { color: "none", badgeDisplay: null },
    connections: [{ id: `connection-${serverId}`, endpoint: `example-${serverId}:6767` }],
    preferredConnectionId: `connection-${serverId}`,
    password: `test-only-${serverId}`,
  };
}

function createHarness(initialOrder: string | null = null) {
  const hosts = [host("a"), host("b"), host("c")];
  const hostListeners = new Set<() => void>();
  const store = {
    hosts,
    emissions: 0,
    getHosts() {
      return this.hosts;
    },
    subscribeHostList(listener: () => void) {
      hostListeners.add(listener);
      return () => {
        hostListeners.delete(listener);
      };
    },
    emitHostList() {
      this.emissions++;
      hostListeners.forEach((listener) => listener());
    },
    replaceHosts(next: typeof hosts) {
      this.hosts = next;
      this.emitHostList();
    },
  };
  const ordering: Ordering = {
    orderHostsLocalFirst(input, localServerId) {
      const index = input.findIndex((entry) => entry.serverId === localServerId);
      if (index <= 0) return input;
      const next = input.slice();
      const [local] = next.splice(index, 1);
      next.unshift(local);
      return next;
    },
  };
  const values = new Map<string, string>();
  if (initialOrder !== null) values.set(storageKey, initialOrder);
  const storage = {
    failRead: false as boolean,
    failSave: false as boolean,
    failRemove: false as boolean,
    writes: [] as { key: string; value: string }[],
    removals: [] as string[],
    getItem(key: string) {
      if (this.failRead) throw new Error("Storage read failed");
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (this.failSave) throw new Error("Storage save failed");
      values.set(key, value);
      this.writes.push({ key, value });
    },
    removeItem(key: string) {
      if (this.failRemove) throw new Error("Storage remove failed");
      values.delete(key);
      this.removals.push(key);
    },
  } satisfies Storage & {
    failRead: boolean;
    failSave: boolean;
    failRemove: boolean;
    writes: { key: string; value: string }[];
    removals: string[];
  };
  const originalGetHosts = store.getHosts;
  const originalOrdering = ordering.orderHostsLocalFirst;
  const controller = createController(store, ordering, storage);
  return {
    store,
    ordering,
    storage,
    values,
    controller,
    hostListeners,
    originalGetHosts,
    originalOrdering,
  };
}

function ids(hosts: readonly Host[]) {
  return hosts.map((entry) => entry.serverId);
}

test("parseOrder accepts absent and valid orders and rejects malformed saved values", () => {
  assert.equal(storageKey, "@paseo:host-order");
  assert.equal(parseOrder(null), null);
  assert.deepEqual(parseOrder("[]"), []);
  assert.deepEqual(parseOrder('["b","a"]'), ["b", "a"]);
  for (const value of ["{", "null", "{}", '"a"', '["a","a"]', '[""]', "[1]", '["a",null]']) {
    assert.throws(() => parseOrder(value));
  }
});

test("projectHosts preserves objects, appends unlisted hosts, and ignores removed IDs", () => {
  const hosts = [host("a"), host("b"), host("c")];
  const before = structuredClone(hosts);
  assert.equal(projectHosts(hosts, null), hosts);
  const projected = projectHosts(hosts, ["missing", "c", "a"]);
  assert.deepEqual(ids(projected), ["c", "a", "b"]);
  assert.equal(projected[0], hosts[2]);
  assert.equal(projected[1], hosts[0]);
  assert.equal(projected[2], hosts[1]);
  assert.deepEqual(hosts, before);
});

test("default order retains native local-first behavior and stable snapshots", (t) => {
  const h = createHarness();
  t.after(() => h.controller.dispose());
  const snapshot = h.controller.getSnapshot();
  assert.equal(h.store.getHosts(), h.store.hosts);
  assert.equal(h.store.getHosts(), h.store.getHosts());
  assert.equal(h.controller.getSnapshot(), snapshot);
  assert.equal(snapshot.custom, false);
  assert.equal(snapshot.error, "");
  assert.deepEqual(ids(h.ordering.orderHostsLocalFirst(h.store.getHosts(), "b")), ["b", "a", "c"]);
  h.store.emitHostList();
  assert.equal(h.controller.getSnapshot(), snapshot);
  assert.equal(h.storage.writes.length, 0);
});

test("default settings snapshots and moves start from the displayed local-first order", (t) => {
  const h = createHarness();
  t.after(() => h.controller.dispose());
  h.store.replaceHosts([host("a"), host("local"), host("c")]);
  const before = h.controller.getSnapshot();
  h.controller.setLocalServerId("local");
  const displayed = h.controller.getSnapshot();
  assert.notEqual(displayed, before);
  assert.deepEqual(ids(displayed.hosts), ["local", "a", "c"]);
  assert.equal(displayed.custom, false);
  assert.deepEqual(ids(h.store.getHosts()), ["a", "local", "c"]);
  assert.equal(h.storage.writes.length, 0);
  h.controller.setLocalServerId("local");
  assert.equal(h.controller.getSnapshot(), displayed);
  h.controller.move("local", 1);
  assert.deepEqual(ids(h.controller.getSnapshot().hosts), ["a", "local", "c"]);
  assert.equal(h.controller.getSnapshot().custom, true);
  assert.equal(h.values.get(storageKey), '["a","local","c"]');
  h.controller.setLocalServerId("c");
  assert.deepEqual(ids(h.controller.getSnapshot().hosts), ["a", "local", "c"]);
  h.controller.reset();
  assert.deepEqual(ids(h.controller.getSnapshot().hosts), ["c", "a", "local"]);
  assert.equal(h.controller.getSnapshot().custom, false);
  h.controller.setLocalServerId(null);
  assert.deepEqual(ids(h.controller.getSnapshot().hosts), ["a", "local", "c"]);
});

test("custom mode publishes a fresh stable array even when IDs match the native order", (t) => {
  const h = createHarness('["a","b","c"]');
  t.after(() => h.controller.dispose());
  const custom = h.store.getHosts();
  assert.notEqual(custom, h.store.hosts);
  assert.equal(h.store.getHosts(), custom);
  assert.deepEqual(ids(custom), ["a", "b", "c"]);
  assert.deepEqual(ids(h.ordering.orderHostsLocalFirst(custom, "b")), ["a", "b", "c"]);
  assert.equal(h.controller.getSnapshot().custom, true);
  h.controller.reset();
  assert.equal(h.store.getHosts(), h.store.hosts);
  assert.notEqual(h.store.getHosts(), custom);
  assert.deepEqual(ids(h.ordering.orderHostsLocalFirst(h.store.getHosts(), "b")), ["b", "a", "c"]);
});

test("moving hosts up and down saves only IDs and publishes each successful change once", (t) => {
  const h = createHarness();
  t.after(() => h.controller.dispose());
  let notifications = 0;
  const unsubscribe = h.controller.subscribe(() => {
    notifications++;
  });
  h.controller.move("c", -1);
  assert.deepEqual(ids(h.store.getHosts()), ["a", "c", "b"]);
  assert.deepEqual(parseOrder(h.values.get(storageKey) ?? null), ["a", "c", "b"]);
  assert.equal(h.controller.getSnapshot().custom, true);
  assert.equal(notifications, 1);
  const firstSnapshot = h.store.getHosts();
  h.controller.move("a", 1);
  assert.deepEqual(ids(h.store.getHosts()), ["c", "a", "b"]);
  assert.notEqual(h.store.getHosts(), firstSnapshot);
  assert.equal(h.store.getHosts(), h.store.getHosts());
  assert.equal(notifications, 2);
  assert.deepEqual(h.storage.writes, [
    { key: storageKey, value: '["a","c","b"]' },
    { key: storageKey, value: '["c","a","b"]' },
  ]);
  h.controller.move("c", -1);
  h.controller.move("b", 1);
  h.controller.move("missing", 1);
  assert.equal(h.storage.writes.length, 2);
  assert.equal(notifications, 2);
  unsubscribe();
  h.controller.move("a", -1);
  assert.equal(notifications, 2);
  assert.deepEqual(ids(h.store.getHosts()), ["a", "c", "b"]);
});

test("activating custom order and returning to native IDs still changes the external snapshot", (t) => {
  const h = createHarness();
  t.after(() => h.controller.dispose());
  const native = h.store.getHosts();
  h.controller.move("a", 1);
  h.controller.move("b", 1);
  const custom = h.store.getHosts();
  assert.deepEqual(ids(custom), ids(native));
  assert.notEqual(custom, native);
  assert.equal(h.store.getHosts(), custom);
  assert.deepEqual(ids(h.ordering.orderHostsLocalFirst(custom, "b")), ["a", "b", "c"]);
});

test("dragging a host before or after another persists the same order used by settings", (t) => {
  const h = createHarness();
  t.after(() => h.controller.dispose());
  h.controller.moveTo("a", "c", "after");
  assert.deepEqual(ids(h.store.getHosts()), ["b", "c", "a"]);
  assert.equal(h.values.get(storageKey), '["b","c","a"]');
  h.controller.moveTo("a", "b", "before");
  assert.deepEqual(ids(h.controller.getSnapshot().hosts), ["a", "b", "c"]);
  h.controller.move("c", -1);
  assert.deepEqual(ids(h.store.getHosts()), ["a", "c", "b"]);
});

test("dragging starts from local-first display order and retains hosts outside the filtered sidebar", (t) => {
  const h = createHarness();
  t.after(() => h.controller.dispose());
  h.store.replaceHosts([host("remote"), host("hidden"), host("local"), host("last")]);
  h.controller.setLocalServerId("local");
  h.controller.moveTo("local", "last", "after");
  assert.deepEqual(ids(h.store.getHosts()), ["remote", "hidden", "last", "local"]);
  h.store.replaceHosts([...h.store.hosts, host("new")]);
  assert.deepEqual(ids(h.controller.getSnapshot().hosts), [
    "remote",
    "hidden",
    "last",
    "local",
    "new",
  ]);
});

test("dropping without changing position or onto removed hosts leaves storage and snapshots untouched", (t) => {
  const h = createHarness();
  t.after(() => h.controller.dispose());
  const snapshot = h.controller.getSnapshot();
  for (const [source, target, position] of [
    ["a", "b", "before"],
    ["c", "b", "after"],
    ["a", "a", "after"],
    ["missing", "b", "after"],
    ["a", "missing", "before"],
  ] as const)
    h.controller.moveTo(source, target, position);
  assert.equal(h.controller.getSnapshot(), snapshot);
  assert.equal(h.storage.writes.length, 0);
});

test("sortable host order preserves hidden slots and settings buttons continue from that order", (t) => {
  const h = createHarness();
  t.after(() => h.controller.dispose());
  h.store.replaceHosts([host("a"), host("hidden"), host("b"), host("c")]);
  h.controller.reorder(["c", "a", "b"]);
  assert.deepEqual(ids(h.store.getHosts()), ["c", "hidden", "a", "b"]);
  assert.equal(h.values.get(storageKey), '["c","hidden","a","b"]');
  const writes = h.storage.writes.length;
  h.controller.reorder(["removed", "c", "c", "a", "b"]);
  assert.equal(h.storage.writes.length, writes);
  h.controller.move("c", 1);
  assert.deepEqual(ids(h.store.getHosts()), ["hidden", "c", "a", "b"]);
});

test("a failed drag save leaves host objects and their order intact, and a retry succeeds", (t) => {
  const h = createHarness();
  t.after(() => h.controller.dispose());
  const original = h.store.getHosts();
  h.storage.failSave = true;
  h.controller.moveTo("a", "c", "after");
  assert.equal(h.store.getHosts(), original);
  assert.equal(h.values.has(storageKey), false);
  assert.match(h.controller.getSnapshot().error, /저장/);
  h.storage.failSave = false;
  h.controller.moveTo("a", "c", "after");
  assert.equal(h.store.getHosts()[2], original[0]);
  h.controller.dispose();
  const writes = h.storage.writes.length;
  h.controller.moveTo("c", "a", "before");
  assert.equal(h.storage.writes.length, writes);
});

test("save failure retains the applied order and storage until a retry succeeds", (t) => {
  const h = createHarness('["c","a","b"]');
  t.after(() => h.controller.dispose());
  const applied = h.store.getHosts();
  const stored = h.values.get(storageKey);
  const emissions = h.store.emissions;
  h.storage.failSave = true;
  h.controller.move("c", 1);
  assert.equal(h.store.getHosts(), applied);
  assert.deepEqual(ids(h.controller.getSnapshot().hosts), ["c", "a", "b"]);
  assert.equal(h.controller.getSnapshot().custom, true);
  assert.match(h.controller.getSnapshot().error, /저장/);
  assert.equal(h.values.get(storageKey), stored);
  assert.equal(h.store.emissions, emissions);
  assert.deepEqual(ids(h.ordering.orderHostsLocalFirst(applied, "b")), ["c", "a", "b"]);
  h.storage.failSave = false;
  h.controller.move("c", 1);
  assert.deepEqual(ids(h.store.getHosts()), ["a", "c", "b"]);
  assert.equal(h.controller.getSnapshot().error, "");
});

test("failed reset retains custom order and successful reset restores native behavior", (t) => {
  const h = createHarness('["c","a","b"]');
  t.after(() => h.controller.dispose());
  const custom = h.store.getHosts();
  h.storage.failRemove = true;
  h.controller.reset();
  assert.equal(h.store.getHosts(), custom);
  assert.equal(h.controller.getSnapshot().custom, true);
  assert.match(h.controller.getSnapshot().error, /저장/);
  assert.equal(h.values.get(storageKey), '["c","a","b"]');
  h.storage.failRemove = false;
  h.controller.reset();
  assert.equal(h.store.getHosts(), h.store.hosts);
  assert.equal(h.controller.getSnapshot().custom, false);
  assert.equal(h.controller.getSnapshot().error, "");
  assert.equal(h.values.has(storageKey), false);
  assert.deepEqual(h.storage.removals, [storageKey]);
  assert.deepEqual(ids(h.ordering.orderHostsLocalFirst(h.store.getHosts(), "b")), ["b", "a", "c"]);
});

test("reload applies external changes and clearing storage restores default order", (t) => {
  const h = createHarness();
  t.after(() => h.controller.dispose());
  h.values.set(storageKey, '["b","c","a"]');
  h.controller.reload();
  assert.deepEqual(ids(h.store.getHosts()), ["b", "c", "a"]);
  assert.equal(h.controller.getSnapshot().custom, true);
  assert.equal(h.storage.writes.length, 0);
  h.values.delete(storageKey);
  h.controller.reload();
  assert.equal(h.store.getHosts(), h.store.hosts);
  assert.equal(h.controller.getSnapshot().custom, false);
  assert.equal(h.storage.removals.length, 0);
});

test("invalid or unavailable external storage preserves the last applied order until reset", (t) => {
  const h = createHarness('["c","a","b"]');
  t.after(() => h.controller.dispose());
  h.values.set(storageKey, '["a","a"]');
  h.controller.reload();
  assert.deepEqual(ids(h.store.getHosts()), ["c", "a", "b"]);
  assert.equal(h.controller.getSnapshot().custom, true);
  assert.match(h.controller.getSnapshot().error, /읽을 수 없습니다/);
  h.storage.failRead = true;
  h.controller.reload();
  assert.deepEqual(ids(h.store.getHosts()), ["c", "a", "b"]);
  assert.match(h.controller.getSnapshot().error, /읽을 수 없습니다/);
  h.storage.failRead = false;
  h.controller.reset();
  assert.equal(h.controller.getSnapshot().custom, false);
  assert.equal(h.controller.getSnapshot().error, "");
});

test("invalid initial storage leaves native order usable and can be reset", (t) => {
  const h = createHarness("not-json");
  t.after(() => h.controller.dispose());
  assert.equal(h.store.getHosts(), h.store.hosts);
  assert.equal(h.controller.getSnapshot().custom, false);
  assert.match(h.controller.getSnapshot().error, /읽을 수 없습니다/);
  h.controller.reset();
  assert.equal(h.controller.getSnapshot().error, "");
  assert.equal(h.values.has(storageKey), false);
});

test("host additions, removals, and label changes stay live without rewriting stored order", (t) => {
  const h = createHarness('["c","a","b"]');
  t.after(() => h.controller.dispose());
  const before = h.store.getHosts();
  h.store.replaceHosts([...h.store.hosts, host("d")]);
  assert.deepEqual(ids(h.store.getHosts()), ["c", "a", "b", "d"]);
  assert.notEqual(h.store.getHosts(), before);
  assert.equal(h.store.getHosts(), h.store.getHosts());
  h.store.replaceHosts(h.store.hosts.filter((entry) => entry.serverId !== "a"));
  assert.deepEqual(ids(h.store.getHosts()), ["c", "b", "d"]);
  h.store.replaceHosts(
    h.store.hosts.map((entry) =>
      entry.serverId === "b" ? { ...entry, label: "Renamed host" } : entry,
    ),
  );
  assert.deepEqual(h.controller.getSnapshot().hosts, [
    { serverId: "c", label: "C" },
    { serverId: "b", label: "Renamed host" },
    { serverId: "d", label: "D" },
  ]);
  assert.equal(h.values.get(storageKey), '["c","a","b"]');
  assert.equal(h.storage.writes.length, 0);
});

test("ordering arbitrary host subsets honors custom order and retains unknown hosts", (t) => {
  const h = createHarness('["c","a","b"]');
  t.after(() => h.controller.dispose());
  const subset = [h.store.hosts[1], host("d"), h.store.hosts[2]];
  assert.deepEqual(ids(h.ordering.orderHostsLocalFirst(subset, "b")), ["c", "b", "d"]);
  assert.deepEqual(ids(subset), ["b", "d", "c"]);
});

test("reordering preserves all host objects and connection fields and exposes only summaries", (t) => {
  const h = createHarness();
  t.after(() => h.controller.dispose());
  const raw = h.store.hosts;
  const before = structuredClone(raw);
  const connections = raw.map((entry) => entry.connections);
  const appearance = raw.map((entry) => entry.appearance);
  raw.forEach((entry) => {
    Object.freeze(entry.connections[0]);
    Object.freeze(entry.connections);
    Object.freeze(entry.appearance);
    Object.freeze(entry);
  });
  Object.freeze(raw);
  h.controller.move("c", -1);
  h.controller.move("a", 1);
  assert.equal(h.store.hosts, raw);
  assert.deepEqual(raw, before);
  assert.deepEqual(h.store.getHosts(), [raw[2], raw[0], raw[1]]);
  for (const [index, entry] of raw.entries()) {
    assert.equal(entry.connections, connections[index]);
    assert.equal(entry.appearance, appearance[index]);
    assert.ok(h.store.getHosts().includes(entry));
  }
  for (const entry of h.controller.getSnapshot().hosts) {
    assert.deepEqual(Object.keys(entry).sort(), ["label", "serverId"]);
  }
  assert.equal(
    h.storage.writes.some((write) => write.value.includes("connection")),
    false,
  );
  assert.equal(
    h.storage.writes.some((write) => write.value.includes("test-only")),
    false,
  );
});

test("dispose restores methods and subscriptions once and ignores later mutations", () => {
  const h = createHarness('["c","a","b"]');
  let notifications = 0;
  h.controller.subscribe(() => {
    notifications++;
  });
  assert.equal(h.hostListeners.size, 1);
  h.controller.dispose();
  assert.equal(h.store.getHosts, h.originalGetHosts);
  assert.equal(h.ordering.orderHostsLocalFirst, h.originalOrdering);
  assert.equal(h.hostListeners.size, 0);
  assert.equal(h.store.getHosts(), h.store.hosts);
  assert.deepEqual(ids(h.ordering.orderHostsLocalFirst(h.store.getHosts(), "b")), ["b", "a", "c"]);
  const emissions = h.store.emissions;
  h.controller.dispose();
  h.controller.move("a", 1);
  h.controller.reset();
  h.controller.reload();
  assert.equal(h.store.emissions, emissions);
  assert.equal(h.storage.writes.length, 0);
  assert.equal(h.storage.removals.length, 0);
  assert.equal(notifications, 0);
  assert.equal(h.values.get(storageKey), '["c","a","b"]');
});

test("dispose preserves methods installed by another adapter", () => {
  const h = createHarness('["c","a","b"]');
  const replacementGetHosts = () => h.store.hosts;
  const replacementOrdering = (input: Host[]) => input;
  h.store.getHosts = replacementGetHosts;
  h.ordering.orderHostsLocalFirst = replacementOrdering;
  h.controller.dispose();
  assert.equal(h.store.getHosts, replacementGetHosts);
  assert.equal(h.ordering.orderHostsLocalFirst, replacementOrdering);
  assert.equal(h.hostListeners.size, 0);
});

test("dispose deactivates wrappers retained by another adapter", () => {
  const h = createHarness('["c","a","b"]');
  const getHosts = h.store.getHosts.bind(h.store);
  const sortHosts = h.ordering.orderHostsLocalFirst;
  h.store.getHosts = () => getHosts();
  h.ordering.orderHostsLocalFirst = (input, local) => sortHosts(input, local);
  h.controller.dispose();
  assert.equal(h.store.getHosts(), h.store.hosts);
  assert.deepEqual(ids(h.ordering.orderHostsLocalFirst(h.store.getHosts(), "b")), ["b", "a", "c"]);
});
