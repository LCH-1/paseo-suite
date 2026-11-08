const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createModel, keyOf, STORAGE_KEY } = require("./model.js");
const { createLoader } = require("./metadata.js");
const history = require("./history.js");
const core = process.env.PASEO_CORE_ROOT || path.resolve(__dirname, "../../../../../paseo-core");
const { createKeyboardActionDispatcher } = require(path.join(core, "packages/app/src/keyboard/keyboard-action-dispatcher.ts"));
function storage() {
  const data = new Map();
  return { getItem: (key) => data.get(key) || null, setItem: (key, value) => data.set(key, value),
    get length() { return data.size; }, key: index => [...data.keys()][index] ?? null };
}
function row(id, active = true) {
  return { tab: { key: id, tabId: id, kind: "agent", target: { kind: "agent", agentId: "agent-" + id } },
    isActive: active, isCloseHovered: false, isClosingTab: false };
}

test("보관 성공은 해당 호스트 워크스페이스의 고정·미리보기 탭을 닫고 재실행에도 반영된다", () => {
  const saved = storage(), model = createModel(saved);
  model.retainAt("host", "archived", row("a").tab);
  model.retainAt("host", "other", row("b").tab);
  model.retainAt("other-host", "archived", row("c").tab);
  model.ingest("host", "archived", [row("d")]);
  const closedBefore = Date.now();
  model.closeWorkspace("host", "archived");
  assert.deepEqual(model.entries().map(entry => entry.agentId), ["agent-b", "agent-c"]);
  assert.ok(model.tabPresence("host", "agent-a").lastClosedAt >= closedBefore);
  assert.equal(model.tabPresence("host", "agent-d").isOpen, false);
  model.ingest("host", "archived", [row("d")]);
  assert.equal(model.entries().length, 2);
  assert.deepEqual(createModel(saved).entries().map(entry => entry.agentId), ["agent-b", "agent-c"]);
});

test("두 창의 동시 고정·다른 항목 변경은 합쳐지고 닫힘과 재열기가 전파된다", () => {
  const saved = storage(), first = createModel(saved), second = createModel(saved);
  first.retainAt("host", "w", row("a").tab);
  second.retainAt("host", "w", row("b").tab);
  assert.deepEqual(createModel(saved).entries().map(entry => entry.agentId).sort(), ["agent-a", "agent-b"]);
  first.synchronize(); second.synchronize();
  second.close(keyOf("host", "w", "a"));
  first.rememberTitle("host", "agent-a", "늦은 metadata");
  assert.deepEqual(first.entries().map(entry => entry.agentId), ["agent-b"]);
  assert.deepEqual(createModel(saved).entries().map(entry => entry.agentId), ["agent-b"]);
  first.retainAt("host", "new", row("a").tab);
  second.synchronize();
  assert.equal(second.entries().find(entry => entry.agentId === "agent-a").workspaceId, "new");
  assert.ok(second.tabPresence("host", "agent-a").lastClosedAt > 0);
});

test("공유 정렬은 마지막 명시 순서를 따르며 늦은 다른 창의 추가를 버리지 않는다", () => {
  const saved = storage(), first = createModel(saved), second = createModel(saved);
  first.retainAt("host", "w", row("a").tab);
  first.retainAt("host", "w", row("b").tab);
  second.retainAt("other-host", "w", row("a").tab);
  first.reorder([keyOf("host", "w", "b"), keyOf("host", "w", "a")]);
  second.synchronize();
  assert.deepEqual(second.entries().map(entry => [entry.serverId, entry.agentId]),
    [["host", "agent-b"], ["host", "agent-a"], ["other-host", "agent-a"]]);
  assert.deepEqual(createModel(saved).entries(), second.entries());
});

test("닫힘 이벤트가 아직 도착하지 않은 창에서 명시 재열기를 하면 공유 탭이 다시 열린다", () => {
  const saved = storage(), first = createModel(saved);
  first.retainAt("host", "w", row("a").tab);
  const second = createModel(saved);
  second.close(keyOf("host", "w", "a"));
  first.retainAt("host", "w", row("a").tab, 0);
  second.synchronize();
  assert.equal(second.tabPresence("host", "agent-a").isOpen, true);
  assert.ok(second.tabPresence("host", "agent-a").lastClosedAt > 0);
  assert.equal(createModel(saved).entries().length, 1);
});

test("늦은 제목 갱신은 다른 창의 소속 변경을 되돌리지 않고 미리보기 교체는 공유 고정을 닫지 않는다", () => {
  const saved = storage(), first = createModel(saved), second = createModel(saved);
  first.retainAt("host", "old", row("a").tab);
  second.synchronize();
  first.reconcile({host: {agents: new Map([["agent-a", {id: "agent-a", workspaceId: "new"}]])}});
  second.rememberTitle("host", "agent-a", "new title");
  assert.equal(second.entries()[0].workspaceId, "new");
  const preview = createModel(saved);
  preview.ingest("host", "w", [row("preview")]);
  first.retainAt("host", "w", row("preview").tab);
  preview.ingest("host", "w", [row("next")]);
  assert.equal(createModel(saved).isPinned(keyOf("host", "w", "preview")), true);
});

test("공유 소속을 반영한 뒤 빈 agent 캐시로 reconcile해도 이전 ownership으로 되돌리지 않는다", () => {
  const saved = storage(), first = createModel(saved), second = createModel(saved);
  first.retainAt("host", "old", row("a").tab);
  second.synchronize();
  second.reconcile({host: {agents: new Map([["agent-a", {id: "agent-a", workspaceId: "new"}]])}});
  first.synchronize();
  assert.equal(first.entries()[0].workspaceId, "new");
  first.reconcile({host: {agents: new Map(), agentDetails: new Map()}});
  second.synchronize();
  assert.equal(first.entries()[0].workspaceId, "new");
  assert.equal(second.entries()[0].workspaceId, "new");
  assert.equal(createModel(saved).entries()[0].workspaceId, "new");
});

test("공유 소속은 복제된 stale snapshot을 거절하고 더 최신 서버 이동은 받아들인다", () => {
  const saved = storage();
  const snapshots = (workspaceId, time) => ({host: {agents: new Map([["agent-a",
    {id: "agent-a", workspaceId, updatedAt: new Date(time)}]]), agentDetails: new Map()}});
  let local = snapshots("old", 1000), remote = snapshots("new", 2000);
  const first = createModel(saved, () => local), second = createModel(saved, () => remote);
  first.retainAt("host", "old", row("a").tab);
  second.synchronize(); second.reconcile(remote); first.synchronize();
  for (const time of [1000, 500, 2000]) {
    local = snapshots("old", time);
    first.reconcile(local); second.synchronize();
    assert.equal(first.entries()[0].workspaceId, "new");
    assert.equal(second.entries()[0].workspaceId, "new");
  }
  local = snapshots("old", 3000);
  first.reconcile(local); second.synchronize(); second.reconcile(remote);
  assert.equal(first.entries()[0].workspaceId, "old");
  assert.equal(second.entries()[0].workspaceId, "old");
  remote = snapshots("third", 4000);
  second.reconcile(remote); first.synchronize();
  assert.equal(first.entries()[0].workspaceId, "third");
  assert.equal(createModel(saved).entries()[0].workspaceId, "third");
});

test("동일 소속의 최신 watermark를 공유하고 오래된 이동에 최신 시각을 잘못 붙이지 않는다", () => {
  const saved = storage();
  const snapshots = (workspaceId, time) => ({host: {agents: new Map([["agent-a",
    {id: "agent-a", workspaceId, updatedAt: new Date(time)}]]), agentDetails: new Map()}});
  let local = snapshots("old", 1000), remote = snapshots("new", 2000);
  const first = createModel(saved, () => local), second = createModel(saved, () => remote);
  first.retainAt("host", "old", row("a").tab);
  second.synchronize(); second.reconcile(remote); first.synchronize();
  local = snapshots("new", 5000); first.reconcile(local);
  const placementKey = STORAGE_KEY + ":shared:placement:" + JSON.stringify(["host", "agent-a"]);
  assert.equal(JSON.parse(saved.getItem(placementKey)).observedAt, 5000);
  local = snapshots("old", 3000); first.reconcile(local);
  second.synchronize(); remote = snapshots("new", 5000); second.reconcile(remote);
  assert.equal(first.entries()[0].workspaceId, "new");
  assert.equal(second.entries()[0].workspaceId, "new");
  assert.deepEqual(JSON.parse(saved.getItem(placementKey)), {workspaceId: "new", tabId: "a", observedAt: 5000});
  saved.setItem(placementKey, JSON.stringify({workspaceId: "old", tabId: "a", observedAt: 3000}));
  first.synchronize(); second.synchronize();
  assert.equal(createModel(saved).entries()[0].workspaceId, "new");
  assert.equal(JSON.parse(saved.getItem(placementKey)).observedAt, 5000);
  local = snapshots("third", 6000); first.reconcile(local); second.synchronize();
  assert.equal(second.entries()[0].workspaceId, "third");
  assert.equal(JSON.parse(saved.getItem(placementKey)).observedAt, 6000);
});

test("관측 시각이 없는 예전 공유 소속도 동일 stale 값의 객체 복제를 거절한다", () => {
  const saved = storage();
  let local = {host: {agents: new Map([["agent-a", {id: "agent-a", workspaceId: "old", updatedAt: new Date(1000)}]])}};
  const first = createModel(saved, () => local), second = createModel(saved);
  first.retainAt("host", "old", row("a").tab);
  second.synchronize();
  saved.setItem(STORAGE_KEY + ":shared:placement:" + JSON.stringify(["host", "agent-a"]), JSON.stringify({workspaceId: "new", tabId: "a"}));
  first.synchronize();
  local = {host: {agents: new Map([["agent-a", {...local.host.agents.get("agent-a")} ]])}};
  first.reconcile(local);
  assert.equal(first.entries()[0].workspaceId, "new");
  local.host.agents.set("agent-a", {id: "agent-a", workspaceId: "old", updatedAt: new Date(3000)});
  first.reconcile(local); second.synchronize();
  assert.equal(second.entries()[0].workspaceId, "old");
});

test("agents보다 최신 agentDetails 관측을 소속 보정에 사용한다", () => {
  const model = createModel(storage());
  model.retainAt("host", "old", row("a").tab);
  model.reconcile({host: {
    agents: new Map([["agent-a", {id: "agent-a", workspaceId: "old", updatedAt: new Date(1000)}]]),
    agentDetails: new Map([["agent-a", {id: "agent-a", workspaceId: "new", updatedAt: new Date(2000)}]]),
  }});
  assert.equal(model.entries()[0].workspaceId, "new");
});

test("저장소 읽기·쓰기·열거 접근거부는 로컬 탭을 유지하고 메모리 전용 진단을 제공한다", () => {
  const denied = { getItem() {throw new Error("denied");}, setItem() {throw new Error("denied");},
    key() {throw new Error("denied");}, get length() {throw new Error("denied");} };
  for (const adapter of [denied, undefined, {getItem: denied.getItem, setItem: denied.setItem, key: denied.key, get length() {return 1;}}]) {
    const model = createModel(adapter);
    model.retainAt("host", "w", row("a").tab);
    model.synchronize();
    assert.equal(model.entries()[0].agentId, "agent-a");
    assert.equal(model.storageStatus().state, "memory-only");
    assert.match(model.storageStatus().message, /현재 창의 탭은 유지/);
    model.close(model.entries()[0].key);
    assert.equal(model.entries().length, 0);
  }
});

test("저장소 쓰기가 실패해도 고정·소속·닫힘은 현재 창에서 유지된다", () => {
  const model = createModel({getItem: () => null, setItem() { throw new Error("quota"); }});
  model.retainAt("host", "old", row("a").tab);
  model.reconcile({host: {agents: new Map([["agent-a", {id: "agent-a", workspaceId: "new"}]])}});
  assert.equal(model.entries()[0].workspaceId, "new");
  model.close(model.entries()[0].key);
  assert.equal(model.entries().length, 0);
});

