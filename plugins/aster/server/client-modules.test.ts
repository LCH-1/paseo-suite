import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { contributeMenu as contribute } from "../client/contribute-menu.ts";
import { parseMenuModules, resolveMenuModules } from "../client/modules.ts";
import { installMenuPresentation } from "../client/menu.ts";

const source = [
  "__d(function(g,r,i,a,m,e,d){e.useAgentFormState=function(){}},901,[]);",
  "__d(function(g,r,i,a,m,e,d){e.useAgentProfilePicker=function(){}},802,[]);",
  "__d(function(g,r,i,a,m,e,d){e.pluginRegistry={}},703,[]);",
  "__d(function(g,r,i,a,m,e,d){e.useAgentProfileFormCatalog=function(){}},604,[]);",
  "__d(function(g,r,i,a,m,e,d){e.useAgentProfileFormState=function(){}},505,[]);",
  "__d(function(g,r,i,a,m,e,d){e.useSessionSettings=function(){}},406,[]);",
  "__d(function(g,r,i,a,m,e,d){e.useModelBrowser=function(){}},307,[]);",
  "__d(function(g,r,i,a,m,e,d){e.useSessionStore=function(){}},208,[]);",
].join("\n");

test("새 앱 번들의 고유한 export로 메뉴 ID를 확인하고 모호한 모듈을 거부한다", async () => {
  assert.deepEqual(parseMenuModules(source), {
    form: 901,
    profiles: 802,
    registry: 703,
    catalog: 604,
    profileState: 505,
    settings: 406,
    browser: 307,
    sessions: 208,
  });
  const read: string[] = [];
  const resolved = await resolveMenuModules(
    ["paseo://app/index-abcdef.js?v=2"],
    async (url) => {
      read.push(url);
      return source;
    },
  );
  assert.deepEqual(resolved.ids, {
    form: 901,
    profiles: 802,
    registry: 703,
    catalog: 604,
    profileState: 505,
    settings: 406,
    browser: 307,
    sessions: 208,
  });
  assert.deepEqual(read, ["paseo://app/index-abcdef.js?v=2"]);
  assert.throws(
    () => parseMenuModules(source + "\n" + source.split("\n")[0]),
    /useAgentFormState/,
  );
  assert.throws(
    () => parseMenuModules(source.split("\n").slice(0, 2).join("\n")),
    /pluginRegistry/,
  );
  assert.throws(
    () =>
      parseMenuModules(
        source
          .split("\n")
          .filter((line) => !line.includes("e.useAgentProfileFormCatalog="))
          .join("\n"),
      ),
    /useAgentProfileFormCatalog/,
  );
  assert.throws(
    () =>
      parseMenuModules(
        source
          .split("\n")
          .filter((line) => !line.includes("e.useAgentProfileFormState="))
          .join("\n"),
      ),
    /useAgentProfileFormState/,
  );
  assert.throws(
    () =>
      parseMenuModules(
        source
          .split("\n")
          .filter((line) => !line.includes("e.useSessionSettings="))
          .join("\n"),
      ),
    /useSessionSettings/,
  );
  await assert.rejects(
    resolveMenuModules([], async () => source),
    /호환성/,
  );
  await assert.rejects(
    resolveMenuModules(["/index-aa.js", "/index-bb.js"], async () => source),
    /호환성/,
  );
});

test("barrel 재수출과 다른 객체의 패치 코드를 실제 export 소유 모듈로 오인하지 않는다", () => {
  const owner = source.replace(
    "e.pluginRegistry={}",
    'Object.defineProperty(e,"pluginRegistry",{enumerable:!0,get:function(){return f}})',
  );
  const barrel =
    '__d(function(g,r,i,a,m,e,d){Object.defineProperty(e,"useAgentProfilePicker",{enumerable:!0,get:function(){return o.useAgentProfilePicker}})},111,[]);';
  const adapter =
    "__d(function(g,r,i,a,m,e,d){o.useAgentProfilePicker=function(){}},222,[]);";
  assert.deepEqual(parseMenuModules([owner, barrel, adapter].join("\n")), {
    form: 901,
    profiles: 802,
    registry: 703,
    catalog: 604,
    profileState: 505,
    settings: 406,
    browser: 307,
    sessions: 208,
  });
});

