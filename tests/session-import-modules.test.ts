import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test, type TestContext } from "node:test";
import contribute from "../plugins/ui/modules/import/index.client";
import { importContracts } from "../plugins/ui/modules/import/client/import-component";

const require = createRequire(import.meta.url);
const cacheKey = "@paseo-suite:bundle-modules:1:session-import";
const bundle = "index-0a1b2c.js";
const dependencies = Array.from({ length: 26 }, (_, index) => 100 + index);
const ids = {
  sheet: 4065,
  dependencies,
  sessions: 3661,
  titles: 4478,
  navigation: 3912,
  newWorkspace: 5399,
};
const exported = (symbol: string, id: number, imports: number[] = []) =>
  `__d(function(g,r,i,a,m,e,d){e.${symbol}=function(){}},${id},[${imports}]);`;
const source = [
  exported("ImportSessionSheet", ids.sheet, dependencies),
  exported("useSessionStore", ids.sessions),
  exported("selectAgentTabSidebarLabel", ids.titles),
  exported("getLastWorkspaceSelection", ids.navigation),
  exported("NewWorkspaceScreen", ids.newWorkspace),
].join("\n");

function harness(t: TestContext) {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  function set(key: string, value: unknown) {
    if (!descriptors.has(key))
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args) => {
    errors.push(args);
  };
  t.after(() => {
    console.error = originalError;
    for (const [key, previous] of descriptors) {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  // The generated sheet only needs its imports to exist while it is installed.
  const anything: unknown = new Proxy(function () {}, {
    get: () => anything,
    apply: () => anything,
  });
  const nativeSheet = () => null;
  const nativeTitle = () => "title";
  const nativeScreen = () => null;
  const modules: Record<number, Record<string, unknown>> = {
    [ids.sheet]: { ImportSessionSheet: nativeSheet },
    [ids.sessions]: { useSessionStore: { getState: () => ({ sessions: {} }) } },
    [ids.titles]: { selectAgentTabSidebarLabel: nativeTitle },
    [ids.navigation]: { getLastWorkspaceSelection: () => null },
    [ids.newWorkspace]: { NewWorkspaceScreen: nativeScreen },
  };
  for (const [name, [index, names]] of Object.entries(importContracts))
    modules[dependencies[index]] = name.startsWith("react/")
      ? require(name)
      : name === "react"
        ? require("react")
        : Object.fromEntries(names.map((symbol) => [symbol, anything]));
  const stored = new Map<string, string>();
  const required: number[] = [];
  let fetches = 0;
  let text = source;
  set("document", { scripts: [{ src: `paseo://app/${bundle}` }] });
  set("__PASEO_SESSION_IMPORT__", undefined);
  set("__PASEO_SUITE_BUNDLE_SOURCES_1__", undefined);
  set("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  set("__r", (id: number) => {
    required.push(id);
    if (!(id in modules)) throw new Error(`Requiring unknown module "${id}"`);
    return modules[id];
  });
  set("fetch", async () => {
    fetches++;
    return { ok: true, text: async () => text };
  });
  return {
    modules,
    stored,
    required,
    errors,
    nativeSheet,
    nativeTitle,
    nativeScreen,
    get fetches() {
      return fetches;
    },
    setText(next: string) {
      text = next;
    },
    remembered: () => JSON.parse(stored.get(cacheKey) ?? "null"),
    remember: (stale: object) =>
      stored.set(
        cacheKey,
        JSON.stringify({ bundle, ids: { ...ids, ...stale } }),
      ),
    /** A later window shares the saved IDs but none of this window's memory. */
    nextWindow() {
      set("__PASEO_SUITE_BUNDLE_SOURCES_1__", undefined);
      required.length = 0;
    },
    async start() {
      const release = contribute();
      const lease = Reflect.get(globalThis, "__PASEO_SESSION_IMPORT__") as {
        ready: Promise<void>;
        failed: boolean;
      };
      await lease.ready;
      return { release, lease };
    },
  };
}

test("같은 앱 번들에서 다시 시작하면 기억한 ID를 확인하고 번들을 받지 않는다", async (t) => {
  const h = harness(t);
  const first = await h.start();
  assert.deepEqual(h.errors, []);
  assert.equal(h.fetches, 1);
  assert.notEqual(h.modules[ids.sheet].ImportSessionSheet, h.nativeSheet);
  assert.deepEqual(h.remembered(), { bundle, ids });
  first.release();
  assert.equal(h.modules[ids.sheet].ImportSessionSheet, h.nativeSheet);
  h.nextWindow();
  const second = await h.start();
  assert.deepEqual(h.errors, []);
  assert.equal(h.fetches, 1);
  assert.notEqual(h.modules[ids.sheet].ImportSessionSheet, h.nativeSheet);
  assert.notEqual(
    h.modules[ids.titles].selectAgentTabSidebarLabel,
    h.nativeTitle,
  );
  assert.notEqual(
    h.modules[ids.newWorkspace].NewWorkspaceScreen,
    h.nativeScreen,
  );
  second.release();
  assert.equal(h.modules[ids.sheet].ImportSessionSheet, h.nativeSheet);
  assert.equal(h.modules[ids.titles].selectAgentTabSidebarLabel, h.nativeTitle);
  assert.equal(h.modules[ids.newWorkspace].NewWorkspaceScreen, h.nativeScreen);
});

test("기억한 ID가 다른 모듈이나 다른 의존성을 가리키면 고치지 않고 번들에서 다시 해석한다", async (t) => {
  const h = harness(t);
  for (const stale of [
    { sheet: ids.titles, titles: ids.sheet },
    { sessions: 9999 },
    { navigation: ids.newWorkspace },
    { dependencies: [...dependencies.slice(1), dependencies[0]] },
  ]) {
    h.nextWindow();
    h.remember(stale);
    const before = h.fetches;
    const started = await h.start();
    assert.deepEqual(h.errors, []);
    assert.equal(h.fetches, before + 1);
    assert.notEqual(h.modules[ids.sheet].ImportSessionSheet, h.nativeSheet);
    assert.equal(h.modules[ids.titles].ImportSessionSheet, undefined);
    assert.deepEqual(h.remembered(), { bundle, ids });
    started.release();
    assert.equal(h.modules[ids.sheet].ImportSessionSheet, h.nativeSheet);
  }
});

test("다른 번들이나 모양이 깨진 기록은 모듈을 불러 보지 않고 버린다", async (t) => {
  const h = harness(t);
  for (const entry of [
    { bundle: "index-ffffff.js", ids },
    { bundle, ids: { ...ids, dependencies: dependencies.slice(1) } },
    { bundle, ids: { ...ids, sheet: "4065" } },
    { bundle, ids: { ...ids, titles: undefined } },
  ]) {
    h.nextWindow();
    h.stored.set(cacheKey, JSON.stringify(entry));
    const before = h.fetches;
    const release = contribute();
    assert.deepEqual(h.required, []);
    await (
      Reflect.get(globalThis, "__PASEO_SESSION_IMPORT__") as {
        ready: Promise<void>;
      }
    ).ready;
    assert.deepEqual(h.errors, []);
    assert.equal(h.fetches, before + 1);
    assert.deepEqual(h.remembered(), { bundle, ids });
    release();
  }
});

test("불러오기 화면이 없거나 런타임 계약이 다른 앱의 ID는 기억하지 않는다", async (t) => {
  const h = harness(t);
  h.setText(source.split("\n").slice(1).join("\n"));
  const missing = await h.start();
  assert.equal(missing.lease.failed, true);
  assert.match(String(h.errors[0][1]), /불러오기 화면이 없습니다/);
  assert.equal(h.stored.size, 0);
  missing.release();
  h.nextWindow();
  h.setText(source);
  h.modules[dependencies[importContracts.react[0]]] = {};
  const mismatched = await h.start();
  assert.equal(mismatched.lease.failed, true);
  assert.match(String(h.errors[1][1]), /런타임 계약 불일치: react/);
  assert.equal(h.modules[ids.sheet].ImportSessionSheet, h.nativeSheet);
  assert.equal(h.stored.size, 0);
  assert.equal(h.fetches, 2);
  mismatched.release();
});