test("실제 닫힘만 기록하고 재시작·재열기·다른 호스트의 같은 ID를 구분한다", () => {
  const saved = storage();
  const model = createModel(saved);
  assert.deepEqual(model.tabPresence("a", "agent-x"), { isOpen: false, lastClosedAt: null });
  model.retainAt("a", "w", row("x").tab);
  model.retainAt("b", "w", row("x").tab);
  assert.deepEqual(model.tabPresence("a", "agent-x"), { isOpen: true, lastClosedAt: null });
  const before = Date.now();
  model.close(keyOf("a", "w", "x"));
  const closed = model.tabPresence("a", "agent-x").lastClosedAt;
  assert.ok(closed >= before && closed <= Date.now());
  assert.deepEqual(model.tabPresence("b", "agent-x"), { isOpen: true, lastClosedAt: null });
  model.close(keyOf("a", "w", "x"));
  assert.equal(model.tabPresence("a", "agent-x").lastClosedAt, closed);
  const restored = createModel(saved);
  assert.deepEqual(restored.tabPresence("a", "agent-x"), { isOpen: false, lastClosedAt: closed });
  restored.retainAt("a", "w2", row("x").tab);
  assert.deepEqual(restored.tabPresence("a", "agent-x"), { isOpen: true, lastClosedAt: closed });
});

test("미리보기 교체는 닫힘이고 소속 변경·고정은 닫힘이 아니다", () => {
  const model = createModel(storage());
  model.ingest("h", "w", [row("a")]);
  model.ingest("h", "w", [row("b")]);
  assert.equal(model.tabPresence("h", "agent-a").isOpen, false);
  assert.ok(model.tabPresence("h", "agent-a").lastClosedAt > 0);
  model.pin(model.preview().key);
  model.reconcile({ h: { agents: new Map([["agent-b", { id: "agent-b", workspaceId: "new" }]]) } });
  assert.deepEqual(model.tabPresence("h", "agent-b"), { isOpen: true, lastClosedAt: null });
});
test("다른 워크스페이스와 호스트의 탭을 유지하고 복원한다", () => {
  const saved = storage();
  const model = createModel(saved);
  model.ingest("host-a", "workspace-a", [row("a")]);
  model.pin(model.preview().key);
  model.ingest("host-b", "workspace-b", [row("b")]);
  model.pin(model.preview().key);
  assert.deepEqual(createModel(saved).entries().map((entry) => entry.agentId), ["agent-a", "agent-b"]);
});

test("기록 탭은 고정 글꼴로 표시되고 CtrlTab·CtrlW가 대화 보관 없이 동작한다", () => {
  const app = harness(null, true); pinned(app, ["a"]);
  app.setBridgeSnapshot({ entries: [{ draftId: "history", serverId: "", href: "/sessions", kind: "history" }], activeDraftId: "history", completions: [] });
  app.context.location.pathname = "/sessions";
  const rendered = app.renderDraft();
  const history = rendered.tabs.find((item) => item.tab.tabId === draftIdOf("history"));
  assert.equal(history.isActive, true);
  let presentation;
  app.presentation.WorkspaceTabPresentationResolver({ tab: history.tab, children(value) { presentation = value; } });
  assert.equal(presentation.label, "기록");
  assert.equal(presentation.isPreview, false);
  const stored = app.stored();
  assert.equal(app.key().prevented, 1);
  assert.deepEqual(destinations(app), ["agent-a"]);
  app.context.location.pathname = "/sessions";
  app.windowEvent("blur"); app.renderDraft();
  app.closeAction();
  assert.deepEqual(app.calls.filter(([kind]) => kind === "draft-close"), [["draft-close", "history"]]);
  assert.equal(app.model.entries().length, 1);
  assert.equal(app.stored(), stored);
});
test("닫은 탭은 재렌더링으로 부활하지 않고 다시 선택하면 열린다", () => {
  const model = createModel(storage());
  model.ingest("host", "a", [row("a")]);
  model.close(keyOf("host", "a", "a"));
  model.ingest("host", "a", [row("a")]);
  assert.equal(model.entries().length, 0);
  model.ingest("host", "b", [row("b")]);
  model.ingest("host", "a", [row("a")]);
  assert.deepEqual(model.entries().map((entry) => entry.agentId), ["agent-a"]);
});
test("같은 ID가 다른 호스트에 있어도 충돌하지 않는다", () => {
  const model = createModel(storage());
  model.ingest("one", "workspace", [row("a")]);
  model.pin(model.preview().key);
  model.ingest("two", "workspace", [row("a")]);
  assert.equal(new Set(model.entries().map((entry) => entry.key)).size, 2);
});
function harness(metadataState, withDraftBridge = false, withTitles = false, withGroups = false) {
  const effects = [];
  const calls = [];
  const scheduled = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const layoutListeners = new Set();
  const effectCleanups = new Map();
  const overlays = [];
  const popovers = [];
  const bridgeListeners = new Set();
  const externalStores = [];
  const dispatcher = createKeyboardActionDispatcher();
  const keyboardRegistrations = [];
  dispatcher.registerHandler({ handlerId: "native-workspace-close", actions: ["workspace.tab.close-current"],
    enabled: true, priority: 100, handle() { calls.push(["native-keyboard-close"]); return true; } });
  let bridgeSnapshot = { entries: [], activeDraftId: null, completions: [] };
  let groups = { groups: [], order: [] };
  const groupListeners = new Set();
  function setGroups(next) { groups = next; groupListeners.forEach(listener => listener()); }
  let registeredBar = null;
  let draftSequence = 0;
  function setBridgeSnapshot(next) {
    bridgeSnapshot = next;
    bridgeListeners.forEach((listener) => listener());
  }
  const bridge = {
    getSnapshot: () => bridgeSnapshot,
    subscribe(listener) { bridgeListeners.add(listener); return () => bridgeListeners.delete(listener); },
    registerTabBar(component) { registeredBar = component; return () => { if (registeredBar === component) registeredBar = null; }; },
    open(options = {}) {
      const draftId = "draft-" + ++draftSequence;
      context.location.pathname = "/new";
      setBridgeSnapshot({ ...bridgeSnapshot, entries: [...bridgeSnapshot.entries,
        { draftId, serverId: options.serverId || "host", href: "/new?draftId=" + draftId }], activeDraftId: draftId });
      return draftId;
    },
    activate(draftId) {
      calls.push(["draft-navigate", draftId]); context.location.pathname = "/new";
      setBridgeSnapshot({ ...bridgeSnapshot, activeDraftId: draftId });
    },
    close(draftId) {
      calls.push(["draft-close", draftId]);
      setBridgeSnapshot({ ...bridgeSnapshot, entries: bridgeSnapshot.entries.filter((entry) => entry.draftId !== draftId),
        activeDraftId: bridgeSnapshot.activeDraftId === draftId ? null : bridgeSnapshot.activeDraftId });
    },
  };
  let now = 1000;
  let layoutState = { layoutByWorkspace: { "host:a": { focusedPaneId: "main", root: { kind: "pane", pane: { id: "main", tabs: [row("a").tab], focusedTabId: "a" } } } } };
  const initialLayoutState = structuredClone(layoutState);
  let selection = { serverId: "host", workspaceId: "a" };
  const React = {
    createElement: (component, props) => ({ component, props }),
    useSyncExternalStore(subscribe, read) { externalStores.push({ subscribe, read }); return read(); },
    useState: (initial) => [initial, () => {}],
    useEffect: (callback) => effects.push(callback),
  };
  const originalRow = () => {};
  const originalPresentation = () => {};
  const rows = { WorkspaceDesktopTabsRow: originalRow };
  const presentation = { WorkspaceTabPresentationResolver: originalPresentation };
  const session = { agents: new Map([ ["agent-a", {}], ["agent-b", {}] ]), agentDetails: new Map(), workspaces: new Map([["a", {}], ["b", {}]]) };
  let sessionMap = { host: session };
  const settings = { workspaceTitleSource: "title" };
  const modules = { 1: React, 2: rows, 3: presentation,
    4: { useLastWorkspaceSelection: () => selection, getLastWorkspaceSelection: () => selection,
      navigateToWorkspace: (input) => calls.push(["navigate", input]) },
    5: { useSessionStore: Object.assign((selector) => selector({ sessions: sessionMap }), {
    getState: () => ({ sessions: sessionMap }), subscribe: () => () => {},
    }) },
    6: { useWorkspaceLayoutStore: { getState: () => layoutState,
      subscribe(listener) { layoutListeners.add(listener); return () => layoutListeners.delete(listener); },
      setState(patch) { layoutState = { ...layoutState, ...patch }; calls.push(["refresh", layoutState]); layoutListeners.forEach((listener) => listener()); } } },
    7: { normalizeAgentSnapshot: (agent) => agent },
    9: { newWorkspaceTabsBridge: bridge },
    10: { useKeyboardActionHandler(input) {
      keyboardRegistrations.push(input);
      effects.push(() => dispatcher.registerHandler(input));
    } },
    11: { selectAgentTabSidebarLabel({ session, context, workspaceTitleSource }) {
      const workspace = session?.workspaces.get(context.workspaceId);
      if (!workspace?.name) return null;
      return workspaceTitleSource === "branch" ? workspace.branch || workspace.name : workspace.name;
    }, selectAgentTabProjectLabel({ session, context }) {
      return session?.workspaces.get(context.workspaceId)?.projectName || null;
    } },
    12: { useSettings: () => ({ settings }) },
    13: { isTabGroupKeyVisible: () => true, forgetTabGroupKey(key) {
      setGroups({ ...groups, groups: groups.groups.map(group => ({ ...group, tabs: group.tabs.filter(tab => tab.key !== key) })).filter(group => group.tabs.length) });
    },
      useTabGroups: Object.assign(selector => selector({ state: groups }), {
        getState: () => ({ state: groups, update: reduce => setGroups(reduce(groups)) }),
        subscribe(listener) { groupListeners.add(listener); return () => groupListeners.delete(listener); },
      }) },
    8: { parseHostWorkspaceRouteFromPathname(pathname) {
      const match = pathname.match(/^\/h\/([^/]+)\/workspace\/([^/]+)$/);
      return match ? { serverId: decodeURIComponent(match[1]), workspaceId: decodeURIComponent(match[2]) } : null;
    } } };
  const context = { console: { info() {}, warn() {} }, localStorage: storage(), structuredClone, Date: { now: () => now },
    location: { pathname: "/h/host/workspace/a" }, document: {
      visibilityState: "visible",
      querySelectorAll(selector) { return selector === ":popover-open" ? popovers : overlays; },
      addEventListener(name, listener) { if (!documentListeners.has(name)) documentListeners.set(name, new Set()); documentListeners.get(name).add(listener); },
      removeEventListener(name, listener) { documentListeners.get(name)?.delete(listener); },
    },
    window: {
      addEventListener(name, listener) { if (!windowListeners.has(name)) windowListeners.set(name, new Set()); windowListeners.get(name).add(listener); },
      removeEventListener(name, listener) { windowListeners.get(name)?.delete(listener); },
      getComputedStyle: (node) => node.style || { display: "block", visibility: "visible" },
    },
    setInterval(callback) { scheduled.push(callback); return scheduled.length; }, clearInterval() {},
    PaseoGlobalTabsHistory: history,
    PaseoGlobalTabsModel: { createModel, STORAGE_KEY }, PaseoGlobalTabsMetadata: { createLoader: metadataState
      ? () => ({ state: () => metadataState, subscribe: () => () => {}, revision: () => 0, dispose() {} }) : createLoader },
    __PASEO_GLOBAL_TABS_MODULES__: { react: 1, rows: 2, presentation: 3, navigation: 4, sessions: 5, layouts: 6, snapshots: 7, hostRoutes: 8,
      keyboardActions: 10, ...(withDraftBridge ? { newWorkspaceTabs: 9 } : {}), ...(withTitles ? { titles: 11, settings: 12 } : {}),
      ...(withGroups ? { tabGroups: 13 } : {}) },
    __r: (id) => modules[id] };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "client.js"), "utf8"), context);
  function props(workspaceId, tabs) {
    return { normalizedServerId: "host", normalizedWorkspaceId: workspaceId, paneId: "main", tabs, isFocused: true,
      onCloseTab: (id) => calls.push(["close-native", id]), onReorderTabs: (tabs) => calls.push(["reorder", tabs]),
      onCreateNewTab: (input) => calls.push(["new-tab", input]),
      onNavigateTab: (id) => calls.push(["navigate-native", id]) };
  }
  function render(input, select = true) {
    if (select) {
      selection = { serverId: input.normalizedServerId, workspaceId: input.normalizedWorkspaceId };
      context.location.pathname = "/h/" + input.normalizedServerId + "/workspace/" + input.normalizedWorkspaceId;
      if (withDraftBridge && bridgeSnapshot.activeDraftId) setBridgeSnapshot({ ...bridgeSnapshot, activeDraftId: null });
    }
    const result = rows.WorkspaceDesktopTabsRow(input);
    const key = JSON.stringify([input.normalizedServerId, input.normalizedWorkspaceId, input.paneId]);
    effectCleanups.get(key)?.forEach((cleanup) => cleanup());
    effectCleanups.set(key, effects.splice(0).map((effect) => effect()).filter((cleanup) => typeof cleanup === "function"));
    return result.props;
  }
  return { render, props, calls, rows, presentation, context, originalRow, session, get sessionMap() { return sessionMap; }, settings, externalStores,
    replaceSessionMap(next) { sessionMap = next; },
    model: context.__PASEO_GLOBAL_TABS__.model, documentListeners, layoutListeners,
    windowListeners, overlays, popovers,
    bridge, bridgeListeners, bridgeSnapshot: () => bridgeSnapshot, setBridgeSnapshot,
    registeredBar: () => registeredBar,
    keyboardRegistrations,
    closeAction: () => dispatcher.dispatch({ id: "workspace.tab.close-current", scope: "workspace" }),
    renderDraft() { const element = registeredBar?.({}); return element ? render(element.props, false) : null; },
    key(input = {}) {
      const event = { type: "keydown", key: "Tab", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false,
        defaultPrevented: false, prevented: 0, stopped: 0, immediate: 0,
        preventDefault() { this.defaultPrevented = true; this.prevented++; },
        stopPropagation() { this.stopped++; }, stopImmediatePropagation() { this.immediate++; }, ...input };
      windowListeners.get("keydown")?.forEach((listener) => listener(event));
      return event;
    },
    windowEvent(name, event = {}) { windowListeners.get(name)?.forEach((listener) => listener(event)); },
    setGroups, groups: () => groups, groupListeners,
    tickTimers() { scheduled.forEach(callback => callback()); },
    unmount(input) { effectCleanups.get(JSON.stringify([input.normalizedServerId, input.normalizedWorkspaceId, input.paneId]))?.forEach((cleanup) => cleanup()); },
    stored: () => context.localStorage.getItem(STORAGE_KEY),
    advanceTime(milliseconds) { now += milliseconds; },
    setLayoutState(patch) { modules[6].useWorkspaceLayoutStore.setState(patch); },
    emit(name, event) { documentListeners.get(name)?.forEach((listener) => listener({ type: name, ...event })); },
    setLayout(workspaceId, tab, paneId = "main") {
      modules[6].useWorkspaceLayoutStore.setState({ layoutByWorkspace: { ...layoutState.layoutByWorkspace,
        ["host:" + workspaceId]: { focusedPaneId: paneId, root: { kind: "pane", pane: { id: paneId, tabs: [tab], focusedTabId: tab.tabId } } } } });
    },
    initialLayoutState, getLayoutState: () => layoutState, tick: () => scheduled[0]() };
}
test("통합 탭은 원래 워크스페이스로 이동하고 닫아도 대화를 종료하지 않는다", () => {
  const app = harness();
  app.render(app.props("a", [row("a")]));
  app.model.pin(app.model.preview().key);
  app.render(app.props("b", [row("b")]));
  const rendered = app.render(app.props("b", [row("b")]));
  assert.equal(rendered.tabs.length, 2);
  rendered.onNavigateTab(rendered.tabs[0].tab.tabId);
  assert.equal(app.calls[0][1].workspaceId, "a");
  assert.equal(app.calls[0][1].target.agentId, "agent-a");
  rendered.onCloseTab(rendered.tabs[0].tab.tabId);
  assert.equal(app.calls.filter(([kind]) => kind === "close-native").length, 0);
  const after = app.render(app.props("b", [row("b")]));
  assert.equal(after.tabs.length, 1);
});