function harness(t: TestContext, remember = false) {
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
  const originalForm = () => ({});
  const originalProfiles = () => null;
  const originalCatalog = () => undefined;
  const originalProfileState = () => ({});
  const originalSettings = () => ({});
  const modules: Record<number, any> = {
    901: { useAgentFormState: originalForm },
    802: { useAgentProfilePicker: originalProfiles },
    703: {
      pluginRegistry: { getSnapshot: () => [], subscribe: () => () => {} },
    },
    604: { useAgentProfileFormCatalog: originalCatalog },
    505: { useAgentProfileFormState: originalProfileState },
    406: { useSessionSettings: originalSettings },
    307: { useModelBrowser: (options: any) => options },
    208: {
      useSessionStore: {
        getState: () => ({ sessions: {} }),
        setState() {},
        subscribe: () => () => {},
      },
    },
  };
  const required: number[] = [];
  const stored = new Map<string, string>();
  let fetches = 0;
  let read = async () => source;
  set("document", { scripts: [{ src: "paseo://app/index-abcdef.js" }] });
  set("__PASEO_ASTER_MENU__", undefined);
  set("__PASEO_SUITE_BUNDLE_SOURCES_1__", undefined);
  set(
    "localStorage",
    remember
      ? {
          getItem: (key: string) => stored.get(key) ?? null,
          setItem: (key: string, value: string) => void stored.set(key, value),
          removeItem: (key: string) => void stored.delete(key),
        }
      : undefined,
  );
  set("__r", (id: number) => {
    required.push(id);
    return modules[id];
  });
  set("fetch", async () => {
    fetches++;
    return { ok: true, text: read };
  });
  return {
    modules,
    originalForm,
    originalProfiles,
    originalCatalog,
    originalProfileState,
    originalSettings,
    required,
    get fetches() {
      return fetches;
    },
    stored,
    /** A later window shares the saved IDs but none of this window's memory. */
    nextWindow() {
      set("__PASEO_SUITE_BUNDLE_SOURCES_1__", undefined);
      required.length = 0;
    },
    setRead(next: typeof read) {
      read = next;
    },
    setLegacy(lease: unknown) {
      set("__PASEO_ASTER_MENU__", lease);
    },
    get lease() {
      return Reflect.get(globalThis, "__PASEO_ASTER_MENU__") as
        | {
            ready: Promise<void>;
            failed?: boolean;
            owners: number;
            version?: number;
          }
        | undefined;
    },
  };
}

test("여러 설치가 한 번만 번들을 분석하고 마지막 해제에서 메뉴를 복원한다", async (t) => {
  const h = harness(t);
  const first = contribute();
  const second = contribute();
  await h.lease!.ready;
  assert.equal(h.fetches, 1);
  assert.deepEqual(h.required, [901, 802, 703, 604, 505, 406, 307, 208]);
  assert.notEqual(h.modules[901].useAgentFormState, h.originalForm);
  first();
  first();
  assert.notEqual(h.modules[901].useAgentFormState, h.originalForm);
  second();
  assert.equal(h.modules[901].useAgentFormState, h.originalForm);
  assert.equal(h.modules[802].useAgentProfilePicker, h.originalProfiles);
  assert.equal(h.modules[604].useAgentProfileFormCatalog, h.originalCatalog);
  assert.equal(h.modules[505].useAgentProfileFormState, h.originalProfileState);
  assert.equal(h.modules[406].useSessionSettings, h.originalSettings);
  assert.equal(h.lease, undefined);
});

test("번들 조회 중 해제하면 늦은 응답이 메뉴 패치를 되살리지 않는다", async (t) => {
  const h = harness(t);
  let resolve!: (value: string) => void;
  h.setRead(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const release = contribute();
  const lease = h.lease!;
  await new Promise((done) => setImmediate(done));
  release();
  resolve(source);
  await lease.ready;
  assert.deepEqual(h.required, []);
  assert.equal(h.modules[901].useAgentFormState, h.originalForm);
  assert.equal(h.lease, undefined);
});

test("실제 export가 계약과 다르면 어떤 메뉴도 부분 수정하지 않는다", async (t) => {
  const h = harness(t);
  h.modules[802] = {};
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args) => {
    errors.push(args);
  };
  t.after(() => {
    console.error = originalError;
  });
  const release = contribute();
  await h.lease!.ready;
  assert.equal(errors.length, 1);
  assert.equal(h.modules[901].useAgentFormState, h.originalForm);
  release();
});

