import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import {
  readAppBundle,
  resolveBundleModules,
} from "../plugins/ui/client/bundle-modules";

const sourcesKey = "__PASEO_SUITE_BUNDLE_SOURCES_1__";
const url = "paseo://app/_expo/static/js/web/index-a1b2c3.js";
const nextUrl = "paseo://app/_expo/static/js/web/index-d4e5f6.js?v=2";

test("단독으로도 배포하는 Settings Sync의 사본은 UI의 원본과 같다", async () => {
  const [original, copy] = await Promise.all(
    ["ui", "settings-sync"].map(async (plugin) =>
      (
        await readFile(
          new URL(
            `../plugins/${plugin}/client/bundle-modules.ts`,
            import.meta.url,
          ),
          "utf8",
        )
      ).replaceAll("\r\n", "\n"),
    ),
  );
  assert.equal(copy, original);
});

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
  t.after(() => {
    for (const [key, previous] of descriptors) {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const stored = new Map<string, string>();
  const fetched: string[] = [];
  let respond: (url: string) => Promise<unknown> = async () => ({
    ok: true,
    text: async () => "bundle text",
  });
  set(sourcesKey, undefined);
  set("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  set("fetch", (target: string) => {
    fetched.push(target);
    return respond(target);
  });
  let reads = 0;
  return {
    set,
    stored,
    fetched,
    respond(next: typeof respond) {
      respond = next;
    },
    get reads() {
      return reads;
    },
    sources: () =>
      Reflect.get(globalThis, sourcesKey) as Map<string, unknown> | undefined,
    resolve: (
      accepts: (remembered: unknown) => boolean,
      ids: unknown = { sheet: 7 },
      target = url,
    ) =>
      resolveBundleModules({
        name: "test",
        url: target,
        read: async () => {
          reads++;
          return "bundle text";
        },
        parse: () => ids,
        accepts,
      }),
  };
}

test("같은 번들의 두 번째 해석은 기억한 ID를 확인만 하고 번들을 읽지 않는다", async (t) => {
  const h = harness(t);
  const first = await h.resolve(() => assert.fail("기억한 ID가 없습니다"));
  assert.deepEqual(first.ids, { sheet: 7 });
  assert.equal(h.reads, 1);
  first.confirm();
  assert.deepEqual(
    [...h.stored.keys()],
    ["@paseo-suite:bundle-modules:1:test"],
  );
  const checked: unknown[] = [];
  const second = await h.resolve((remembered) => {
    checked.push(remembered);
    return true;
  });
  assert.deepEqual(second.ids, { sheet: 7 });
  assert.deepEqual(checked, [{ sheet: 7 }]);
  assert.equal(h.reads, 1);
});

test("기억한 ID가 실행 중인 모듈과 어긋나면 버리고 번들에서 다시 해석한다", async (t) => {
  const h = harness(t);
  (await h.resolve(() => true)).confirm();
  const rejected = await h.resolve(() => false, { sheet: 8 });
  assert.deepEqual(rejected.ids, { sheet: 8 });
  assert.equal(h.reads, 2);
  assert.equal(h.stored.size, 0);
  rejected.confirm();
  const failing = await h.resolve(
    () => {
      throw new Error("Requiring unknown module");
    },
    { sheet: 9 },
  );
  assert.deepEqual(failing.ids, { sheet: 9 });
  assert.equal(h.reads, 3);
  failing.confirm();
  assert.deepEqual((await h.resolve(() => true)).ids, { sheet: 9 });
  assert.equal(h.reads, 3);
});

test("호출자가 확인하지 않은 해석 결과는 기억하지 않는다", async (t) => {
  const h = harness(t);
  await h.resolve(() => true);
  assert.equal(h.stored.size, 0);
  await h.resolve(() => true);
  assert.equal(h.reads, 2);
});

test("번들 해시가 바뀌면 이전 번들의 기록을 지우고 새 번들만 남긴다", async (t) => {
  const h = harness(t);
  (await h.resolve(() => true)).confirm();
  const next = await h.resolve(
    () => assert.fail("다른 번들의 ID를 확인하면 안 됩니다"),
    { sheet: 70 },
    nextUrl,
  );
  assert.equal(h.reads, 2);
  assert.equal(h.stored.size, 0);
  next.confirm();
  assert.deepEqual(
    [...h.stored.values()].map((value) => JSON.parse(value)),
    [{ bundle: "index-d4e5f6.js", ids: { sheet: 70 } }],
  );
  assert.deepEqual((await h.resolve(() => true, null, nextUrl)).ids, {
    sheet: 70,
  });
  assert.equal(h.reads, 2);
});

test("저장소를 쓸 수 없거나 기록이 깨져 있어도 번들에서 해석한다", async (t) => {
  const h = harness(t);
  h.stored.set("@paseo-suite:bundle-modules:1:test", "{broken");
  assert.deepEqual((await h.resolve(() => true)).ids, { sheet: 7 });
  assert.equal(h.stored.size, 0);
  const denied = () => {
    throw new Error("SecurityError");
  };
  h.set("localStorage", {
    getItem: denied,
    setItem: denied,
    removeItem: denied,
  });
  const blocked = await h.resolve(() => true);
  blocked.confirm();
  assert.deepEqual(blocked.ids, { sheet: 7 });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: denied,
  });
  const hidden = await h.resolve(() => true);
  hidden.confirm();
  h.set("localStorage", undefined);
  const missing = await h.resolve(() => true);
  missing.confirm();
  assert.deepEqual(missing.ids, { sheet: 7 });
  assert.equal(h.reads, 4);
});