test("같은 agentId의 메뉴는 클릭한 탭의 호스트를 사용하고 모호한 이전 계약은 실행하지 않는다", () => {
  const app = harness();
  const input = (serverId) => ({ ...app.props("w", [row("same")]), normalizedServerId: serverId,
    onReloadAgent: id => app.calls.push(["reload", serverId, id]),
    onCopyResumeCommand: id => app.calls.push(["resume", serverId, id]),
    onCopyAgentId: id => app.calls.push(["copy", serverId, id]) });
  app.render(input("A")); app.model.pin(app.model.preview().key);
  app.render(input("B")); app.model.pin(app.model.preview().key);
  const rendered = app.render(input("B"));
  const remote = rendered.tabs.find(row => row.tab.groupSource.serverId === "A").tab;
  rendered.onReloadAgent("agent-same", remote);
  rendered.onCopyResumeCommand("agent-same", remote);
  rendered.onCopyAgentId("agent-same", remote);
  rendered.onReloadAgent("agent-same");
  assert.deepEqual(app.calls.filter(call => ["reload", "resume", "copy"].includes(call[0])),
    [["reload", "A", "agent-same"], ["resume", "A", "agent-same"], ["copy", "A", "agent-same"]]);
  app.model.close(app.model.entries().find(entry => entry.serverId === "A").key);
  rendered.onReloadAgent("agent-same", remote);
  rendered.onRenameTab(remote);
  assert.equal(app.calls.filter(call => call[0] === "reload").length, 1);
  app.context.__PASEO_GLOBAL_TABS__.dispose();
});

test("unmount한 source의 이름변경은 새 화면 등록 후 실행하고 살아있는 다른 pane은 보존한다", () => {
  const app = harness();
  const first = {...app.props("a", [row("a")]), onRenameTab: tab => app.calls.push(["stale-rename", tab.tabId])};
  app.render(first); app.model.pin(app.model.preview().key);
  app.render(app.props("b", [row("b")]));
  const shown = app.render(app.props("b", [row("b")]));
  app.unmount(first);
  shown.onRenameTab(shown.tabs.find(row => row.tab.target.agentId === "agent-a").tab);
  assert.equal(app.calls.some(call => call[0] === "stale-rename"), false);
  assert.equal(app.calls.filter(call => call[0] === "navigate").at(-1)[1].workspaceId, "a");
  const current = {...first, onRenameTab: tab => app.calls.push(["live-rename", tab.tabId])};
  app.render(current);
  app.tickTimers();
  assert.deepEqual(app.calls.filter(call => call[0] === "live-rename"), [["live-rename", "a"]]);
  const other = {...current, paneId: "second", isFocused: false, onRenameTab: () => app.calls.push(["wrong-pane"])};
  app.render(other, false); app.unmount(other);
  const active = app.render(current);
  active.onRenameTab(active.tabs.find(row => row.tab.target.agentId === "agent-a").tab);
  assert.equal(app.calls.some(call => call[0] === "wrong-pane"), false);
  app.context.__PASEO_GLOBAL_TABS__.dispose();
});

test("소속 보정과 tabId 교체는 그룹·저장순서를 함께 옮기고 다른 호스트는 보존한다", () => {
  const app = harness(null, false, false, true);
  app.render(app.props("old", [row("a")])); app.model.pin(app.model.preview().key);
  const before = app.model.entries()[0], key = "global-agent:" + before.key;
  const remoteKey = "global-agent:" + keyOf("other", "old", "a");
  app.setGroups({ groups: [{id: "g", tabs: [
    {key, tabId: key, target: {kind: "agent", agentId: "agent-a"}, groupSource: {serverId: "host", workspaceId: "old", tabId: "a"}},
    {key: remoteKey, tabId: remoteKey, target: {kind: "agent", agentId: "agent-a"}, groupSource: {serverId: "other", workspaceId: "old", tabId: "a"}},
  ]}], order: [key, remoteKey] });
  app.model.reconcile({host: {agents: new Map([["agent-a", {id: "agent-a", workspaceId: "new"}]])}});
  app.model.retainAt("host", "new", {...row("a").tab, tabId: "new-id"});
  const next = "global-agent:" + keyOf("host", "new", "new-id");
  assert.deepEqual(Array.from(app.groups().order), [next, remoteKey]);
  assert.equal(app.groups().groups[0].tabs[0].groupSource.workspaceId, "new");
  assert.equal(app.groups().groups[0].tabs[0].groupSource.tabId, "new-id");
  assert.equal(app.groups().groups[0].tabs[1].key, remoteKey);
  app.context.__PASEO_GLOBAL_TABS__.dispose();
  assert.equal(app.groupListeners.size, 0);
});

test("storage 이벤트는 다른 창의 공유 고정과 닫힘을 현재 행에 반영하고 dispose 때 해제한다", () => {
  const app = harness();
  app.render(app.props("a", [row("a")])); app.model.pin(app.model.preview().key);
  const other = createModel(app.context.localStorage);
  other.retainAt("host", "b", row("b").tab);
  app.windowEvent("storage", {key: STORAGE_KEY});
  assert.equal(app.model.entries().length, 2);
  other.close(keyOf("host", "a", "a"));
  app.windowEvent("storage", {key: STORAGE_KEY + ":shared:presence:" + JSON.stringify(["host", "agent-a"])});
  assert.deepEqual(app.model.entries().map(entry => entry.agentId), ["agent-b"]);
  app.context.__PASEO_GLOBAL_TABS__.dispose();
  assert.equal(app.windowListeners.get("storage").size, 0);
});
test("탭 정렬에서 외부 탭을 현재 레이아웃에 저장하지 않는다", () => {
  const app = harness();
  app.render(app.props("a", [row("a")]));
  app.model.pin(app.model.preview().key);
  app.render(app.props("b", [row("b")]));
  const rendered = app.render(app.props("b", [row("b")]));
  rendered.onReorderTabs(rendered.tabs.map((item) => item.tab).reverse());
  assert.deepEqual(app.calls.filter(([kind]) => kind === "reorder"), []);
  assert.deepEqual(Array.from(app.model.entries(), entry=>entry.agentId), ["agent-b","agent-a"]);
});
test("다른 워크스페이스의 탭 제목은 원래 워크스페이스에서 가져온다", () => {
  const app = harness();
  app.render(app.props("a", [row("a")]));
  app.model.pin(app.model.preview().key);
  const rendered = app.render(app.props("b", [row("b")]));
  const result = app.presentation.WorkspaceTabPresentationResolver({ tab: rendered.tabs[0].tab, serverId: "wrong", workspaceId: "wrong" });
  assert.equal(result.props.serverId, "host");
  assert.equal(result.props.workspaceId, "a");
  assert.equal(result.props.tab.tabId, "a");
  app.context.__PASEO_GLOBAL_TABS__.dispose();
  assert.equal(app.rows.WorkspaceDesktopTabsRow, app.originalRow);
});
test("새로고침 직후 탭 행을 갱신해도 원래 레이아웃 값은 바뀌지 않는다", () => {
  const app = harness();
  const before = app.getLayoutState();
  app.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(app.getLayoutState())), app.initialLayoutState);
  assert.notEqual(app.getLayoutState().layoutByWorkspace["host:a"], before.layoutByWorkspace["host:a"]);
  app.render(app.props("a", [row("a")]));
  app.tick();
  assert.equal(app.calls.filter(([kind]) => kind === "refresh").length, 1);
});
test("마지막 탭을 닫으면 대화를 종료하지 않고 새 탭 화면을 연다", () => {
  const app = harness();
  app.render(app.props("a", [row("a")]));
  const rendered = app.render(app.props("a", [row("a")]));
  rendered.onCloseTab(rendered.tabs[0].tab.tabId);
  assert.equal(app.calls.filter(([kind]) => kind === "close-native").length, 0);
  assert.equal(app.calls.filter(([kind]) => kind === "new-tab").length, 1);
});

test("완료되지 않은 워크스페이스 목록에서 기존 통합 탭을 숨기지 않는다", () => {
  const app = harness();
  app.render(app.props("a", [row("a")]));
  app.model.pin(app.model.preview().key);
  app.session.workspaces = new Map([["b", {}]]);
  app.render(app.props("b", [row("b")]));
  const rendered = app.render(app.props("b", [row("b")]));
  assert.equal(rendered.tabs.length, 2);
});