test("세션 설정 export가 없으면 기존 메뉴와 프로필 훅을 부분 수정하지 않는다", async (t) => {
  const h = harness(t);
  h.modules[406] = {};
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args) => {
    errors.push(args);
  };
  t.after(() => {
    console.error = originalError;
  });
  const release = contribute();
  await h.lease!.ready;
  assert.equal(errors.length, 1);
  assert.equal(h.modules[901].useAgentFormState, h.originalForm);
  assert.equal(h.modules[802].useAgentProfilePicker, h.originalProfiles);
  assert.equal(h.modules[604].useAgentProfileFormCatalog, h.originalCatalog);
  assert.equal(h.modules[505].useAgentProfileFormState, h.originalProfileState);
  release();
});

test("첫 조회 실패 후 같은 lease로 재시도하고 예전 설치 해제가 성공한 메뉴를 지우지 않는다", async (t) => {
  const h = harness(t);
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args) => {
    errors.push(args);
  };
  t.after(() => {
    console.error = originalError;
  });
  h.setRead(async () => {
    throw new Error("temporary bundle read failure");
  });
  const failedFirst = contribute();
  const failedSecond = contribute();
  const failedLease = h.lease!;
  await failedLease.ready;
  assert.equal(h.fetches, 1);
  assert.equal(errors.length, 1);
  assert.equal(h.lease, failedLease);
  assert.equal(h.lease!.failed, true);
  h.setRead(async () => source);
  const currentFirst = contribute();
  const currentSecond = contribute();
  const current = h.lease!;
  await current.ready;
  assert.equal(h.fetches, 2);
  assert.notEqual(h.modules[901].useAgentFormState, h.originalForm);
  failedFirst();
  failedSecond();
  assert.equal(h.lease, current);
  assert.notEqual(h.modules[901].useAgentFormState, h.originalForm);
  currentFirst();
  assert.equal(h.lease, current);
  currentSecond();
  assert.equal(h.lease, undefined);
  assert.equal(h.modules[901].useAgentFormState, h.originalForm);
  assert.equal(h.modules[802].useAgentProfilePicker, h.originalProfiles);
});

function legacyInstallation(
  h: ReturnType<typeof harness>,
  mode: "ready" | "failed" | "pending",
) {
  const request = new AbortController();
  let restore: (() => void) | undefined;
  let finish: (() => void) | undefined;
  let disposals = 0;
  const install = () => {
    if (!request.signal.aborted)
      restore = installMenuPresentation(
        h.modules[901],
        h.modules[802],
        h.modules[703],
        h.modules[604],
        h.modules[505],
        h.modules[406],
      );
  };
  if (mode === "ready") install();
  const ready =
    mode === "pending"
      ? new Promise<void>((resolve) => {
          finish = resolve;
        }).then(install)
      : Promise.resolve();
  const lease = {
    owners: 2,
    ready,
    dispose() {
      disposals++;
      request.abort();
      restore?.();
    },
  };
  h.setLegacy(lease);
  const release = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--lease.owners === 0) {
        lease.dispose();
        if (Reflect.get(globalThis, "__PASEO_ASTER_MENU__") === lease)
          Reflect.deleteProperty(globalThis, "__PASEO_ASTER_MENU__");
      }
    };
  };
  return {
    lease,
    first: release(),
    second: release(),
    finish: () => finish?.(),
    get disposals() {
      return disposals;
    },
    signal: request.signal,
  };
}

test("marker 없는 실패 lease는 다른 구 owner가 남아 있어도 새 코드에서 자동 복구한다", async (t) => {
  const h = harness(t);
  const legacy = legacyInstallation(h, "failed");
  const currentRelease = contribute();
  const current = h.lease!;
  await current.ready;
  assert.notEqual(current, legacy.lease);
  assert.equal(current.version, 11);
  assert.equal(h.fetches, 1);
  assert.equal(legacy.signal.aborted, true);
  assert.notEqual(h.modules[901].useAgentFormState, h.originalForm);
  legacy.first();
  legacy.second();
  assert.equal(h.lease, current);
  assert.notEqual(h.modules[901].useAgentFormState, h.originalForm);
  currentRelease();
  assert.equal(h.lease, undefined);
  assert.equal(h.modules[901].useAgentFormState, h.originalForm);
});