test("한 창에서 동시에 요청한 번들은 한 번만 받고 유예 뒤에는 본문을 놓는다", async (t) => {
  const h = harness(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const texts = await Promise.all([
    readAppBundle(url),
    readAppBundle(url),
    resolveBundleModules({
      name: "shared",
      url,
      read: readAppBundle,
      parse: (source) => source,
      accepts: () => false,
    }).then((resolved) => resolved.ids),
  ]);
  assert.deepEqual(texts, ["bundle text", "bundle text", "bundle text"]);
  assert.deepEqual(h.fetched, [url]);
  await new Promise((done) => setImmediate(done));
  assert.equal(await readAppBundle(url), "bundle text");
  assert.deepEqual(h.fetched, [url]);
  t.mock.timers.tick(10_000);
  assert.equal(h.sources()!.size, 0);
  assert.equal(await readAppBundle(url), "bundle text");
  assert.deepEqual(h.fetched, [url, url]);
});

test("실패한 번들 읽기는 남기지 않아 다음 요청이 다시 받는다", async (t) => {
  const h = harness(t);
  h.respond(async () => ({ ok: false }));
  await assert.rejects(readAppBundle(url), /앱 번들/);
  h.respond(async () => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(
    Promise.all([readAppBundle(url), readAppBundle(url)]),
    /Failed to fetch/,
  );
  assert.equal(h.sources()!.size, 0);
  h.respond(async () => ({ ok: true, text: async () => "recovered" }));
  assert.equal(await readAppBundle(url), "recovered");
  assert.deepEqual(h.fetched, [url, url, url]);
});

test("한 플러그인의 취소는 자기 대기만 끝내고 공유 중인 읽기를 끊지 않는다", async (t) => {
  const h = harness(t);
  let finish!: (response: unknown) => void;
  let signal: AbortSignal | undefined;
  h.set("fetch", (target: string, options: { signal: AbortSignal }) => {
    h.fetched.push(target);
    signal = options.signal;
    return new Promise((done) => {
      finish = done;
    });
  });
  const leaving = new AbortController();
  const left = readAppBundle(url, leaving.signal);
  const staying = readAppBundle(url, new AbortController().signal);
  leaving.abort();
  await assert.rejects(left, { name: "AbortError" });
  assert.equal(signal!.aborted, false);
  finish({ ok: true, text: async () => "bundle text" });
  assert.equal(await staying, "bundle text");
  await assert.rejects(readAppBundle(url, leaving.signal), {
    name: "AbortError",
  });
  assert.deepEqual(h.fetched, [url]);
});

test("서로 다른 플러그인 번들에 들어간 사본끼리 읽기와 기억한 ID를 공유한다", async (t) => {
  const h = harness(t);
  const built = await build({
    entryPoints: [
      fileURLToPath(
        new URL("../plugins/ui/client/bundle-modules.ts", import.meta.url),
      ),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  const copy = () => {
    const module = {
      exports: {} as typeof import("../plugins/ui/client/bundle-modules"),
    };
    new Function("module", "exports", built.outputFiles[0].text)(
      module,
      module.exports,
    );
    return module.exports;
  };
  const [aster, ui] = [copy(), copy()];
  assert.notEqual(aster.readAppBundle, ui.readAppBundle);
  const resolveWith = (plugin: typeof aster) =>
    plugin.resolveBundleModules({
      name: "shared",
      url,
      read: plugin.readAppBundle,
      parse: (source) => ({ length: source.length }),
      accepts: () => true,
    });
  const [first, second, text] = await Promise.all([
    resolveWith(aster),
    resolveWith(ui),
    readAppBundle(url),
  ]);
  assert.deepEqual(h.fetched, [url]);
  assert.equal(text, "bundle text");
  assert.deepEqual(second.ids, first.ids);
  first.confirm();
  h.set(sourcesKey, undefined);
  assert.deepEqual((await resolveWith(ui)).ids, { length: 11 });
  assert.deepEqual(h.fetched, [url]);
});

test("끝나지 않는 읽기는 시간 제한 뒤 실패로 끝나 다음 요청을 막지 않는다", async (t) => {
  const h = harness(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  h.set("fetch", (target: string, options: { signal: AbortSignal }) => {
    h.fetched.push(target);
    return new Promise((_done, fail) => {
      options.signal.addEventListener("abort", () =>
        fail(options.signal.reason),
      );
    });
  });
  const waiting = Promise.allSettled([readAppBundle(url), readAppBundle(url)]);
  t.mock.timers.tick(119_999);
  assert.equal(h.sources()!.size, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(
    (await waiting).map((result) => result.status),
    ["rejected", "rejected"],
  );
  assert.equal(h.sources()!.size, 0);
  h.set("fetch", async (target: string) => {
    h.fetched.push(target);
    return { ok: true, text: async () => "bundle text" };
  });
  assert.equal(await readAppBundle(url), "bundle text");
  assert.deepEqual(h.fetched, [url, url]);
});