test("존재하지 않는 대화가 확인되면 스켈레톤 대신 상태를 표시하고 기존 표시 속성을 유지한다", () => {
  const app = harness({ tag: "missing" });
  app.render(app.props("a", [row("a")]));
  const rendered = app.render(app.props("a", [row("a")]));
  const element = app.presentation.WorkspaceTabPresentationResolver({ tab: rendered.tabs[0].tab,
    serverId: "host", workspaceId: "a", children: (presentation) => presentation });
  const icon = () => {};
  const input = { titleState: "loading", label: "", tooltip: "agent-a", icon, statusBucket: "running" };
  const output = element.props.children(input);
  assert.equal(output.titleState, "ready");
  assert.equal(output.label, "대화를 찾을 수 없음");
  assert.equal(output.icon, icon);
  assert.equal(output.statusBucket, "running");
  const ready = { ...input, label: "정상 제목", titleState: "ready" };
  assert.deepEqual({ ...element.props.children(ready) }, { ...ready, isPreview: true });
});

test("동일한 탭 표시 정보는 부모 재렌더링에도 같은 참조로 전달해 반복 갱신을 막는다", () => {
  const app = harness(undefined, false, true);
  app.session.workspaces.set("a", { name: "Workspace", projectName: "Project" });
  app.render(app.props("a", [row("a")]));
  const rendered = app.render(app.props("a", [row("a")]));
  const tab = rendered.tabs[0].tab;
  const icon = () => {};
  const base = { label: "Conversation", titleState: "ready", icon, statusBucket: "running", completedAt: 123 };
  const resolve = input => app.presentation.WorkspaceTabPresentationResolver({ tab, children: value => value }).props.children(input);
  const first = resolve(base);
  for (let index = 0; index < 20; index++) assert.equal(resolve({ ...base }), first);
  const idle = resolve({ ...base, statusBucket: null });
  assert.notEqual(idle, first);
  assert.equal(idle.statusBucket, null);
  app.model.pin(app.model.preview().key);
  assert.equal(resolve(base).isPreview, false);
  app.session.workspaces.set("a", { name: "Renamed", projectName: "Project" });
  assert.equal(resolve(base).label, "Project-Renamed");
  app.session.workspaces.clear();
  const plain = resolve(base);
  assert.equal(resolve({ ...base }), plain);
});

test("탭 표시를 부모 상태에 반영해도 React 갱신이 반복되지 않고 실제 상태 변경만 반영한다", async () => {
  const React = require("react");
  const { create, act } = require("react-test-renderer");
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const app = harness();
  app.render(app.props("a", [row("a")]));
  const tab = app.render(app.props("a", [row("a")])).tabs[0].tab;
  let commits = 0;
  function Host({ status }) {
    const [, setPresentation] = React.useState(null);
    const resolved = app.presentation.WorkspaceTabPresentationResolver({ tab, children: value => value });
    const presentation = resolved.props.children({ label: "Conversation", titleState: "ready", statusBucket: status });
    React.useLayoutEffect(() => {
      commits++;
      if (commits < 10) setPresentation(presentation);
    }, [presentation]);
    return null;
  }
  let root;
  try {
    await act(async () => { root = create(React.createElement(Host, { status: "running" })); });
    assert.equal(commits, 1);
    await act(async () => { root.update(React.createElement(Host, { status: null })); });
    assert.equal(commits, 2);
  } finally {
    await act(async () => root?.unmount());
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    app.context.__PASEO_GLOBAL_TABS__.dispose();
  }
});

test("대화 스트림만 바뀌면 탭 목록 snapshot을 유지하고 이름·보관 변경은 반영한다", () => {
  const app = harness();
  const props = app.props("a", [row("a")]);
  app.render(props);
  app.render(props);
  const store = app.externalStores.at(-1);
  const before = store.read();
  for (let index = 0; index < 100; index++) {
    app.replaceSessionMap({ ...app.sessionMap, host: { ...app.sessionMap.host, timelineRevision: index } });
    assert.equal(store.read(), before);
  }
  app.replaceSessionMap({ ...app.sessionMap, unrelated: { agents: new Map(), agentDetails: new Map(), workspaces: new Map() } });
  assert.equal(store.read(), before);
  const renamed = new Map(app.sessionMap.host.workspaces);
  renamed.set("a", { name: "Renamed" });
  app.replaceSessionMap({ ...app.sessionMap, host: { ...app.sessionMap.host, workspaces: renamed } });
  const next = store.read();
  assert.notEqual(next, before);
  assert.equal(next.host.workspaces.get("a").name, "Renamed");
  const archived = new Map(app.sessionMap.host.agents);
  archived.set("agent-a", { archivedAt: "now" });
  app.replaceSessionMap({ ...app.sessionMap, host: { ...app.sessionMap.host, agents: archived } });
  assert.equal(app.render(props).tabs.length, 0);
});

test("모델의 host 추가·제거와 agentDetails hydration은 탭 snapshot에 반영한다", () => {
  const app = harness();
  const props = app.props("a", [row("a")]);
  app.render(props); app.render(props);
  const store = app.externalStores.at(-1);
  const before = store.read();
  app.sessionMap.remote = { agents: new Map(), agentDetails: new Map(), workspaces: new Map() };
  const remote = app.model.retainAt("remote", "r", row("r").tab);
  const added = store.read();
  assert.notEqual(added, before);
  assert.equal(added.remote, app.sessionMap.remote);
  app.model.close(remote.key);
  const removed = store.read();
  assert.notEqual(removed, added);
  assert.equal(removed.remote, undefined);
  app.replaceSessionMap({ ...app.sessionMap, host: { ...app.sessionMap.host,
    agentDetails: new Map([["agent-a", { id: "agent-a", workspaceId: "hydrated" }]]) } });
  const hydrated = store.read();
  assert.notEqual(hydrated, removed);
  assert.equal(hydrated.host.agentDetails.get("agent-a").workspaceId, "hydrated");
  app.render(props);
  assert.equal(app.model.entries()[0].workspaceId, "hydrated");
});

test("미리보기는 전역 하나이며 그 자리를 교체하고 고정 탭만 복원한다", () => {
  const saved = storage();
  const model = createModel(saved);
  model.ingest("host", "a", [row("a"), row("inactive", false)]);
  assert.equal(model.entries().length, 1);
  model.pin(model.preview().key);
  model.ingest("host", "b", [row("b")]);
  model.ingest("host", "c", [row("c")]);
  assert.deepEqual(model.entries().map((entry) => [entry.agentId, entry.pinned]), [["agent-a", true], ["agent-c", false]]);
  assert.deepEqual(createModel(saved).entries().map((entry) => entry.agentId), ["agent-a"]);
  model.ingest("host", "a", [row("a")]);
  assert.equal(model.preview().agentId, "agent-c");
  const revision = model.revision();
  assert.equal(model.pin(model.entries()[0].key), false);
  assert.equal(model.revision(), revision);
});

test("v1 저장 탭을 고정으로 마이그레이션하고 v2 미리보기는 복원하지 않는다", () => {
  const saved = storage();
  const entries = ["a", "b"].map((id) => ({ serverId: "host", workspaceId: id, tabId: id, agentId: "agent-" + id }));
  saved.setItem(STORAGE_KEY, JSON.stringify({ entries }));
  const migrated = createModel(saved);
  assert.equal(migrated.entries().length, 2);
  assert.ok(migrated.entries().every((entry) => migrated.isPinned(entry.key)));
  assert.equal(JSON.parse(saved.getItem(STORAGE_KEY)).schemaVersion, 2);
  const versionTwo = storage();
  versionTwo.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 2, entries: [{ ...entries[0], pinned: true }, { ...entries[1], pinned: false }] }));
  assert.deepEqual(createModel(versionTwo).entries().map((entry) => entry.agentId), ["agent-a"]);
});

test("확정된 소속으로만 이동·중복 병합하며 고정 여부와 첫 위치 및 호스트를 보존한다", () => {
  const saved = storage();
  saved.setItem(STORAGE_KEY, JSON.stringify({ entries: [
    { serverId: "one", workspaceId: "old", tabId: "a", agentId: "agent-a" },
    { serverId: "one", workspaceId: "other", tabId: "b", agentId: "agent-b" },
    { serverId: "one", workspaceId: "wrong", tabId: "duplicate", agentId: "agent-a" },
    { serverId: "two", workspaceId: "independent", tabId: "a", agentId: "agent-a" },
  ] }));
  const model = createModel(saved);
  model.reconcile({ one: { agents: new Map(), agentDetails: new Map() } });
  assert.equal(model.entries().length, 3);
  const actual = { id: "agent-a", workspaceId: "actual" };
  const sessionMap = { one: { agents: new Map([["agent-a", actual]]), agentDetails: new Map() } };
  model.reconcile(sessionMap);
  assert.deepEqual(model.entries().map((entry) => [entry.serverId, entry.workspaceId]), [["one", "actual"], ["one", "other"], ["two", "independent"]]);
  assert.equal(model.entries()[0].tabId, "a");
  assert.ok(model.entries()[0].pinned);
  const revision = model.revision();
  model.reconcile(sessionMap);
  model.ingest("one", "old", [row("a")]);
  assert.equal(model.revision(), revision);
  assert.equal(model.entries().length, 3);
});

test("재소속 전에 같은 대화를 다시 열어도 기존 고정을 보존하고 확정 소속으로 이동한다", () => {
  const model = createModel(storage());
  model.ingest("host", "old", [row("a")]);
  model.pin(model.preview().key);
  model.ingest("host", "wrong", [row("a")]);
  assert.equal(model.entries().length, 1);
  assert.equal(model.entries()[0].pinned, true);
  model.reconcile({ host: { agents: new Map([["agent-a", { id: "agent-a", workspaceId: "actual" }]]), agentDetails: new Map() } });
  assert.equal(model.entries().length, 1);
  assert.equal(model.preview(), null);
  assert.equal(model.entries()[0].workspaceId, "actual");
});

test("재소속으로 native tabId가 달라도 닫은 활성 대화는 재렌더링에서 다시 열리지 않는다", () => {
  const saved = storage();
  saved.setItem(STORAGE_KEY, JSON.stringify({ entries: [{ serverId: "host", workspaceId: "old", tabId: "old-tab", agentId: "agent-a" }] }));
  const model = createModel(saved);
  model.reconcile({ host: { agents: new Map([["agent-a", { id: "agent-a", workspaceId: "actual" }]]) } });
  model.ingest("host", "actual", [row("a")]);
  model.close(model.entries()[0].key);
  model.ingest("host", "old", [row("a")]);
  assert.equal(model.entries().length, 0);
  model.ingest("host", "b", [row("b")]);
  model.ingest("host", "actual", [row("a")]);
  assert.equal(model.entries().length, 1);
  assert.equal(model.entries()[0].workspaceId, "actual");
});

function element(attributes = {}, parentElement = null, tagName = "DIV") {
  const node = { attributes, parentElement, tagName,
    getAttribute(name) { return this.attributes[name] ?? null; },
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); },
    contains(other) { for (let item = other; item; item = item.parentElement) if (item === this) return true; return false; } };
  return node;
}
test("호스트 제목 resolver 설치와 무관하게 사이드바 이름·프로젝트·표시 설정 변경을 반영한다", () => {
  const app = harness(undefined, false, true);
  app.session.workspaces.set("a", { name: "Renamed sidebar", projectName: "Project", branch: "feature/sidebar" });
  app.session.agents.get("agent-a").title = "Saved agent title";
  app.render(app.props("a", [row("a")]));
  const rendered = app.render(app.props("a", [row("a")]));
  function title() {
    const element = app.presentation.WorkspaceTabPresentationResolver({ tab: rendered.tabs[0].tab,
      serverId: "wrong-host", workspaceId: "wrong-workspace", children: (value) => value });
    return element.props.children({ label: "Saved agent title", titleState: "ready", statusBucket: "running" });
  }
  assert.deepEqual(JSON.parse(JSON.stringify(title().titleLines)), { primaryLabel: "Project", secondaryLabel: "Renamed sidebar" });
  app.session.workspaces.set("a", { name: "Second name", projectName: "New project", branch: "feature/sidebar" });
  assert.equal(title().label, "New project-Second name");
  assert.equal(title().tooltip, title().label);
  assert.equal(title().statusBucket, "running");
  assert.equal(title().isPreview, true);
  app.settings.workspaceTitleSource = "branch";
  assert.equal(title().label, "New project-feature/sidebar");
  assert.equal(app.session.agents.get("agent-a").title, "Saved agent title");
});
test("이름 projection은 native 완료 시각을 보존하며 완료 전 탭에는 시각을 추가하지 않는다", () => {
  const app = harness(undefined, false, true);
  app.session.workspaces.set("a", { name: "Workspace", projectName: "Project" });
  app.render(app.props("a", [row("a")]));
  const rendered = app.render(app.props("a", [row("a")]));
  const element = app.presentation.WorkspaceTabPresentationResolver({ tab: rendered.tabs[0].tab, children: value => value });
  const completed = element.props.children({ label: "original", titleState: "ready", completedAt: 12345 });
  assert.equal(completed.titleLines.completedAt, 12345);
  const active = element.props.children({ label: "original", titleState: "ready", completedAt: null });
  assert.equal(active.titleLines.completedAt, undefined);
});