test("정상 legacy wrapper를 원복한 뒤 이관하고 새 owner가 먼저 해제되어도 구 owner 수명을 지킨다", async (t) => {
  const h = harness(t);
  const legacy = legacyInstallation(h, "ready");
  const oldWrapper = h.modules[901].useAgentFormState;
  const currentRelease = contribute();
  const current = h.lease!;
  await current.ready;
  const currentWrapper = h.modules[901].useAgentFormState;
  assert.notEqual(currentWrapper, oldWrapper);
  assert.notEqual(currentWrapper, h.originalForm);
  assert.equal(legacy.disposals, 1);
  currentRelease();
  assert.equal(h.lease, current);
  assert.equal(h.modules[901].useAgentFormState, currentWrapper);
  legacy.first();
  assert.equal(h.modules[901].useAgentFormState, currentWrapper);
  legacy.second();
  legacy.second();
  assert.equal(legacy.disposals, 2);
  assert.equal(h.lease, undefined);
  assert.equal(h.modules[901].useAgentFormState, h.originalForm);
  assert.equal(h.modules[802].useAgentProfilePicker, h.originalProfiles);
});

test("legacy 초기화 대기 중 이관하면 늦은 구 응답이 새 wrapper를 덮지 않는다", async (t) => {
  const h = harness(t);
  const legacy = legacyInstallation(h, "pending");
  const currentRelease = contribute();
  const current = h.lease!;
  await current.ready;
  const wrapper = h.modules[901].useAgentFormState;
  legacy.finish();
  await legacy.lease.ready;
  assert.equal(h.modules[901].useAgentFormState, wrapper);
  legacy.first();
  legacy.second();
  assert.equal(h.lease, current);
  currentRelease();
  assert.equal(h.modules[901].useAgentFormState, h.originalForm);
});

test("이관 첫 조회 실패와 후속 재시도에도 legacy owner 보유를 잃지 않는다", async (t) => {
  const h = harness(t);
  const legacy = legacyInstallation(h, "ready");
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });
  h.setRead(async () => {
    throw new Error("temporary migration read failure");
  });
  const failedRelease = contribute();
  const current = h.lease!;
  await current.ready;
  failedRelease();
  assert.equal(current.owners, 1);
  h.setRead(async () => source);
  const retryRelease = contribute();
  await current.ready;
  assert.equal(h.lease, current);
  assert.equal(h.fetches, 2);
  assert.notEqual(h.modules[901].useAgentFormState, h.originalForm);
  retryRelease();
  assert.equal(current.owners, 1);
  assert.notEqual(h.modules[901].useAgentFormState, h.originalForm);
  legacy.first();
  legacy.second();
  assert.equal(h.lease, undefined);
  assert.equal(h.modules[901].useAgentFormState, h.originalForm);
});

test("lease 8을 새 메뉴 lease로 교체하고 늦게 해제되는 owner를 보존한다", async (t) => {
  const h = harness(t),
    old = legacyInstallation(h, "ready");
  Object.assign(old.lease, { version: 8 });
  const release = contribute(),
    current = h.lease!;
  await current.ready;
  assert.equal(current.version, 11);
  assert.equal(old.signal.aborted, true);
  old.first();
  old.second();
  assert.equal(h.lease, current);
  release();
  assert.equal(h.lease, undefined);
  assert.equal(h.modules[901].useAgentFormState, h.originalForm);
});

