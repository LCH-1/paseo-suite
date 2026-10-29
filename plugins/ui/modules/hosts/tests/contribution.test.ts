import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import moduleMaps from "../client/module-maps";
import type { PluginClientContext } from "@getpaseo/plugin/client";

const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../index.client.tsx", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", packages: "external", write: false,
});
const settle = () => new Promise((done) => setImmediate(done));

function harness(t: TestContext) {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  function set(key: string, value: unknown) {
    if (!descriptors.has(key)) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const hostListeners = new Set<() => void>();
  const storageListeners = new Set<unknown>();
  const nativeHosts = () => [{ serverId: "host", label: "Host" }];
  const store = {
    getHosts: nativeHosts,
    reorderHosts() {},
    emitHostList() { hostListeners.forEach((listener) => listener()); },
    subscribeHostList(listener: () => void) { hostListeners.add(listener); return () => { hostListeners.delete(listener); }; },
  };
  const nativeOrder = (hosts: unknown[]) => hosts;
  const ordering = { orderHostsLocalFirst: nativeOrder };
  const values = new Map<string, string>();
  const scripts = [{ src: `paseo://app/${moduleMaps[0].bundle}` }];
  set("document", { scripts });
  set("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  set("__PASEO_HOST_ORDER__", undefined);
  set("__r", (id: number) => id === moduleMaps[0].runtime ? { getHostRuntimeStore: () => store }
    : id === moduleMaps[0].ordering ? ordering : { shouldUseDesktopDaemon: () => false });
  set("addEventListener", (_type: string, callback: unknown) => { storageListeners.add(callback); });
  set("removeEventListener", (_type: string, callback: unknown) => { storageListeners.delete(callback); });
  const warnings: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  t.after(() => {
    console.warn = warn;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  let failSettings = false, failCommand = false, failCommandCleanup = false;
  let settings = 0, commands = 0, removedSettings = 0, removedCommands = 0;
  const client = {
    addSettingsScreen() {
      settings++;
      if (failSettings) throw new Error("settings registration failed");
      return () => { removedSettings++; };
    },
    addCommandCenterItem() {
      commands++;
      if (failCommand) throw new Error("command registration failed");
      return () => { removedCommands++; if (failCommandCleanup) throw new Error("command cleanup failed"); };
    },
  } as unknown as PluginClientContext;
  const module = { exports: {} as { default(client: PluginClientContext): () => void } };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    (name: string) => ["react-native", "@getpaseo/plugin/client/ui"].includes(name) ? {} : require(name), module, module.exports,
  );
  return {
    set, scripts, store, ordering, nativeHosts, nativeOrder, hostListeners, storageListeners, warnings,
    contribute: () => module.exports.default(client),
    failSettings(value: boolean) { failSettings = value; },
    failCommand(value: boolean) { failCommand = value; },
    failCommandCleanup() { failCommandCleanup = true; },
    counts: () => ({ settings, commands, removedSettings, removedCommands }),
    lease: () => Reflect.get(globalThis, "__PASEO_HOST_ORDER__"),
  };
}

test("partial contribution registration failure rolls back once and permits a clean restart", async (t) => {
  const h = harness(t);
  h.failCommand(true);
  const failed = h.contribute();
  await settle();
  assert.deepEqual(h.counts(), { settings: 1, commands: 1, removedSettings: 1, removedCommands: 0 });
  assert.equal(h.warnings.length, 1);
  assert.equal(h.lease(), undefined);
  assert.equal(h.store.getHosts, h.nativeHosts);
  assert.equal(h.ordering.orderHostsLocalFirst, h.nativeOrder);
  assert.equal(h.hostListeners.size, 0);
  assert.equal(h.storageListeners.size, 0);
  failed(); failed();
  h.failCommand(false);
  const restarted = h.contribute();
  await settle();
  assert.equal(h.lease().owners, 1);
  restarted(); restarted();
  assert.deepEqual(h.counts(), { settings: 2, commands: 2, removedSettings: 2, removedCommands: 1 });
  assert.equal(h.lease(), undefined);
  assert.equal(h.hostListeners.size, 0);
});

test("the first contribution throw releases the acquired controller without registering twice", async (t) => {
  const h = harness(t);
  h.failSettings(true);
  const release = h.contribute();
  await settle();
  assert.deepEqual(h.counts(), { settings: 1, commands: 0, removedSettings: 0, removedCommands: 0 });
  assert.equal(h.lease(), undefined);
  assert.equal(h.hostListeners.size, 0);
  assert.equal(h.store.getHosts, h.nativeHosts);
  release();
});

test("synchronous startup failure removes its successful partial registration before throwing", (t) => {
  const h = harness(t);
  h.set("document", undefined);
  h.failCommand(true);
  assert.throws(() => h.contribute(), /command registration failed/);
  assert.deepEqual(h.counts(), { settings: 1, commands: 1, removedSettings: 1, removedCommands: 0 });
  assert.equal(h.lease(), undefined);
});

test("unload cleanup errors cannot leave settings, shared owners or store wrappers behind", async (t) => {
  const h = harness(t);
  h.failCommandCleanup();
  const release = h.contribute();
  await settle();
  assert.throws(release, AggregateError);
  release();
  assert.deepEqual(h.counts(), { settings: 1, commands: 1, removedSettings: 1, removedCommands: 1 });
  assert.equal(h.lease(), undefined);
  assert.equal(h.store.getHosts, h.nativeHosts);
  assert.equal(h.hostListeners.size, 0);
  assert.equal(h.storageListeners.size, 0);
});

test("only module resolution failure falls back once to the unsupported settings screen", async (t) => {
  const h = harness(t);
  h.scripts[0].src = "paseo://app/index-aabbcc.js";
  let fetches = 0;
  h.set("fetch", async () => { fetches++; throw new Error("bundle unavailable"); });
  const release = h.contribute();
  await settle();
  assert.equal(fetches, 1);
  assert.equal(h.warnings.length, 1);
  assert.deepEqual(h.counts(), { settings: 1, commands: 1, removedSettings: 0, removedCommands: 0 });
  assert.equal(h.lease(), undefined);
  release();
});

test("unload while resolving a bundle never registers contributions from its late response", async (t) => {
  const h = harness(t);
  h.scripts[0].src = "paseo://app/index-aabbcc.js";
  let resolve!: (response: unknown) => void;
  h.set("fetch", () => new Promise((done) => { resolve = done; }));
  const release = h.contribute();
  release();
  resolve({ ok: false });
  await settle();
  assert.deepEqual(h.counts(), { settings: 0, commands: 0, removedSettings: 0, removedCommands: 0 });
  assert.equal(h.lease(), undefined);
});