test("다른 호스트의 같은 workspace ID와 metadata 미확정 제목을 섞지 않는다", () => {
  const app = harness(undefined, false, true);
  app.session.workspaces.set("a", { name: "Local name", projectName: "Local" });
  app.sessionMap.remote = { agents: new Map(), agentDetails: new Map(), workspaces: new Map([["a", { name: "Remote name", projectName: "Remote" }]]) };
  app.render({ ...app.props("a", [row("a")]), normalizedServerId: "remote" });
  const rendered = app.render({ ...app.props("a", [row("a")]), normalizedServerId: "remote" });
  const element = app.presentation.WorkspaceTabPresentationResolver({ tab: rendered.tabs[0].tab,
    children: (value) => value });
  assert.equal(element.props.children({ label: "Saved", titleState: "ready" }).label, "Remote-Remote name");
  app.sessionMap.remote.workspaces.clear();
  assert.equal(element.props.children({ label: "Saved", titleState: "ready" }).label, "Saved");
});
function composer(paneId = "main", dialog = false) {
  const pane = paneId ? element({ "data-testid": "workspace-pane-" + paneId }) : null;
  const setup = dialog ? element({ "data-testid": "workspace-setup-dialog" }, pane) : pane;
  const root = element({ "data-testid": "message-input-root" }, setup);
  return Object.assign(element({ "data-composer-input": "true" }, root, "TEXTAREA"), { value: "", disabled: false, readOnly: false });
}

test("상단 탭과 사이드바의 중첩 텍스트 더블클릭은 고정하며 액션 버튼은 무시한다", () => {
  const app = harness();
  app.render(app.props("a", [row("a")]));
  const top = element({ "data-testid": "workspace-tab-agent_agent-a" });
  app.emit("dblclick", { target: element({}, top) });
  assert.equal(app.model.isPinned(app.model.entries()[0].key), true);
  app.render(app.props("b", [row("b")]));
  app.setLayout("b", row("b").tab);
  const sidebar = element({ "data-testid": "agent-row-host-agent-b" });
  app.emit("dblclick", { target: element({}, sidebar, "BUTTON") });
  assert.equal(app.model.preview().agentId, "agent-b");
  app.emit("dblclick", { target: element({ "data-testid": "agent-row-title-host-agent-b" }, sidebar) });
  assert.equal(app.model.preview(), null);
});

test("활동 사이드바 중첩 텍스트 더블클릭은 미리보기 대화를 고정한다", () => {
  const app = harness();
  app.render(app.props("b", [row("b")]));
  app.setLayout("b", row("b").tab);
  const activity = element({ "data-testid": "sidebar-activity-session-host-agent-b" }, null, "BUTTON");
  app.emit("dblclick", { target: element({}, activity, "BUTTON") });
  assert.equal(app.model.preview().agentId, "agent-b");
  app.emit("dblclick", { target: element({}, activity) });
  assert.equal(app.model.preview(), null);
  assert.equal(app.model.isPinned(app.model.entries()[0].key), true);
});

test("활동 사이드바 더블클릭은 늦게 열린 대화를 고정하고 다른 미리보기에는 적용하지 않는다", () => {
  const app = harness();
  app.render(app.props("a", [row("a")]));
  const activity = element({ "data-testid": "sidebar-activity-session-host-agent-b" });
  app.emit("dblclick", { target: element({}, activity) });
  assert.equal(app.model.preview().agentId, "agent-a");
  app.render(app.props("b", [row("b")]));
  app.setLayout("b", row("b").tab);
  assert.equal(app.model.preview(), null);
  assert.equal(app.model.entries()[0].agentId, "agent-b");
});

test("사이드바 워크스페이스 더블클릭을 늦은 라우팅과 레이아웃 반영 이후 한 번 적용한다", () => {
  const app = harness();
  app.render(app.props("a", [row("a")]));
  const workspace = element({ "data-testid": "sidebar-workspace-row-host:b" });
  app.emit("dblclick", { target: element({}, workspace) });
  assert.equal(app.model.preview().agentId, "agent-a");
  app.render(app.props("b", [row("b")]));
  assert.equal(app.model.preview(), null);
  app.setLayout("b", row("b").tab);
  assert.equal(app.model.preview(), null);
  assert.equal(app.model.entries().length, 1);
  assert.equal(app.model.entries()[0].agentId, "agent-b");
});

test("사이드바 대화 더블클릭은 해당 대화가 활성화될 때까지 다른 대화를 고정하지 않는다", () => {
  const app = harness();
  app.render(app.props("a", [row("a")]));
  app.emit("dblclick", { target: element({ "data-testid": "agent-row-host-agent-b" }) });
  assert.equal(app.model.preview().agentId, "agent-a");
  app.render(app.props("a", [row("b")]));
  assert.equal(app.model.preview().agentId, "agent-b");
  app.setLayout("a", row("b").tab);
  assert.equal(app.model.preview(), null);
  assert.equal(app.model.entries()[0].agentId, "agent-b");
});

test("첫 실제 composer 입력과 IME 조합에서만 해당 pane 대화를 고정한다", () => {
  const app = harness();
  app.render(app.props("a", [row("a")]));
  const input = composer();
  app.emit("compositionupdate", { target: input, data: "" });
  app.emit("input", { target: input, inputType: "deleteContentBackward" });
  app.emit("input", { target: element({}, null, "INPUT"), data: "검색" });
  app.emit("input", { target: composer("main", true), data: "setup" });
  app.context.location.pathname = "/settings";
  app.emit("input", { target: input, data: "설정" });
  app.context.location.pathname = "/h/host/workspace/a";
  app.emit("input", { target: input, data: "programmatic", isTrusted: false });
  assert.equal(app.model.preview().agentId, "agent-a");
  app.emit("compositionupdate", { target: input, data: "ㅎ", isTrusted: true });
  assert.equal(app.model.preview(), null);
  app.render(app.props("b", [row("b")]));
  app.setLayout("b", row("b").tab, "second");
  const draft = composer("second");
  draft.value = "한";
  app.emit("input", { target: draft, inputType: "insertText", isTrusted: true });
  assert.equal(app.model.preview(), null);
  assert.deepEqual(app.model.entries().map((entry) => entry.agentId), ["agent-a", "agent-b"]);
});

test("활동 행이 다시 마운트되어도 같은 대화의 빠른 두 클릭은 고정한다", () => {
  const app = harness();
  app.render(app.props("a", [row("a")]));
  const click = id => app.emit("click", { target: element({}, element({ "data-testid": "sidebar-activity-session-host-" + id })) });
  click("agent-a");
  app.advanceTime(150);
  click("agent-b");
  assert.equal(app.model.preview().agentId, "agent-a");
  app.advanceTime(600);
  click("agent-a");
  assert.equal(app.model.preview().agentId, "agent-a");
  app.advanceTime(150);
  click("agent-a");
  assert.equal(app.model.preview(), null);
});

test("pane 래퍼 없는 집중 화면에서도 첫 채팅 입력은 현재 대화를 고정한다", () => {
  const app = harness();
  app.render(app.props("a", [row("a")]));
  app.emit("input", { target: composer(null), data: "첫 글자", isTrusted: true });
  assert.equal(app.model.preview(), null);
});

test("레이아웃 초기화 전 입력도 현재 pane의 실제 대화 source로 고정한다", () => {
  const app = harness();
  app.setLayoutState({ layoutByWorkspace: {} });
  app.render(app.props("a", [row("a")]));
  app.emit("compositionupdate", { target: composer(), data: "ㅎ", isTrusted: true });
  assert.equal(app.model.preview(), null);
});

test("새 대화 작성 pane·읽기전용 입력은 고정하지 않으며 dispose는 모든 listener를 해제한다", () => {
  const app = harness();
  app.render(app.props("a", [row("a")]));
  app.setLayout("a", { tabId: "draft", target: { kind: "draft" } });
  app.emit("input", { target: composer(), data: "draft" });
  app.setLayout("a", row("a").tab);
  const readonly = composer(); readonly.readOnly = true;
  app.emit("input", { target: readonly, data: "readonly" });
  assert.equal(app.model.preview().agentId, "agent-a");
  assert.equal([...app.documentListeners.values()].reduce((total, set) => total + set.size, 0), 5);
  assert.equal(app.layoutListeners.size, 1);
  const plugin = app.context.__PASEO_GLOBAL_TABS__;
  plugin.dispose(); plugin.dispose();
  assert.equal([...app.documentListeners.values()].reduce((total, set) => total + set.size, 0), 0);
  assert.equal(app.layoutListeners.size, 0);
  app.emit("input", { target: composer(), data: "after-dispose" });
  assert.equal(app.model.preview().agentId, "agent-a");
});

test("공식 metadata로 재소속한 보관 대화는 표시에서만 제외한다", () => {
  const app = harness();
  app.render(app.props("a", [row("a")]));
  app.model.pin(app.model.preview().key);
  app.session.agents.set("agent-a", { id: "agent-a", workspaceId: "b", archivedAt: "now" });
  app.render(app.props("a", [row("a")]));
  const output = app.render(app.props("a", [row("a")]));
  assert.equal(app.model.entries().length, 1);
  assert.equal(app.model.entries()[0].workspaceId, "b");
  assert.equal(output.tabs.length, 0);
  assert.equal(app.calls.filter(([kind]) => kind === "close-native").length, 0);
});

function nativeRow(id, kind, active = false) {
  return { tab: { key: id, tabId: id, kind, target: { kind } }, isActive: active };
}
function pinned(app, ids = ["a", "b", "c"]) {
  for (const id of ids) {
    app.model.ingest("host", id, [row(id)]);
    app.model.pin(app.model.preview().key);
  }
}
function destinations(app) {
  return app.calls.filter(([kind]) => kind === "navigate" || kind === "navigate-native")
    .map(([kind, value]) => kind === "navigate" ? value.target.agentId : value);
}

test("Ctrl+W dispatcher는 native100보다 먼저 현재 대화만 X 경로로 닫고 미리보기·다른 pin을 보존한다", () => {
  const app = harness(); pinned(app, ["a", "b"]);
  app.model.ingest("host", "c", [row("c")]);
  app.render(app.props("a", [row("a")]));
  const retained = app.model.entries().filter((entry) => entry.agentId !== "agent-a").map((entry) => ({ ...entry }));
  const nativeBefore = app.getLayoutState();
  let closeCalls = 0;
  const close = app.model.close;
  app.model.close = (key) => { closeCalls++; return close(key); };
  assert.equal(app.closeAction(), true);
  assert.equal(app.closeAction(), true);
  assert.equal(closeCalls, 1);
  assert.deepEqual(app.model.entries().map((entry) => ({ ...entry })), retained);
  assert.equal(app.model.preview().agentId, "agent-c");
  assert.equal(app.getLayoutState(), nativeBefore);
  assert.deepEqual(app.calls.filter(([kind]) => kind === "close-native" || kind === "native-keyboard-close"), []);
  assert.deepEqual(destinations(app), ["agent-b"]);
  const registration = app.keyboardRegistrations.findLast((item) => item.actions.includes("workspace.tab.close-current"));
  assert.equal(registration.priority, 1000);
  assert.deepEqual(Array.from(registration.actions), ["workspace.tab.close-current"]);
  assert.ok(registration.handlerId.startsWith("global-workspace-tabs:close:"));
});

test("Ctrl+W dispatcher는 현재 파일·터미널의 기존 native close를 지연 렌더 중에도 한 번만 호출한다", () => {
  for (const kind of ["file", "terminal"]) {
    const app = harness(); pinned(app, ["a"]);
    const active = nativeRow("active-" + kind, kind, true);
    app.setLayout("a", active.tab);
    app.render(app.props("a", [row("a", false), active]));
    const saved = app.stored();
    assert.equal(app.closeAction(), true);
    assert.equal(app.closeAction(), true);
    assert.deepEqual(app.calls.filter(([name]) => name === "close-native"), [["close-native", active.tab.tabId]]);
    assert.equal(app.calls.filter(([name]) => name === "native-keyboard-close").length, 0);
    assert.equal(app.stored(), saved);
  }
});