test("두 번째 export 대입 실패는 첫 wrapper를 복원하고 재시도한다", async (t) => {
  const h = harness(t);
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args) => {
    errors.push(args);
  };
  t.after(() => {
    console.error = originalError;
  });
  let selected = h.originalProfiles;
  let fail = true;
  Object.defineProperty(h.modules[802], "useAgentProfilePicker", {
    configurable: true,
    get: () => selected,
    set: (value) => {
      if (fail) throw new Error("profile export setter failed");
      selected = value;
    },
  });
  const failedRelease = contribute();
  const failed = h.lease!;
  await failed.ready;
  assert.equal(errors.length, 1);
  assert.equal(h.modules[901].useAgentFormState, h.originalForm);
  assert.equal(h.modules[802].useAgentProfilePicker, h.originalProfiles);
  assert.equal(h.lease, failed);
  assert.equal(h.lease!.failed, true);
  fail = false;
  const currentRelease = contribute();
  const current = h.lease!;
  await current.ready;
  assert.notEqual(h.modules[901].useAgentFormState, h.originalForm);
  assert.notEqual(h.modules[802].useAgentProfilePicker, h.originalProfiles);
  failedRelease();
  assert.equal(h.lease, current);
  currentRelease();
  assert.equal(h.modules[901].useAgentFormState, h.originalForm);
  assert.equal(h.modules[802].useAgentProfilePicker, h.originalProfiles);
});

test("마지막 설정 export 대입 실패는 모든 앞선 wrapper를 복원하고 재시도한다", async (t) => {
  const h = harness(t);
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args) => {
    errors.push(args);
  };
  t.after(() => {
    console.error = originalError;
  });
  let selected = h.originalSettings;
  let fail = true;
  Object.defineProperty(h.modules[406], "useSessionSettings", {
    configurable: true,
    get: () => selected,
    set: (value) => {
      if (fail) throw new Error("settings export setter failed");
      selected = value;
    },
  });
  const failedRelease = contribute();
  const failed = h.lease!;
  await failed.ready;
  assert.equal(errors.length, 1);
  assert.equal(h.modules[901].useAgentFormState, h.originalForm);
  assert.equal(h.modules[802].useAgentProfilePicker, h.originalProfiles);
  assert.equal(h.modules[604].useAgentProfileFormCatalog, h.originalCatalog);
  assert.equal(h.modules[505].useAgentProfileFormState, h.originalProfileState);
  assert.equal(h.modules[406].useSessionSettings, h.originalSettings);
  assert.equal(failed.failed, true);
  fail = false;
  const currentRelease = contribute();
  const current = h.lease!;
  await current.ready;
  assert.notEqual(h.modules[901].useAgentFormState, h.originalForm);
  assert.notEqual(h.modules[604].useAgentProfileFormCatalog, h.originalCatalog);
  assert.notEqual(
    h.modules[505].useAgentProfileFormState,
    h.originalProfileState,
  );
  assert.notEqual(h.modules[406].useSessionSettings, h.originalSettings);
  failedRelease();
  assert.equal(h.lease, current);
  currentRelease();
  assert.equal(h.modules[901].useAgentFormState, h.originalForm);
  assert.equal(h.modules[802].useAgentProfilePicker, h.originalProfiles);
  assert.equal(h.modules[604].useAgentProfileFormCatalog, h.originalCatalog);
  assert.equal(h.modules[505].useAgentProfileFormState, h.originalProfileState);
  assert.equal(h.modules[406].useSessionSettings, h.originalSettings);
});

const menuCacheKey = "@paseo-suite:bundle-modules:1:aster-menu";
const menuIds = {
  form: 901,
  profiles: 802,
  registry: 703,
  catalog: 604,
  profileState: 505,
  settings: 406,
  browser: 307,
  sessions: 208,
};

test("같은 앱 번들에서 다시 시작하면 기억한 메뉴 ID를 확인하고 번들을 받지 않는다", async (t) => {
  const h = harness(t, true);
  let storeListeners = 0;
  h.modules[208].useSessionStore.subscribe = () => {
    storeListeners++;
    return () => void storeListeners--;
  };
  const first = contribute();
  await h.lease!.ready;
  first();
  assert.equal(h.fetches, 1);
  assert.equal(storeListeners, 0);
  assert.deepEqual(JSON.parse(h.stored.get(menuCacheKey)!), {
    bundle: "index-abcdef.js",
    ids: menuIds,
  });
  h.nextWindow();
  const second = contribute();
  await h.lease!.ready;
  assert.equal(h.fetches, 1);
  assert.notEqual(h.modules[901].useAgentFormState, h.originalForm);
  assert.notEqual(h.modules[406].useSessionSettings, h.originalSettings);
  assert.equal(storeListeners, 1);
  second();
  assert.equal(h.modules[901].useAgentFormState, h.originalForm);
  assert.equal(h.modules[406].useSessionSettings, h.originalSettings);
  assert.equal(storeListeners, 0);
});

