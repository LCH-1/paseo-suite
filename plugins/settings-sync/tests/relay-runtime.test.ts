import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { contributeRelay } from "../client/relay-runtime";

const cacheKey = "@paseo-suite:bundle-modules:1:credential-relay";
const bundle = "index-0a1b2c.js";
const ids = { sessions: 3661, registry: 3682 };
const source = [
  `__d(function(g,r,i,a,m,e,d){e.useSessionStore=function(){}},${ids.sessions},[]);`,
  `__d(function(g,r,i,a,m,e,d){e.pluginRegistry={}},${ids.registry},[]);`,
].join("\n");

function harness(t: TestContext) {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  function set(key: string, value: unknown) {
    if (!descriptors.has(key)) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args); };
  t.after(() => {
    console.error = originalError;
    for (const [key, previous] of descriptors) {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let polls = 0, fetches = 0;
  const modules: Record<number, Record<string, unknown>> = {
    [ids.sessions]: { useSessionStore: { getState: () => { polls++; return { sessions: {} }; } } },
    [ids.registry]: { pluginRegistry: { getSnapshot: () => [] } },
  };
  const stored = new Map<string, string>();
  set("document", { scripts: [{ src: `paseo://app/${bundle}` }] });
  set("__PASEO_SYNC_CREDENTIAL_RELAY__", undefined);
  set("__PASEO_SUITE_BUNDLE_SOURCES_1__", undefined);
  set("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  set("__r", (id: number) => {
    if (!(id in modules)) throw new Error(`Requiring unknown module "${id}"`);
    return modules[id];
  });
  set("fetch", async () => { fetches++; return { ok: true, text: async () => source }; });
  const settle = () => new Promise((done) => setImmediate(done));
  return {
    modules, stored, errors,
    get fetches() { return fetches; },
    remembered: () => JSON.parse(stored.get(cacheKey) ?? "null"),
    /** A later window shares the saved IDs but none of this window's memory. */
    nextWindow: () => set("__PASEO_SUITE_BUNDLE_SOURCES_1__", undefined),
    /** Only a started relay asks the session store for its peers, on its first tick. */
    async start() {
      const before = polls;
      const release = contributeRelay();
      await settle();
      t.mock.timers.tick(1000);
      await settle();
      return { release, started: polls === before + 1 };
    },
  };
}

test("같은 앱 번들에서 다시 시작하면 기억한 ID를 확인하고 번들을 받지 않는다", async (t) => {
  const h = harness(t);
  const first = await h.start();
  assert.equal(first.started, true);
  assert.equal(h.fetches, 1);
  assert.deepEqual(h.remembered(), { bundle, ids });
  first.release();
  h.nextWindow();
  const second = await h.start();
  assert.equal(second.started, true);
  assert.equal(h.fetches, 1);
  assert.deepEqual(h.errors, []);
  second.release();
});

test("기억한 ID가 다른 모듈을 가리키면 번들에서 다시 해석한 모듈로 전달을 시작한다", async (t) => {
  const h = harness(t);
  for (const stale of [{ sessions: ids.registry, registry: ids.sessions }, { ...ids, registry: 9999 }, { ...ids, sessions: "3661" }]) {
    h.nextWindow();
    h.stored.set(cacheKey, JSON.stringify({ bundle, ids: stale }));
    const before = h.fetches;
    const relay = await h.start();
    assert.equal(relay.started, true);
    assert.equal(h.fetches, before + 1);
    assert.deepEqual(h.remembered(), { bundle, ids });
    assert.deepEqual(h.errors, []);
    relay.release();
  }
});

test("앱 계약과 다른 모듈의 ID는 기억하지 않고 실패도 이전처럼 알린다", async (t) => {
  const h = harness(t);
  h.modules[ids.registry] = { pluginRegistry: {} };
  const unverified = await h.start();
  assert.equal(unverified.started, true);
  assert.equal(h.stored.size, 0);
  unverified.release();
  h.nextWindow();
  delete h.modules[ids.sessions];
  const failed = await h.start();
  assert.equal(failed.started, false);
  assert.equal(h.fetches, 2);
  assert.equal(h.errors.length, 1);
  assert.equal(h.stored.size, 0);
  failed.release();
});