test("Ctrl+W native 비동기 확인 중에는 중복을 소비하고 취소·실패 완료 후 같은 탭을 다시 시도한다", async () => {
  const app = harness(); pinned(app, ["a"]);
  const active = nativeRow("modified-file", "file", true);
  let settle;
  let calls = 0;
  app.setLayout("a", active.tab);
  app.render({ ...app.props("a", [row("a", false), active]), onCloseTab() {
    calls++;
    return new Promise((resolve, reject) => { settle = { resolve, reject }; });
  } });
  app.closeAction();
  await Promise.resolve();
  app.closeAction();
  assert.equal(calls, 1);
  settle.resolve();
  await new Promise(setImmediate);
  app.closeAction();
  assert.equal(calls, 2);
  settle.reject(new Error("fixture close failure"));
  await new Promise(setImmediate);
  app.closeAction();
  assert.equal(calls, 3);
  assert.equal(app.calls.filter(([name]) => name === "native-keyboard-close").length, 0);
  app.context.__PASEO_GLOBAL_TABS__.dispose();
});

test("Ctrl+W dispatcher는 작성 탭의 X 경로만 사용하고 고정 대화를 유지한다", () => {
  const app = harness(null, true); pinned(app, ["a"]);
  app.model.ingest("host", "p", [row("p")]);
  const id = app.bridge.open();
  app.renderDraft();
  const saved = app.stored();
  const entries = app.model.entries().map((entry) => ({ ...entry }));
  assert.equal(app.closeAction(), true);
  assert.deepEqual(app.calls.filter(([name]) => name === "draft-close"), [["draft-close", id]]);
  assert.deepEqual(app.model.entries().map((entry) => ({ ...entry })), entries);
  assert.equal(app.model.preview(), null);
  assert.equal(app.stored(), saved);
  assert.equal(app.calls.filter(([name]) => name === "close-native" || name === "native-keyboard-close").length, 0);
});

test("Ctrl+W로 마지막 작성 탭을 닫으면 이전 대화나 새 작성 탭을 만들지 않고 native new_tab으로 복귀한다", () => {
  const app = harness(null, true);
  const id = app.bridge.open();
  app.renderDraft();
  assert.equal(app.closeAction(), true);
  assert.equal(app.bridgeSnapshot().entries.length, 0);
  assert.equal(app.model.entries().length, 0);
  assert.deepEqual(app.calls.filter(([name]) => name === "draft-close"), [["draft-close", id]]);
  const navigations = app.calls.filter(([name]) => name === "navigate");
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0][1].serverId, "host");
  assert.equal(navigations[0][1].workspaceId, "a");
  assert.equal(navigations[0][1].target.kind, "new_tab");
  assert.equal(app.calls.filter(([name]) => name === "native-keyboard-close").length, 0);
});

test("Ctrl+W dispatcher는 마지막 렌더된 stale pane 대신 live focused pane만 닫는다", () => {
  const app = harness(); pinned(app, ["a"]);
  const leftTab = nativeRow("left-file", "file", true);
  const rightTab = nativeRow("right-terminal", "terminal", true);
  app.setLayoutState({ layoutByWorkspace: { "host:a": { focusedPaneId: "right", root: { kind: "group", group: { children: [
    { kind: "pane", pane: { id: "left", tabs: [leftTab.tab], focusedTabId: leftTab.tab.tabId } },
    { kind: "pane", pane: { id: "right", tabs: [rightTab.tab], focusedTabId: rightTab.tab.tabId } },
  ] } } } } });
  const right = { ...app.props("a", [rightTab]), paneId: "right", onCloseTab: (id) => app.calls.push(["right-close", id]) };
  app.render(right);
  app.render({ ...app.props("a", [leftTab]), paneId: "left", onCloseTab: (id) => app.calls.push(["left-close", id]) });
  assert.equal(app.closeAction(), true);
  assert.deepEqual(app.calls.filter(([name]) => name.endsWith("-close")), [["right-close", "right-terminal"]]);
});

test("Ctrl+W global handler는 소유권·다른 route·unmount·dispose 후 native dispatcher 동작을 돌려준다", () => {
  const app = harness(); pinned(app, ["a"]);
  const props = app.props("a", [row("a")]);
  app.render({ ...props, ownsKeyboardShortcuts: false });
  app.closeAction();
  app.render(props);
  app.context.location.pathname = "/settings";
  app.closeAction();
  app.context.location.pathname = "/h/host/workspace/a";
  app.unmount(props);
  app.closeAction();
  app.render(props);
  app.context.__PASEO_GLOBAL_TABS__.dispose();
  app.closeAction();
  app.unmount(props);
  assert.equal(app.calls.filter(([name]) => name === "native-keyboard-close").length, 4);
  assert.equal(app.model.entries().length, 1);
  assert.equal(app.calls.filter(([name]) => name === "close-native").length, 0);
});

test("Ctrl+Tab은 보이는 전역·파일·터미널 순서로 끝을 순환하고 저장·고정 상태를 바꾸지 않는다", () => {
  const app = harness(); pinned(app);
  app.render(app.props("a", [row("a"), nativeRow("file", "file"), nativeRow("terminal", "terminal")]));
  const before = app.stored();
  const revision = app.model.revision();
  for (let index = 0; index < 5; index++) {
    const event = app.key();
    assert.equal(event.prevented, 1);
    assert.equal(event.stopped, 1);
    assert.equal(event.immediate, 1);
  }
  app.key({ shiftKey: true }); app.key({ shiftKey: true });
  assert.deepEqual(destinations(app), ["agent-b", "agent-c", "file", "terminal", "agent-a", "terminal", "file"]);
  assert.equal(app.stored(), before);
  assert.equal(app.model.revision(), revision);
  assert.equal(app.model.preview(), null);
});

test("Ctrl+Shift+Tab은 첫 탭에서 끝으로 가며 정렬과 archived 필터를 따른다", () => {
  const app = harness(); pinned(app);
  app.session.agents.set("agent-b", { archivedAt: "now" });
  const ordered = app.model.entries();
  app.model.reorder([ordered[2].key, ordered[0].key, ordered[1].key]);
  app.render(app.props("a", [row("a"), nativeRow("file", "file")]));
  app.key({ shiftKey: true });
  app.key({ shiftKey: true });
  app.key({ shiftKey: true });
  assert.deepEqual(destinations(app), ["agent-c", "file", "agent-a"]);
  assert.ok(!destinations(app).includes("agent-b"));
});

test("현재 탭이 목록에 없으면 다음은 처음·역방향은 마지막으로 이동한다", () => {
  const app = harness(); pinned(app);
  app.setLayout("a", row("unknown").tab);
  app.render(app.props("a", []));
  app.key();
  app.windowEvent("pointerdown");
  app.key({ shiftKey: true });
  assert.deepEqual(destinations(app), ["agent-a", "agent-c"]);
});

test("단일 현재 탭과 비동기 선택 중인 단일 탭을 중복 이동하지 않는다", () => {
  const app = harness(); pinned(app, ["a"]);
  app.render(app.props("a", [row("a")]));
  assert.equal(app.key().prevented, 1);
  assert.equal(app.key({ shiftKey: true }).prevented, 1);
  assert.deepEqual(destinations(app), []);
  app.setLayout("a", row("unknown").tab);
  app.windowEvent("pointerdown");
  app.key(); app.key(); app.key({ shiftKey: true });
  assert.deepEqual(destinations(app), ["agent-a"]);
});

test("탭이 없으면 Ctrl+Tab을 가로채지 않는다", () => {
  const app = harness();
  app.render(app.props("a", []));
  assert.equal(app.key().prevented, 0);
  assert.deepEqual(destinations(app), []);
});

test("분할 pane의 렌더 순서와 무관하게 집중 pane의 비대화 이동을 원래 source에 위임한다", () => {
  const app = harness(); pinned(app, ["a"]);
  app.setLayoutState({ layoutByWorkspace: { "host:a": { focusedPaneId: "right", root: { kind: "group", group: { children: [
    { kind: "pane", pane: { id: "left", tabs: [nativeRow("left-file", "file").tab], focusedTabId: "left-file" } },
    { kind: "pane", pane: { id: "right", tabs: [row("a").tab, nativeRow("right-terminal", "terminal").tab], focusedTabId: "a" } },
  ] } } } } });
  const right = { ...app.props("a", [row("a"), nativeRow("right-terminal", "terminal")]), paneId: "right",
    onNavigateTab: (id) => app.calls.push(["right", id]) };
  const left = { ...app.props("a", [nativeRow("left-file", "file", true)]), paneId: "left", isFocused: false,
    onNavigateTab: (id) => app.calls.push(["left", id]) };
  app.render(right); app.render(left);
  app.key();
  assert.deepEqual(app.calls.filter(([kind]) => kind === "right" || kind === "left"), [["right", "right-terminal"]]);
  app.unmount(right);
  assert.equal(app.key().prevented, 0);
});

test("focusedPaneId와 맞지 않거나 keyboard 소유권이 없는 행은 처리하지 않는다", () => {
  const app = harness(); pinned(app);
  app.render({ ...app.props("a", [row("a")]), paneId: "another" });
  assert.equal(app.key().prevented, 0);
  app.render({ ...app.props("a", [row("a")]), ownsKeyboardShortcuts: false });
  assert.equal(app.key().prevented, 0);
  assert.deepEqual(destinations(app), []);
});

test("다른 host로 이동하고 늦게 도착한 중간 route에서도 빠른 연속 키를 이어간다", () => {
  const app = harness(); pinned(app, ["a"]);
  app.model.ingest("other-host", "b", [row("b")]); app.model.pin(app.model.preview().key);
  app.model.ingest("host", "c", [row("c")]); app.model.pin(app.model.preview().key);
  app.render(app.props("a", [row("a")]));
  app.key(); app.key();
  assert.equal(app.calls[0][1].serverId, "other-host");
  app.sessionMap["other-host"] = { agents: new Map(), agentDetails: new Map() };
  app.setLayoutState({ layoutByWorkspace: { ...app.getLayoutState().layoutByWorkspace,
    "other-host:b": { focusedPaneId: "main", root: { kind: "pane", pane: { id: "main", tabs: [row("b").tab], focusedTabId: "b" } } } } });
  app.render({ ...app.props("b", [row("b")]), normalizedServerId: "other-host" });
  app.key();
  assert.deepEqual(destinations(app), ["agent-b", "agent-c", "agent-a"]);
});

test("route가 먼저 바뀌어도 아직 보이는 committed 행에서 연속 순환한다", () => {
  const app = harness(); pinned(app);
  app.render(app.props("a", [row("a")]));
  app.key();
  app.context.location.pathname = "/h/host/workspace/b";
  app.key();
  assert.deepEqual(destinations(app), ["agent-b", "agent-c"]);
});

test("pointerdown·다른 키·blur 이후에는 실제 현재 선택에서 다시 순환한다", () => {
  for (const reset of [(app) => app.windowEvent("pointerdown"), (app) => app.key({ key: "ArrowLeft" }), (app) => app.windowEvent("blur")]) {
    const app = harness(); pinned(app);
    app.render(app.props("a", [row("a")]));
    app.key(); reset(app); app.key();
    assert.deepEqual(destinations(app), ["agent-b", "agent-b"]);
  }
});

test("chat textarea와 terminal focus에서도 Ctrl+Tab을 처리하고 기존 preventDefault·IME·다른 modifier는 존중한다", () => {
  const app = harness(); pinned(app);
  app.render(app.props("a", [row("a")]));
  for (const input of [{ ctrlKey: false }, { altKey: true }, { metaKey: true }, { isComposing: true },
    { keyCode: 229 }, { defaultPrevented: true }, { key: "Enter" }]) {
    assert.equal(app.key(input).prevented, 0);
  }
  assert.deepEqual(destinations(app), []);
  app.key({ target: composer() });
  app.key({ target: element({ class: "xterm-helper-textarea" }, null, "TEXTAREA") });
  assert.deepEqual(destinations(app), ["agent-b", "agent-c"]);
});

