import assert from "node:assert/strict";
import test from "node:test";
import { acquireController } from "../client/bridge";
import { storageKey, type Host } from "../client/controller";
import moduleMaps from "../client/module-maps";

function createHarness(initialOrder: string | null = null) {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  function setGlobal(key: string, value: unknown) {
    if (!descriptors.has(key))
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const hosts = ["a", "b", "c"].map((serverId) => ({ serverId, label: serverId.toUpperCase() }));
  const hostListeners = new Set<() => void>();
  const store = {
    reorderHosts: undefined as ((serverIds: readonly string[]) => void) | undefined,
    emissions: 0,
    getHosts() {
      return hosts;
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
  };
  const ordering = {
    orderHostsLocalFirst(input: Host[], localServerId: string | null) {
      const index = input.findIndex((host) => host.serverId === localServerId);
      if (index <= 0) return input;
      const next = input.slice();
      const [local] = next.splice(index, 1);
      next.unshift(local);
      return next;
    },
  };
  const originalGetHosts = store.getHosts;
  const originalOrdering = ordering.orderHostsLocalFirst;
  const values = new Map<string, string>();
  if (initialOrder !== null) values.set(storageKey, initialOrder);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const target = new EventTarget();
  const storageListeners = new Set<EventListener>();
  setGlobal("addEventListener", (type: string, listener: EventListener) => {
    if (type === "storage") storageListeners.add(listener);
    target.addEventListener(type, listener);
  });
  setGlobal("removeEventListener", (type: string, listener: EventListener) => {
    if (type === "storage") storageListeners.delete(listener);
    target.removeEventListener(type, listener);
  });
  const scripts = [{ src: `paseo://app/_expo/static/js/web/${moduleMaps[0].bundle}?cache=1` }];
  setGlobal("document", { scripts });
  setGlobal("localStorage", storage);
  setGlobal("__PASEO_HOST_ORDER__", undefined);
  const required: number[] = [];
  setGlobal("__r", (id: number) => {
    required.push(id);
    if (id === moduleMaps[0].runtime) return { getHostRuntimeStore: () => store };
    if (id === moduleMaps[0].ordering) return ordering;
    if (id === moduleMaps[0].desktop) return { shouldUseDesktopDaemon: () => false };
    throw new Error(`Unexpected module ${id}`);
  });
  const leases: ReturnType<typeof acquireController>[] = [];
  return {
    store,
    ordering,
    values,
    storage,
    scripts,
    required,
    hostListeners,
    storageListeners,
    originalGetHosts,
    originalOrdering,
    acquire(
      attachSidebar?: Parameters<typeof acquireController>[0],
      resolvedIds?: Parameters<typeof acquireController>[1],
    ) {
      const lease = acquireController(attachSidebar, resolvedIds);
      leases.push(lease);
      return lease;
    },
    dispatchStorage(key: string | null, storageArea: unknown = storage) {
      const event = new Event("storage");
      Object.defineProperties(event, { key: { value: key }, storageArea: { value: storageArea } });
      target.dispatchEvent(event);
    },
    restore() {
      leases.forEach((lease) => lease.release());
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

function ids(hosts: readonly Host[]) {
  return hosts.map((host) => host.serverId);
}

test("sidebar drag listeners share the controller lifetime and detach after the final release", (t) => {
  const h = createHarness();
  t.after(() => h.restore());
  let attached = 0;
  let detached = 0;
  const first = h.acquire((controller) => {
    attached++;
    assert.ok(controller.moveTo);
    return () => {
      detached++;
    };
  });
  const second = h.acquire(() => {
    throw new Error("Must not attach twice");
  });
  assert.equal(attached, 1);
  first.release();
  assert.equal(detached, 0);
  second.release();
  second.release();
  assert.equal(detached, 1);
});

test("native sortable hosts share saved order and never attach the legacy HTML drag adapter", (t) => {
  const h = createHarness();
  t.after(() => h.restore());
  const native = () => {
    throw new Error("Plugin owns persistence while installed");
  };
  h.store.reorderHosts = native;
  const lease = h.acquire(() => {
    throw new Error("Native sortable must not install HTML drag");
  });
  h.store.reorderHosts(["c", "a", "b"]);
  assert.deepEqual(ids(h.store.getHosts()), ["c", "a", "b"]);
  assert.equal(h.values.get(storageKey), '["c","a","b"]');
  lease.release();
  assert.equal(h.store.reorderHosts, native);
});

test("multiple installations share one controller until the last owner releases it", (t) => {
  const h = createHarness('["c","a","b"]');
  t.after(() => h.restore());
  const first = h.acquire();
  const second = h.acquire();
  assert.ok(first.controller);
  assert.equal(second.controller, first.controller);
  assert.deepEqual(h.required, [
    moduleMaps[0].runtime,
    moduleMaps[0].ordering,
    moduleMaps[0].desktop,
  ]);
  assert.equal(h.storageListeners.size, 1);
  assert.equal(h.hostListeners.size, 1);
  assert.deepEqual(ids(h.store.getHosts()), ["c", "a", "b"]);
  first.release();
  first.release();
  assert.notEqual(h.store.getHosts, h.originalGetHosts);
  assert.equal(h.storageListeners.size, 1);
  second.controller?.move("c", 1);
  assert.deepEqual(ids(h.store.getHosts()), ["a", "c", "b"]);
  second.release();
  assert.equal(h.store.getHosts, h.originalGetHosts);
  assert.equal(h.ordering.orderHostsLocalFirst, h.originalOrdering);
  assert.equal(h.storageListeners.size, 0);
  assert.equal(h.hostListeners.size, 0);
  const emissions = h.store.emissions;
  second.release();
  assert.equal(h.store.emissions, emissions);
  const restarted = h.acquire();
  assert.ok(restarted.controller);
  assert.notEqual(restarted.controller, first.controller);
  assert.deepEqual(ids(h.store.getHosts()), ["a", "c", "b"]);
});

test("storage events apply matching changes and stop listening after release", (t) => {
  const h = createHarness();
  t.after(() => h.restore());
  const lease = h.acquire();
  assert.ok(lease.controller);
  const initial = lease.controller.getSnapshot();
  h.values.set(storageKey, '["c","a","b"]');
  h.dispatchStorage("another-setting");
  h.dispatchStorage(storageKey, {});
  assert.equal(lease.controller.getSnapshot(), initial);
  h.dispatchStorage(storageKey);
  assert.deepEqual(ids(h.store.getHosts()), ["c", "a", "b"]);
  assert.equal(lease.controller.getSnapshot().custom, true);
  h.values.clear();
  h.dispatchStorage(null);
  assert.deepEqual(ids(h.store.getHosts()), ["a", "b", "c"]);
  assert.equal(lease.controller.getSnapshot().custom, false);
  lease.release();
  const emissions = h.store.emissions;
  h.values.set(storageKey, '["b","c","a"]');
  h.dispatchStorage(storageKey);
  assert.equal(h.store.emissions, emissions);
  assert.equal(h.storageListeners.size, 0);
  assert.deepEqual(ids(h.store.getHosts()), ["a", "b", "c"]);
});

test("unsupported bundles leave host runtime untouched and return an inert lease", (t) => {
  const h = createHarness('["c","a","b"]');
  t.after(() => h.restore());
  h.scripts[0].src = "paseo://app/_expo/static/js/web/index-unsupported.js";
  const lease = h.acquire();
  assert.equal(lease.controller, null);
  assert.deepEqual(h.required, []);
  assert.equal(h.store.getHosts, h.originalGetHosts);
  assert.equal(h.ordering.orderHostsLocalFirst, h.originalOrdering);
  assert.equal(h.storageListeners.size, 0);
  assert.equal(h.hostListeners.size, 0);
  assert.equal(h.store.emissions, 0);
  lease.release();
  lease.release();
  assert.equal(h.store.emissions, 0);
  assert.equal(h.values.get(storageKey), '["c","a","b"]');
});

test("a newly resolved app map enables ordering even when the bundle is absent from the static list", (t) => {
  const h = createHarness();
  t.after(() => h.restore());
  h.scripts[0].src = "paseo://app/index-new-build.js";
  const lease = h.acquire(undefined, { ...moduleMaps[0], bundle: "index-new-build.js" });
  assert.ok(lease.controller);
  lease.controller.moveTo("a", "c", "after");
  assert.deepEqual(ids(h.store.getHosts()), ["b", "c", "a"]);
  assert.equal(h.values.get(storageKey), '["b","c","a"]');
});

test("a failed sidebar adapter rolls back wrappers and subscribers before a clean retry", (t) => {
  const h = createHarness();
  t.after(() => h.restore());
  assert.throws(() => h.acquire(() => { throw new Error("adapter failed"); }), /adapter failed/);
  assert.equal(h.store.getHosts, h.originalGetHosts);
  assert.equal(h.ordering.orderHostsLocalFirst, h.originalOrdering);
  assert.equal(h.hostListeners.size, 0);
  assert.equal(h.storageListeners.size, 0);
  assert.equal(Reflect.get(globalThis, "__PASEO_HOST_ORDER__"), undefined);
  const lease = h.acquire(() => () => {});
  lease.release();
  assert.equal(h.store.getHosts, h.originalGetHosts);
  assert.equal(h.hostListeners.size, 0);
});

test("storage listener initialization failure also detaches the already installed sidebar", (t) => {
  const h = createHarness();
  t.after(() => h.restore());
  let detached = 0;
  Object.defineProperty(globalThis, "addEventListener", { configurable: true, value: () => { throw new Error("storage listener failed"); } });
  assert.throws(() => h.acquire(() => () => { detached++; }), /storage listener failed/);
  assert.equal(detached, 1);
  assert.equal(h.store.getHosts, h.originalGetHosts);
  assert.equal(h.ordering.orderHostsLocalFirst, h.originalOrdering);
  assert.equal(h.hostListeners.size, 0);
  assert.equal(Reflect.get(globalThis, "__PASEO_HOST_ORDER__"), undefined);
});

test("a sidebar cleanup error cannot retain a controller or its shared lease", (t) => {
  const h = createHarness();
  t.after(() => h.restore());
  const lease = h.acquire(() => () => { throw new Error("cleanup failed"); });
  assert.throws(() => lease.release(), /cleanup failed/);
  assert.equal(h.store.getHosts, h.originalGetHosts);
  assert.equal(h.ordering.orderHostsLocalFirst, h.originalOrdering);
  assert.equal(h.hostListeners.size, 0);
  assert.equal(h.storageListeners.size, 0);
  assert.equal(Reflect.get(globalThis, "__PASEO_HOST_ORDER__"), undefined);
});