test("기억한 ID가 다른 모듈을 가리키면 그 모듈을 고치지 않고 번들에서 다시 해석한다", async (t) => {
  const h = harness(t, true);
  Object.defineProperty(h.modules, 999, {
    get: () => {
      throw new Error('Requiring unknown module "999"');
    },
  });
  for (const stale of [
    { ...menuIds, form: 802, profiles: 901 },
    { ...menuIds, browser: 999 },
    { ...menuIds, sessions: 307 },
  ]) {
    h.nextWindow();
    h.stored.set(
      menuCacheKey,
      JSON.stringify({ bundle: "index-abcdef.js", ids: stale }),
    );
    const before = h.fetches;
    const release = contribute();
    await h.lease!.ready;
    assert.equal(h.fetches, before + 1);
    assert.equal(h.lease!.failed, false);
    assert.notEqual(h.modules[901].useAgentFormState, h.originalForm);
    assert.equal(h.modules[802].useAgentFormState, undefined);
    assert.notEqual(h.modules[802].useAgentProfilePicker, h.originalProfiles);
    assert.deepEqual(JSON.parse(h.stored.get(menuCacheKey)!).ids, menuIds);
    release();
    assert.equal(h.modules[901].useAgentFormState, h.originalForm);
    assert.equal(h.modules[802].useAgentProfilePicker, h.originalProfiles);
  }
});

test("다른 번들이나 모양이 깨진 기록은 모듈을 불러 보지 않고 버린다", async (t) => {
  const h = harness(t, true);
  for (const entry of [
    { bundle: "index-000000.js", ids: menuIds },
    { bundle: "index-abcdef.js", ids: { ...menuIds, browser: "307" } },
    { bundle: "index-abcdef.js", ids: { ...menuIds, settings: undefined } },
    // The seven IDs a build without the session store would have remembered.
    { bundle: "index-abcdef.js", ids: { ...menuIds, sessions: undefined } },
    { bundle: "index-abcdef.js", ids: [901, 802, 703, 604, 505, 406, 307] },
  ]) {
    h.nextWindow();
    h.stored.set(menuCacheKey, JSON.stringify(entry));
    const before = h.fetches;
    const release = contribute();
    assert.deepEqual(h.required, []);
    await h.lease!.ready;
    assert.equal(h.fetches, before + 1);
    assert.deepEqual(h.required, [901, 802, 703, 604, 505, 406, 307, 208]);
    assert.deepEqual(JSON.parse(h.stored.get(menuCacheKey)!), {
      bundle: "index-abcdef.js",
      ids: menuIds,
    });
    release();
  }
});

test("export 계약이 맞지 않는 앱의 ID는 기억하지 않는다", async (t) => {
  const h = harness(t, true);
  h.modules[802] = {};
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });
  const failed = contribute();
  await h.lease!.ready;
  assert.equal(h.lease!.failed, true);
  assert.equal(h.stored.size, 0);
  failed();
  h.nextWindow();
  const retried = contribute();
  await h.lease!.ready;
  assert.equal(h.fetches, 2);
  assert.equal(h.stored.size, 0);
  assert.equal(h.modules[901].useAgentFormState, h.originalForm);
  retried();
});

for (const [contract, id, incompatible] of [
  ["세션 저장소", 208, { useSessionStore: { getState: () => ({}) } }],
  ["플러그인 목록 구독", 703, { pluginRegistry: { getSnapshot: () => [] } }],
] as const)
  test(`${contract} 계약이 맞지 않는 앱은 메뉴를 고치지 않고 ID도 기억하지 않는다`, async (t) => {
    const h = harness(t, true);
    h.modules[id] = incompatible;
    const originalError = console.error;
    console.error = () => {};
    t.after(() => {
      console.error = originalError;
    });
    const release = contribute();
    await h.lease!.ready;
    assert.equal(h.lease!.failed, true);
    assert.equal(h.stored.size, 0);
    assert.equal(h.modules[901].useAgentFormState, h.originalForm);
    assert.equal(h.modules[406].useSessionSettings, h.originalSettings);
    release();
  });