test("설정·명령창·dialog·menu·popover·숨겨진 문서는 순환하지 않는다", () => {
  const app = harness(); pinned(app);
  app.render(app.props("a", [row("a")]));
  app.context.location.pathname = "/settings/general";
  assert.equal(app.key().prevented, 0);
  app.context.location.pathname = "/h/host/workspace/a";
  for (const attributes of [{ role: "dialog" }, { role: "alertdialog" }, { "aria-modal": "true" },
    { "data-testid": "command-center-panel" }, { "data-menu-surface": "true" }]) {
    app.overlays.push(element(attributes));
    assert.equal(app.key().prevented, 0);
    app.overlays.pop();
  }
  app.popovers.push(element());
  assert.equal(app.key().prevented, 0);
  app.popovers.pop();
  app.context.document.visibilityState = "hidden";
  assert.equal(app.key().prevented, 0);
  assert.deepEqual(destinations(app), []);
});

test("숨겨진 overlay와 미지원 popover selector는 정상 순환을 막지 않는다", () => {
  const app = harness(); pinned(app);
  app.render(app.props("a", [row("a")]));
  app.overlays.push(element({ role: "dialog" }, element({ "aria-hidden": "true" })));
  app.overlays.push(Object.assign(element({ role: "dialog" }), { getClientRects: () => [] }));
  app.overlays.push(Object.assign(element({ role: "dialog" }), { style: { display: "none", visibility: "visible" } }));
  const query = app.context.document.querySelectorAll;
  app.context.document.querySelectorAll = (selector) => {
    if (selector === ":popover-open") throw new Error("unsupported selector");
    return query(selector);
  };
  app.key();
  assert.deepEqual(destinations(app), ["agent-b"]);
});

test("keydown 한 번을 한 번만 처리하며 dispose는 window listener와 cursor를 해제한다", () => {
  const app = harness(); pinned(app);
  app.render(app.props("a", [row("a")]));
  assert.equal(app.windowListeners.get("keydown").size, 1);
  const event = app.key();
  app.windowListeners.get("keydown").forEach((listener) => listener(event));
  assert.deepEqual(destinations(app), ["agent-b"]);
  const plugin = app.context.__PASEO_GLOBAL_TABS__;
  plugin.dispose(); plugin.dispose();
  assert.equal([...app.windowListeners.values()].reduce((total, set) => total + set.size, 0), 0);
  app.key();
  assert.deepEqual(destinations(app), ["agent-b"]);
});

test("키보드 이동은 미리보기를 고정하거나 목록·영구 저장을 수정하지 않는다", () => {
  const app = harness(); pinned(app, ["a", "b"]);
  app.model.ingest("host", "c", [row("c")]);
  app.render(app.props("a", [row("a")]));
  const before = JSON.stringify(app.model.entries());
  const saved = app.stored();
  app.key(); app.key();
  assert.deepEqual(destinations(app), ["agent-b", "agent-c"]);
  assert.equal(app.model.preview().agentId, "agent-c");
  assert.equal(JSON.stringify(app.model.entries()), before);
  assert.equal(app.stored(), saved);
});

test("짧은 연속 입력 시간창이 지나면 미완료 cursor 대신 실제 선택을 사용한다", () => {
  const app = harness(); pinned(app);
  app.render(app.props("a", [row("a")]));
  app.key();
  app.advanceTime(1500);
  app.key();
  assert.deepEqual(destinations(app), ["agent-b", "agent-b"]);
});

test("대기 중인 route와 무관한 workspace에서는 오래된 source를 대신 사용하지 않는다", () => {
  const app = harness(); pinned(app);
  app.render(app.props("a", [row("a")]));
  app.key();
  app.context.location.pathname = "/h/host/workspace/unrelated";
  assert.equal(app.key().prevented, 0);
  assert.deepEqual(destinations(app), ["agent-b"]);
});

const draftIdOf = (id) => "global-new-workspace:" + JSON.stringify(id);
function keepDraft(app, id) {
  const bar = app.renderDraft();
  bar.onKeepTab(bar.tabs.find(row => row.tab.tabId === draftIdOf(id)).tab);
}

test("빈 새 워크스페이스는 다른 빈 작성 탭과 대화 미리보기로 대체된다", () => {
  const app = harness(null, true); pinned(app, ["a"]);
  app.model.ingest("host", "p", [row("p")]);
  const one = app.bridge.open();
  assert.equal(app.model.preview(), null);
  const two = app.bridge.open();
  assert.deepEqual(app.bridgeSnapshot().entries.map(entry => entry.draftId), [two]);
  assert.deepEqual(app.calls.filter(([kind]) => kind === "draft-close"), [["draft-close", one]]);
  app.render(app.props("b", [row("b")]));
  assert.equal(app.bridgeSnapshot().entries.length, 0);
  assert.equal(app.model.preview().agentId, "agent-b");
});

test("새 워크스페이스는 타이핑 전 미리보기이고 실제 입력 뒤에는 유지된다", () => {
  const app = harness(null, true);
  const one = app.bridge.open();
  const preview = () => {
    const tab = app.renderDraft().tabs.find(item => item.tab.tabId === draftIdOf(one)).tab;
    return app.presentation.WorkspaceTabPresentationResolver({ tab, children: value => value }).isPreview;
  };
  assert.equal(preview(), true);
  app.emit("compositionupdate", { target: composer(null), data: "ㅎ", isTrusted: true });
  assert.equal(preview(), false);
  const two = app.bridge.open();
  assert.deepEqual(app.bridgeSnapshot().entries.map(entry => entry.draftId), [one, two]);
});

test("그룹 중간 탭을 닫으면 삭제 전 화면 순서의 바로 오른쪽 탭으로 이동한다", () => {
  const app = harness(null, false, false, true); pinned(app, ["a", "b", "c", "d"]);
  const props = app.props("b", [row("b")]);
  let rendered = app.render(props);
  const byAgent = id => rendered.tabs.find(row => row.tab.target.agentId === "agent-" + id).tab;
  app.setGroups({ order: ["a", "b", "c", "d"].map(id => byAgent(id).key),
    groups: [{ id: "g", tabs: [byAgent("b"), byAgent("d")] }] });
  rendered = app.render(props);
  app.calls.length = 0;
  rendered.onCloseTab(byAgent("b").tabId);
  assert.deepEqual(destinations(app), ["agent-d"]);
});

test("좌우 탭 닫기도 그룹이 투영된 실제 화면 순서를 따른다", () => {
  const app = harness(null, false, false, true); pinned(app, ["a", "b", "c", "d"]);
  let rendered = app.render(app.props("a", [row("a")]));
  const byAgent = id => rendered.tabs.find(row => row.tab.target.agentId === "agent-" + id).tab;
  app.setGroups({ order: ["a", "b", "c", "d"].map(id => byAgent(id).key),
    groups: [{ id: "g", tabs: [byAgent("b"), byAgent("d")] }] });
  rendered = app.render(app.props("a", [row("a")]));
  rendered.onCloseTabsToRight(byAgent("d").tabId);
  assert.deepEqual(app.model.entries().map(entry => entry.agentId), ["agent-a", "agent-b", "agent-d"]);
});

test("native 탭의 실제 닫기 완료 후에는 전역 화면 순서의 이웃으로 이동한다", async () => {
  const app = harness(); pinned(app, ["a", "b"]);
  const file = nativeRow("file", "file");
  const props = app.props("a", [row("a", false), { ...file, isActive: true }]);
  app.setLayout("a", file.tab);
  props.onCloseTab = () => app.setLayout("a", row("a").tab);
  const rendered = app.render(props);
  app.calls.length = 0;
  await rendered.onCloseTab(file.tab.tabId);
  assert.deepEqual(destinations(app), ["agent-b"]);
});

test("접힌 그룹 앞 탭을 닫으면 숨겨진 멤버 대신 다음 보이는 탭으로 이동한다", () => {
  const app = harness(null, false, false, true); pinned(app, ["a", "b", "c", "d"]);
  let rendered = app.render(app.props("a", [row("a")]));
  const byAgent = id => rendered.tabs.find(row => row.tab.target.agentId === "agent-" + id).tab;
  app.setGroups({ order: ["a", "b", "c", "d"].map(id => byAgent(id).key),
    groups: [{ id: "g", collapsed: true, tabs: [byAgent("b"), byAgent("d")] }] });
  rendered = app.render(app.props("a", [row("a")]));
  rendered.onCloseTab(byAgent("a").tabId);
  assert.deepEqual(destinations(app), ["agent-c"]);
});

test("마지막 native 새 탭이 호스트 레이아웃에 남아도 전역 이웃으로 나갈 수 있다", async () => {
  const app = harness(); pinned(app, ["a", "b"]);
  const launcher = nativeRow("launcher", "new_tab");
  app.setLayout("a", launcher.tab);
  const rendered = app.render(app.props("a", [{ ...launcher, isActive: true }]));
  await rendered.onCloseTab(launcher.tab.tabId);
  assert.deepEqual(destinations(app), ["agent-b"]);
});

test("native 작성 handoff의 닫기 취소는 가상 탭을 유지하고 닫기 완료 때만 제거한다", async () => {
  const app = harness(null, true); pinned(app, ["a"]);
  const id = app.bridge.open(); app.renderDraft();
  completeDraft(app, id, { kind: "draft", draftId: "native" }, "native-tab");
  const native = { tab: { tabId: "native-tab", target: { kind: "draft", draftId: "native" } }, isActive: true };
  app.setLayout("created", native.tab);
  const props = app.props("created", [native]);
  let rendered = app.render(props);
  await rendered.onCloseTab(draftIdOf(id));
  assert.ok(app.render(props).tabs.some(row => row.tab.tabId === draftIdOf(id)));
  props.onCloseTab = () => app.setLayout("created", row("a").tab);
  rendered = app.render(props);
  await rendered.onCloseTab(draftIdOf(id));
  assert.ok(app.render(props).tabs.every(row => row.tab.tabId !== draftIdOf(id)));
  assert.deepEqual(destinations(app), ["agent-a"]);
});
function completeDraft(app, draftId, target, tabId, workspaceId = "created", sequence) {
  const snapshot = app.bridgeSnapshot();
  app.setBridgeSnapshot({ ...snapshot, entries: snapshot.entries.filter((entry) => entry.draftId !== draftId), activeDraftId: null,
    completions: [...snapshot.completions, { sequence: sequence ?? snapshot.completions.length + 1, draftId,
      serverId: "host", workspaceId, target, tabId }] });
}

test("retainAt은 기존 미리보기와 호스트 구분을 보존하며 실제 생성 대화를 한 번 고정한다", () => {
  const model = createModel(storage());
  model.ingest("host", "preview", [row("preview")]);
  const tab = { tabId: "agent_created", target: { kind: "agent", agentId: "created" } };
  model.retainAt("host", "workspace", tab, 0);
  assert.equal(model.preview().agentId, "agent-preview");
  assert.deepEqual(model.entries().map((entry) => [entry.agentId, entry.pinned]), [["created", true], ["agent-preview", false]]);
  const revision = model.revision();
  model.retainAt("host", "workspace", tab, 0);
  assert.equal(model.revision(), revision);
  model.retainAt("another-host", "workspace", tab, 1);
  assert.equal(model.entries().length, 3);
  assert.equal(model.retainAt("host", "workspace", { tabId: "invalid", target: { kind: "terminal" } }, 0), null);
});

test("bridge가 없으면 작성 탭 등록 없이 기존 기능만 유지한다", () => {
  const app = harness();
  assert.equal(app.registeredBar(), null);
  assert.equal(app.bridgeListeners.size, 0);
  app.render(app.props("a", [row("a")]));
  assert.equal(app.model.entries().length, 1);
});

test("여러 작성 탭은 고유 ID로 같은 행에 표시되고 생성 전 기본 제목이 즉시 준비된다", () => {
  const app = harness(null, true); pinned(app, ["a"]);
  const one = app.bridge.open(); keepDraft(app, one); const two = app.bridge.open({ serverId: "other-host" });
  const rendered = app.renderDraft();
  assert.equal(rendered.globalDraftContext, true);
  assert.equal(rendered.normalizedWorkspaceId, "");
  assert.equal(rendered.paneId, "new-workspace");
  assert.equal(rendered.tabs.length, 3);
  const virtual = rendered.tabs.filter((item) => item.tab.target.kind === "new_tab");
  assert.deepEqual(Array.from(virtual, (item) => item.tab.tabId), [draftIdOf(one), draftIdOf(two)]);
  assert.equal(virtual[1].isActive, true);
  const output = app.presentation.WorkspaceTabPresentationResolver({ tab: virtual[1].tab,
    serverId: "wrong", workspaceId: "wrong", children: (value) => value });
  assert.equal(output.label, "새 워크스페이스");
  assert.equal(output.titleState, "ready");
  assert.equal(output.isPreview, true);
  assert.equal(app.presentation.WorkspaceTabPresentationResolver({ tab: virtual[1].tab, children: (value) => value }), output);
  assert.equal(app.model.entries().length, 1);
  assert.ok(!app.stored().includes(one));
  for (const name of ["onCopyTerminalId", "onCopyFilePath", "onRenameTab", "onCreateNewTab", "onExitFocusMode"]) {
    assert.equal(typeof rendered[name], "function");
  }
});

