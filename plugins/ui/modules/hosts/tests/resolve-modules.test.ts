import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { parseModuleMap, resolveModuleMap, type HostModuleMap } from "../client/resolve-modules";

const source = [
  "__d(function(g,r,i,a,m,e,d){e.getHostRuntimeStore=function(){}},910,[]);",
  ' __d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"orderHostsLocalFirst",{get:function(){}})},920,[]);',
  "__d(function(g,r,i,a,m,e,d){e.getDesktopDaemonStatus=function(){}},930,[]);",
].join("\n");

test("a new app bundle resolves its own module IDs without extending a static compatibility list", async () => {
  const url = "paseo://app/_expo/static/js/web/index-a1234.js?cache=2";
  const read: string[] = [];
  const map = await resolveModuleMap(
    ["paseo://app/unrelated.js", url],
    async (value) => {
      read.push(value);
      return source;
    },
    [],
  );
  assert.deepEqual(map, { bundle: "index-a1234.js", runtime: 910, ordering: 920, desktop: 930 });
  assert.deepEqual(read, [url]);
});

test("known builds keep their reviewed IDs and do not read the app bundle", async () => {
  const known = { bundle: "index-a1234.js", runtime: 10, ordering: 20, desktop: 30 };
  const map = await resolveModuleMap(
    ["paseo://app/index-a1234.js"],
    () => {
      throw new Error("Known build must not fetch");
    },
    [known],
  );
  assert.equal(map, known);
});

test("missing app scripts stay unsupported and failed reads are surfaced", async () => {
  assert.equal(await resolveModuleMap([], async () => source, []), undefined);
  await assert.rejects(
    resolveModuleMap(
      ["paseo://app/index-a1234.js"],
      async () => {
        throw new Error("read failed");
      },
      [],
    ),
    /read failed/,
  );
});

test("ambiguous or incomplete exports never guess another module's ID", () => {
  assert.throws(() => parseModuleMap("index-a1234.js", source + "\n" + source), /확인/);
  assert.throws(
    () => parseModuleMap("index-a1234.js", source.replace("getHostRuntimeStore", "missing")),
    /확인/,
  );
  assert.throws(() => parseModuleMap("index-a1234.js", source.replace("},910,[]);", "};")), /ID/);
});

function remembering(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  let reads = 0;
  return {
    stored,
    get reads() { return reads; },
    resolve: (matches?: (ids: HostModuleMap) => boolean, text = source, bundle = "index-a1234.js") =>
      resolveModuleMap([`paseo://app/${bundle}?cache=2`], async () => { reads++; return text; }, [], matches),
  };
}
const cacheKey = "@paseo-suite:bundle-modules:1:host-order";
const resolved = { bundle: "index-a1234.js", runtime: 910, ordering: 920, desktop: 930 };

test("the same app bundle is read once and later starts reuse the verified module IDs", async (t) => {
  const h = remembering(t);
  assert.deepEqual(await h.resolve(() => true), resolved);
  assert.deepEqual(JSON.parse(h.stored.get(cacheKey)!), { bundle: "index-a1234.js", ids: resolved });
  const checked: HostModuleMap[] = [];
  assert.deepEqual(await h.resolve((ids) => { checked.push(ids); return true; }), resolved);
  assert.equal(h.reads, 1);
  assert.deepEqual(checked[0], resolved);
});

test("remembered IDs that no longer match the running modules are dropped and resolved again", async (t) => {
  const h = remembering(t);
  h.stored.set(cacheKey, JSON.stringify({ bundle: "index-a1234.js", ids: { ...resolved, runtime: 1, ordering: 2 } }));
  const seen: number[] = [];
  const matches = (ids: HostModuleMap) => { seen.push(ids.runtime); return ids.runtime === 910; };
  assert.deepEqual(await h.resolve(matches), resolved);
  assert.equal(h.reads, 1);
  assert.deepEqual(seen, [1, 910]);
  assert.deepEqual(JSON.parse(h.stored.get(cacheKey)!).ids, resolved);
});

test("IDs from another bundle or with a damaged shape are never checked against running modules", async (t) => {
  const h = remembering(t);
  for (const entry of [
    { bundle: "index-b5678.js", ids: { ...resolved, bundle: "index-b5678.js" } },
    { bundle: "index-a1234.js", ids: { ...resolved, bundle: "index-b5678.js" } },
    { bundle: "index-a1234.js", ids: { ...resolved, desktop: -1 } },
    { bundle: "index-a1234.js", ids: { ...resolved, ordering: "920" } },
  ]) {
    h.stored.set(cacheKey, JSON.stringify(entry));
    const before = h.reads;
    const checked: HostModuleMap[] = [];
    assert.deepEqual(await h.resolve((ids) => { checked.push(ids); return true; }), resolved);
    assert.equal(h.reads, before + 1);
    assert.deepEqual(checked, [resolved]);
  }
});

test("parsed IDs whose modules do not match are returned as before but never remembered", async (t) => {
  const h = remembering(t);
  assert.deepEqual(await h.resolve(() => false), resolved);
  assert.deepEqual(await h.resolve(), resolved);
  assert.equal(h.stored.size, 0);
  assert.equal(h.reads, 2);
  await assert.rejects(h.resolve(() => true, "", "index-c9.js"), /확인/);
  assert.equal(h.stored.size, 0);
});