test("작성 화면은 이전 미리보기를 대체하고 고정 대화와 왕복해도 작성 identity를 보존한다", () => {
  const app = harness(null, true); pinned(app, ["a"]);
  app.model.ingest("host", "p", [row("p")]);
  const id = app.bridge.open();
  const snapshot = app.bridgeSnapshot().entries[0];
  const rendered = app.renderDraft();
  const conversation = rendered.tabs.find((item) => item.tab.target.agentId === "agent-a");
  rendered.onNavigateTab(conversation.tab.tabId);
  assert.deepEqual(destinations(app), ["agent-a"]);
  const workspace = app.render(app.props("a", [row("a")]));
  workspace.onNavigateTab(draftIdOf(id));
  assert.deepEqual(app.calls.filter(([kind]) => kind === "draft-navigate"), [["draft-navigate", id]]);
  assert.equal(app.bridgeSnapshot().entries[0], snapshot);
  assert.equal(app.model.preview(), null);
});

test("작성 탭 재정렬은 가상 target을 native 레이아웃에 쓰지 않는다", () => {
  const app = harness(null, true); pinned(app, ["a", "b"]);
  const one = app.bridge.open(); keepDraft(app, one); const two = app.bridge.open(); keepDraft(app, two);
  const workspace = app.render(app.props("a", [row("a"), nativeRow("file", "file")]));
  const next = [workspace.tabs[2].tab, workspace.tabs[0].tab, workspace.tabs[3].tab, workspace.tabs[1].tab, workspace.tabs[4].tab];
  workspace.onReorderTabs(next);
  assert.deepEqual(app.calls.filter(([kind]) => kind === "reorder"), []);
  const after = app.render(app.props("a", [row("a"), nativeRow("file", "file")]));
  assert.deepEqual(Array.from(after.tabs.slice(0, 4), (item) => item.tab.tabId), [draftIdOf(one), workspace.tabs[0].tab.tabId, draftIdOf(two), workspace.tabs[1].tab.tabId]);
  app.bridge.activate(one);
  const bar = app.renderDraft();
  const before = app.calls.filter(([kind]) => kind === "reorder").length;
  bar.onReorderTabs(bar.tabs.map((item) => item.tab).reverse());
  assert.equal(app.calls.filter(([kind]) => kind === "reorder").length, before);
});

test("작성 탭을 닫으면 이웃으로 이동하고 기존 대화·원본 draft 데이터는 지우지 않는다", () => {
  const app = harness(null, true); pinned(app, ["a"]);
  const id = app.bridge.open();
  const rendered = app.renderDraft();
  const saved = app.stored();
  rendered.onCloseTab(draftIdOf(id));
  assert.deepEqual(app.calls.filter(([kind]) => kind === "draft-close"), [["draft-close", id]]);
  assert.deepEqual(destinations(app), ["agent-a"]);
  assert.equal(app.stored(), saved);
  assert.equal(app.model.entries().length, 1);
  assert.equal(app.calls.filter(([kind]) => kind === "close-native").length, 0);
});

test("작성 화면 Ctrl+Tab·역방향은 대화와 여러 작성 탭 사이를 순환한다", () => {
  const app = harness(null, true); pinned(app, ["a"]);
  const one = app.bridge.open(); keepDraft(app, one); const two = app.bridge.open(); keepDraft(app, two);
  app.bridge.activate(one); app.renderDraft();
  app.calls.length = 0;
  app.key(); app.renderDraft();
  assert.equal(app.bridgeSnapshot().activeDraftId, two);
  app.key();
  assert.deepEqual(destinations(app), ["agent-a"]);
  app.key({ shiftKey: true });
  assert.equal(app.bridgeSnapshot().activeDraftId, two);
  app.key({ shiftKey: true }); app.renderDraft();
  assert.equal(app.bridgeSnapshot().activeDraftId, one);
  assert.equal(app.model.entries()[0].pinned, true);
});

test("정확한 생성 완료는 작성 위치를 실제 고정 대화로 바꾸며 다른 미리보기를 보존한다", () => {
  const app = harness(null, true); pinned(app, ["a"]);
  app.model.ingest("host", "p", [row("p")]);
  const id = app.bridge.open();
  keepDraft(app, id);
  app.model.ingest("host", "a", [row("a")]);
  app.model.ingest("host", "p", [row("p")]);
  const bar = app.renderDraft();
  bar.onReorderTabs([bar.tabs[0].tab, bar.tabs[1].tab, bar.tabs[2].tab]);
  completeDraft(app, id, { kind: "agent", agentId: "created-agent" }, "official-agent-tab");
  assert.deepEqual(app.model.entries().map((entry) => [entry.agentId, entry.pinned]),
    [["agent-a", true], ["created-agent", true], ["agent-p", false]]);
  assert.equal(app.model.entries()[1].tabId, "official-agent-tab");
  const before = app.model.revision();
  app.setBridgeSnapshot({ ...app.bridgeSnapshot() });
  assert.equal(app.model.revision(), before);
  const workspace = app.render(app.props("created", [{ tab: { tabId: "official-agent-tab", target: { kind: "agent", agentId: "created-agent" } }, isActive: true }]));
  assert.equal(app.model.preview().agentId, "agent-p");
  assert.ok(workspace.tabs.every((item) => item.tab.tabId !== draftIdOf(id)));
});

test("중간 native draft와 terminal 전환은 작성 슬롯과 기존 대화를 유지하고 native 중복을 숨긴다", () => {
  const app = harness(null, true); pinned(app, ["a"]);
  const id = app.bridge.open(); app.renderDraft();
  completeDraft(app, id, { kind: "draft", draftId: "native-draft" }, "official-draft-tab");
  const native = { tab: { tabId: "official-draft-tab", kind: "draft", target: { kind: "draft", draftId: "native-draft" } }, isActive: true };
  const workspace = app.render(app.props("created", [native]));
  assert.equal(workspace.tabs.length, 2);
  assert.equal(workspace.tabs[1].tab.tabId, draftIdOf(id));
  const presentation = app.presentation.WorkspaceTabPresentationResolver({ tab: workspace.tabs[1].tab, children: (value) => value });
  assert.equal(presentation.props.serverId, "host");
  assert.equal(presentation.props.workspaceId, "created");
  assert.equal(presentation.props.tab.tabId, "official-draft-tab");
  completeDraft(app, id, { kind: "agent", agentId: "finished" }, "official-agent");
  assert.deepEqual(app.model.entries().map((entry) => entry.agentId), ["agent-a", "finished"]);
  const terminalDraft = app.bridge.open(); app.renderDraft();
  completeDraft(app, terminalDraft, { kind: "terminal", terminalId: "terminal-id" }, "official-terminal");
  const terminal = { tab: { tabId: "official-terminal", kind: "terminal", target: { kind: "terminal", terminalId: "terminal-id" } }, isActive: true };
  const terminalWorkspace = app.render(app.props("created", [terminal]));
  assert.equal(terminalWorkspace.tabs.filter((item) => item.tab.target.kind === "terminal").length, 1);
  assert.equal(app.model.entries().length, 2);
});

test("빈 생성 완료와 닫은 draft의 늦은 완료는 기존 대화 목록을 변경하지 않는다", () => {
  const app = harness(null, true); pinned(app, ["a"]);
  const empty = app.bridge.open(); app.renderDraft();
  completeDraft(app, empty, null, null);
  assert.equal(app.model.entries().length, 1);
  const closed = app.bridge.open();
  app.renderDraft().onCloseTab(draftIdOf(closed));
  completeDraft(app, closed, { kind: "agent", agentId: "late" }, "late-tab");
  assert.deepEqual(app.model.entries().map((entry) => entry.agentId), ["agent-a"]);
});

test("완료된 native terminal 탭 닫기는 실제 source에 원래 tabId로 위임한다", () => {
  const app = harness(null, true); pinned(app, ["a"]);
  const id = app.bridge.open(); app.renderDraft();
  completeDraft(app, id, { kind: "terminal", terminalId: "terminal-id" }, "native-terminal");
  const native = { tab: { tabId: "native-terminal", kind: "terminal", target: { kind: "terminal", terminalId: "terminal-id" } }, isActive: true };
  const workspace = app.render(app.props("created", [native]));
  workspace.onCloseTab(draftIdOf(id));
  assert.deepEqual(app.calls.filter(([kind]) => kind === "close-native"), [["close-native", "native-terminal"]]);
  assert.equal(app.model.entries().length, 1);
});

test("한 snapshot의 여러 완료는 작성 슬롯 순서를 보존하고 다른 draft를 밀어내지 않는다", () => {
  const app = harness(null, true); pinned(app, ["a", "b"]);
  const one = app.bridge.open(); keepDraft(app, one); const two = app.bridge.open(); keepDraft(app, two); const three = app.bridge.open();
  const bar = app.renderDraft();
  bar.onReorderTabs([bar.tabs[0].tab, bar.tabs[2].tab, bar.tabs[3].tab, bar.tabs[4].tab, bar.tabs[1].tab]);
  app.setBridgeSnapshot({ entries: [app.bridgeSnapshot().entries[2]], activeDraftId: three,
    completions: [{ sequence: 1, draftId: one, serverId: "host", workspaceId: "one", target: { kind: "agent", agentId: "one" }, tabId: "one-tab" },
      { sequence: 2, draftId: two, serverId: "host", workspaceId: "two", target: { kind: "agent", agentId: "two" }, tabId: "two-tab" }] });
  const after = app.renderDraft();
  assert.deepEqual(Array.from(after.tabs, (item) => item.tab.target.agentId || item.tab.tabId), ["agent-a", "one", "two", draftIdOf(three), "agent-b"]);
});

test("생성 완료 위치는 숨겨진 archived 탭이 앞에 있어도 보이는 순서를 보존한다", () => {
  const app = harness(null, true); pinned(app, ["archived", "a", "b"]);
  app.session.agents.set("agent-archived", { archivedAt: "now" });
  const id = app.bridge.open();
  const bar = app.renderDraft();
  bar.onReorderTabs([bar.tabs[0].tab, bar.tabs[2].tab, bar.tabs[1].tab]);
  const archived = app.model.entries().find((entry) => entry.agentId === "agent-archived");
  app.model.reorder([archived.key, ...app.model.entries().filter((entry) => entry !== archived).map((entry) => entry.key)]);
  completeDraft(app, id, { kind: "agent", agentId: "created" }, "created-tab");
  const visible = app.render(app.props("a", [row("a")]));
  assert.deepEqual(Array.from(visible.tabs, (item) => item.tab.target.agentId), ["agent-a", "created", "agent-b"]);
});

test("작성 bridge 구독과 Bar 등록은 dispose 때 해제되고 재등록 전 기능에 영향 주지 않는다", () => {
  const app = harness(null, true); pinned(app, ["a"]);
  assert.equal(app.bridgeListeners.size, 1);
  assert.equal(typeof app.registeredBar(), "function");
  const plugin = app.context.__PASEO_GLOBAL_TABS__;
  plugin.dispose(); plugin.dispose();
  assert.equal(app.bridgeListeners.size, 0);
  assert.equal(app.registeredBar(), null);
  const before = app.model.revision();
  const id = app.bridge.open(); completeDraft(app, id, { kind: "agent", agentId: "after-dispose" }, "unused");
  assert.equal(app.model.revision(), before);
});

test("워크스페이스를 쓸 수 없어 패널이 뜨지 않는 작성 탭도 닫을 수 있다", () => {
  const app = harness(null, true); pinned(app, ["a"]);
  const id = app.bridge.open(); app.renderDraft();
  completeDraft(app, id, { kind: "draft", draftId: "native" }, "native-tab", "gone");
  const props = app.props("a", [row("a")]);
  const rendered = app.render(props);
  assert.ok(rendered.tabs.some(item => item.tab.tabId === draftIdOf(id)));
  rendered.onCloseTab(draftIdOf(id));
  for (let tick = 0; tick < 30; tick++) app.tickTimers();
  assert.ok(app.render(props).tabs.every(item => item.tab.tabId !== draftIdOf(id)));
});
