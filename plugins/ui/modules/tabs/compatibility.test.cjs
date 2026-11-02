const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function executableContribution(plugin) {
  return plugin.replace(/^import .*;\r?\n/, "")
    .replace("export default function contribute", "function contribute")
    + "\nglobalThis.contribute = contribute;";
}
const source = executableContribution(fs.readFileSync(path.join(__dirname, "index.client.js"), "utf8"));
const moduleMaps = require("./module-maps.json");
const { original: originalIds, titleSync: titleSyncIds, titleSyncTwoLine: twoLineIds,
  workspaceCreateTabs: createTabsIds, hostProjectGroups: hostGroupsIds,
  sidebarBulkCollapse: bulkCollapseIds, sidebarReveal: revealIds, sidebarScroll: scrollIds, completionAge: completionIds, hostSortable: sortableIds, sessionHistory: historyIds } = moduleMaps;

function harness(ids, invalidPath, missingModule = false, contribution = source, storageDenied = false) {
  const originalRow = () => {};
  const originalPresentation = () => {};
  const createSnapshot = { entries: [], activeDraftId: null, completions: [] };
  const exports = {
    react: { createElement() {}, useState() {}, useEffect() {}, useSyncExternalStore() {} },
    rows: { WorkspaceDesktopTabsRow: originalRow },
    presentation: { WorkspaceTabPresentationResolver: originalPresentation },
    navigation: { navigateToWorkspace() {}, useLastWorkspaceSelection() {}, getLastWorkspaceSelection() {} },
    sessions: { useSessionStore: Object.assign(() => {}, {
      getState: () => ({ sessions: {}, setAgentDetails() {} }), subscribe: () => () => {},
    }) },
    snapshots: { normalizeAgentSnapshot: (agent) => agent },
    hostRoutes: { parseHostWorkspaceRouteFromPathname: () => null },
    keyboardActions: { useKeyboardActionHandler() {} },
    settings: { useSettings() {} },
    titles: { selectAgentTabSidebarLabel: () => null, selectAgentTabProjectLabel: () => null },
    layouts: { useWorkspaceLayoutStore: Object.assign(() => {}, { getState() {}, setState() {} }) },
    newWorkspaceTabs: { newWorkspaceTabsBridge: {
      getSnapshot: () => createSnapshot, subscribe: () => () => {},
      registerTabBar: () => () => {}, open() {}, activate() {}, close() {},
    } },
    tabGroups: {forgetTabGroupKey(){},isTabGroupKeyVisible:()=>true,
      useTabGroups:Object.assign(()=>({groups:[]}), { getState:()=>({state:{groups:[],order:[]},update(){}}),subscribe:()=>()=>{} })},
    tabPresence: { agentTabPresenceBridge: { read() {}, getSnapshot() {}, subscribe: () => () => {}, register: () => () => {} } },
  };
  if (invalidPath) {
    const segments = invalidPath.split(".");
    const property = segments.pop();
    const owner = segments.reduce((value, name) => value[name], exports);
    owner[property] = undefined;
  }
  const modules = Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, exports[name]]));
  const calls = { disposed: 0, storage: 0, intervals: 0, requiredModules: [] };
  const previous = { dispose() { calls.disposed++; } };
  const previousIds = { existing: true };
  const previousModel = { existing: true };
  const storage = new Map();
  const context = {
    document: {}, console: { info() {}, warn() {} },
    localStorage: { getItem(key) { calls.storage++; return storage.get(key) ?? null; },
      setItem(key, value) { calls.storage++; storage.set(key, value); },
      get length() { return storage.size; }, key: index => [...storage.keys()][index] ?? null },
    setInterval() { calls.intervals++; return calls.intervals; }, clearInterval() {},
    __PASEO_GLOBAL_TABS__: previous,
    __PASEO_GLOBAL_TABS_MODULES__: previousIds,
    PaseoGlobalTabsModel: previousModel,
    __r(id) {
      calls.requiredModules.push(id);
      if (missingModule) throw new Error("Unknown module " + id);
      return modules[id];
    },
  };
  if (storageDenied) Object.defineProperty(context, "localStorage", {get() {throw new Error("denied");}});
  vm.runInNewContext(contribution, context);
  return { context, calls, exports, previous, previousIds, previousModel, originalRow, originalPresentation };
}

test("localStorage getter denial keeps a usable in-memory controller with a storage diagnostic", () => {
  const app = harness(originalIds, undefined, false, source, true);
  const cleanup = app.context.contribute({});
  const model = app.context.__PASEO_GLOBAL_TABS__.model;
  model.retainAt("host", "workspace", {tabId: "tab", target: {kind: "agent", agentId: "agent"}});
  assert.equal(model.entries().length, 1);
  assert.equal(model.storageStatus().state, "memory-only");
  cleanup();
  assert.equal(app.exports.rows.WorkspaceDesktopTabsRow, app.originalRow);
});

test("a known renderer bundle selects its module map before evaluating unrelated modules", () => {
  const key = Object.keys(moduleMaps).find(key => key.includes("@"));
  const ids = moduleMaps[key];
  const hash = key.split("@")[1].padEnd(32, "0");
  const app = harness(ids);
  app.context.document.scripts = [{ src: "paseo://app/_expo/static/js/web/index-" + hash + ".js" }];
  const cleanup = app.context.contribute({ addAgentTabTitleResolver() {} });
  const supported = new Set(Object.values(ids));
  assert.equal(app.calls.requiredModules.every(id => supported.has(id)), true);
  assert.deepEqual(JSON.parse(JSON.stringify(app.context.__PASEO_GLOBAL_TABS_MODULES__)), ids);
  cleanup();
});

for (const [name, ids, client] of [
  ["original Paseo 0.12.0", originalIds, {}],
  ["Sidebar Title Sync source client", titleSyncIds, { addAgentTabTitleResolver() {} }],
  ...(twoLineIds ? [["two-line Sidebar Title Sync source client", twoLineIds, { addAgentTabTitleResolver() {} }]] : []),
  ...(createTabsIds ? [["new-workspace tabs source client", createTabsIds, { addAgentTabTitleResolver() {} }]] : []),
  ...(hostGroupsIds ? [["host-project groups source client", hostGroupsIds, { addAgentTabTitleResolver() {} }]] : []),
  ...(bulkCollapseIds ? [["sidebar bulk collapse source client", bulkCollapseIds, { addAgentTabTitleResolver() {} }]] : []),
  ...(revealIds ? [["sidebar reveal source client", revealIds, { addAgentTabTitleResolver() {} }]] : []),
  ...(scrollIds ? [["sidebar viewport scroll source client", scrollIds, { addAgentTabTitleResolver() {} }]] : []),
  ...(completionIds ? [["tab completion age source client", completionIds, { addAgentTabTitleResolver() {} }]] : []),
  ...(sortableIds ? [["host sortable source client", sortableIds, { addAgentTabTitleResolver() {} }]] : []),
  ...(historyIds ? [["session history source client", historyIds, { addAgentTabTitleResolver() {} }]] : []),
  ...(moduleMaps.sidebarActivity ? [["sidebar activity source client", moduleMaps.sidebarActivity, { addAgentTabTitleResolver() {} }]] : []),
]) {
  test(name + " selects its map and restores wrappers on cleanup", () => {
    const app = harness(ids);
    const cleanup = app.context.contribute(client);
    assert.deepEqual(JSON.parse(JSON.stringify(app.context.__PASEO_GLOBAL_TABS_MODULES__)), ids);
    assert.equal(app.calls.disposed, 1);
    assert.notEqual(app.exports.rows.WorkspaceDesktopTabsRow, app.originalRow);
    assert.notEqual(app.exports.presentation.WorkspaceTabPresentationResolver, app.originalPresentation);
    assert.equal(app.calls.intervals, 1);
    cleanup();
    assert.equal(app.exports.rows.WorkspaceDesktopTabsRow, app.originalRow);
    assert.equal(app.exports.presentation.WorkspaceTabPresentationResolver, app.originalPresentation);
  });
}

for (const [variant, ids] of [["new-workspace tabs", createTabsIds], ["host-project groups", hostGroupsIds],
  ["sidebar bulk collapse", bulkCollapseIds], ["sidebar reveal", revealIds], ["sidebar viewport scroll", scrollIds], ["tab completion age", completionIds], ["host sortable", sortableIds]]) {
  if (!ids) continue;
  for (const name of ["getSnapshot", "subscribe", "registerTabBar", "open", "activate", "close"]) {
    test("rejects incompatible " + variant + " bridge " + name + " before changing active UI", () => {
      const app = harness(ids, "newWorkspaceTabs.newWorkspaceTabsBridge." + name);
      assert.throws(() => app.context.contribute({ addAgentTabTitleResolver() {} }), /unsupported Paseo module exports/);
      assertUnchanged(app);
    });
  }
}

for (const name of ["selectAgentTabSidebarLabel", "selectAgentTabProjectLabel"]) {
  test("rejects missing title selector " + name + " before replacing the active UI", () => {
    const app = harness(titleSyncIds, "titles." + name);
    assert.throws(() => app.context.contribute({addAgentTabTitleResolver(){}}), /unsupported Paseo module exports/);
    assertUnchanged(app);
  });
}
for (const name of ["isTabGroupKeyVisible", "forgetTabGroupKey", "useTabGroups", "useTabGroups.getState", "useTabGroups.subscribe"]) {
  test("rejects missing tab group contract " + name + " before replacing the active UI", () => {
    const app = harness(moduleMaps.sidebarActivity, "tabGroups." + name);
    assert.throws(() => app.context.contribute({addAgentTabTitleResolver(){}}), /unsupported Paseo module exports/);
    assertUnchanged(app);
  });
}

const buildVariants = [
  ["hostProjectGroups", "host-project groups", "sidebar-host-project-list", 10000],
  ["sidebarBulkCollapse", "sidebar bulk collapse", "sidebar-collapse-all-hosts sidebar-host-project-list", 11000],
  ["sidebarReveal", "sidebar reveal", "sidebar-collapse-all-hosts sidebar-host-project-list", 12000],
  ["sidebarScroll", "sidebar viewport scroll", "sidebar-collapse-all-hosts sidebar-host-project-list", 14000],
  ["completionAge", "tab completion age", "sidebar-collapse-all-hosts sidebar-host-project-list", 16000],
  ["hostSortable", "host sortable", "sidebar-collapse-all-hosts sidebar-host-project-list", 18000],
  ["sessionHistory", "session history", "sidebar-collapse-all-hosts sidebar-host-project-list", 20000],
  ["historyTab", "history tab", "sidebar-collapse-all-hosts sidebar-host-project-list", 22000],
  ["historyInteractions", "history row interactions", "sidebar-collapse-all-hosts sidebar-host-project-list", 24000],
  ["tabTrailingMenu", "tab trailing menu", "sidebar-collapse-all-hosts sidebar-host-project-list", 26000],
  ["tabGroups", "tab groups", "sidebar-collapse-all-hosts sidebar-host-project-list", 28000],
  ["trailingOverflow", "trailing overflow menu", "sidebar-collapse-all-hosts sidebar-host-project-list workspace-header-toggle-sidebar", 30000],
  ["noDesktopHeader", "no desktop header", "sidebar-collapse-all-hosts sidebar-host-project-list workspace-header-toggle-sidebar desktopTabsDragSpace", 32000],
  ["terminalDirectoryMenu", "terminal directory menu", "sidebar-host-menu-terminal-directory- desktopTabsDragSpace", 34000],
  ["sidebarActivity", "sidebar activity tabs", "sidebar-activity-tabs sidebar-host-menu-terminal-directory- desktopTabsDragSpace", 36000],
];
for (const [variantIndex, [variant, label, marker, firstModuleId]] of buildVariants.entries()) {
test("build adds " + label + " without replacing earlier app maps", () => {
  const appRoot = path.join(__dirname, "fixture-" + variant + "-app");
  const bundleRef = "_expo/static/js/web/index-a1b2c3d4.js";
  const exports = {
    rows: "WorkspaceDesktopTabsRow", presentation: "WorkspaceTabPresentationResolver",
    navigation: "useLastWorkspaceSelection", sessions: "normalizeWorkspaceDescriptor",
    layouts: "createWorkspaceLayoutStore", snapshots: "normalizeAgentSnapshot",
    hostRoutes: "parseHostWorkspaceRouteFromPathname", titles: "resolveAgentTabTitle",
    registry: "useInstalledPlugins", newWorkspaceTabs: "newWorkspaceTabsBridge", keyboardActions: "useKeyboardActionHandler", settings: "useAppSettings",
  };
  const ids = { react: 37 };
  const lines = ['// },37,[38] name:"workspace-layout-state" ' + marker + ' agent-tab-title-line-primary'];
  Object.entries(exports).forEach(([name, symbol], index) => {
    ids[name] = firstModuleId + index;
    lines.push(`__d(function(g,r,i,a,m,e,d){e.${symbol}=function(){}},${ids[name]},[]);`);
  });
  if (variant === "sidebarReveal") lines.push('__d(function(g,r,i,a,m,e,d){e.useSidebarRevealStore=function(){}},13000,[]);');
  if (variant === "sidebarScroll") lines.push('__d(function(g,r,i,a,m,e,d){e.followSidebarWorkspace=function(){}},15000,[]);');
  if (variant === "completionAge") lines.push('__d(function(g,r,i,a,m,e,d){e.selectAgentTabCompletedAt=function(){}},17000,[]);');
  if (variant === "hostSortable") lines.push('__d(function(g,r,i,a,m,e,d){e.reorderHostProfiles=function(){}},19000,[]);');
  if (variant === "sessionHistory") { ids.tabPresence = 21000; lines.push('__d(function(g,r,i,a,m,e,d){e.agentTabPresenceBridge={}},21000,[]);'); }
  if (["historyTab", "historyInteractions", "tabTrailingMenu"].includes(variant)) {
    ids.tabPresence = 23000;
    lines.push('__d(function(g,r,i,a,m,e,d){e.agentTabPresenceBridge={}},23000,[]);');
    lines.push('__d(function(g,r,i,a,m,e,d){e.useHistoryTabPresence=function(){}},23001,[]);');
  }
  if (variant === "historyInteractions" || variant === "tabTrailingMenu") lines.push('__d(function(g,r,i,a,m,e,d){e.attachHistoryRowInteractions=function(){}},25001,[]);');
  if (["tabGroups", "trailingOverflow", "noDesktopHeader", "terminalDirectoryMenu", "sidebarActivity"].includes(variant)) {ids.tabPresence=29000;ids.tabGroups=29001;lines.push('__d(function(g,r,i,a,m,e,d){e.agentTabPresenceBridge={}},29000,[]);');lines.push('__d(function(g,r,i,a,m,e,d){e.isTabGroupKeyVisible=function(){}},29001,[]);');}
  if (variant === "tabTrailingMenu") lines.push('__d(function(g,r,i,a,m,e,d){e.WorkspaceHeaderMenuOverflow=function(){}},27001,[]);');
  const mapsPath = path.join(__dirname, "module-maps.json");
  const previousMaps = { ...moduleMaps };
  // A build only knows the app maps that existed before it, so later variants are left out.
  for (const [later] of buildVariants.slice(variantIndex)) delete previousMaps[later];
  const files = new Map([
    [mapsPath, JSON.stringify(previousMaps)],
    [path.join(appRoot, "index.html"), `<script src="/${bundleRef}"></script>`],
    [path.join(appRoot, bundleRef), lines.join("\n")],
  ]);
  const writes = new Map();
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "build-plugin.cjs"), "utf8"), {
    __dirname,
    process: { env: { PASEO_APP_DIST: appRoot } },
    console: { log() {} },
    require(name) {
      if (name === "node:crypto") return require(name);
      if (name === "node:path") return path;
      assert.equal(name, "node:fs");
      return {
        readFileSync(file, encoding) { return files.has(file) ? files.get(file) : fs.readFileSync(file, encoding); },
        writeFileSync(file, value) { writes.set(file, value); },
      };
    },
  });
  const builtMaps = JSON.parse(writes.get(mapsPath));
  assert.deepEqual(builtMaps[variant], ids);
  for (const [name, previous] of Object.entries(previousMaps)) assert.deepEqual(builtMaps[name], previous);

  const contribution = executableContribution(writes.get(path.join(__dirname, "index.client.js")));
  const app = harness(ids, undefined, false, contribution);
  const cleanup = app.context.contribute({ addAgentTabTitleResolver() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(app.context.__PASEO_GLOBAL_TABS_MODULES__)), ids);
  const expectedModules = Object.values(builtMaps[variant]);
  assert.ok(app.calls.requiredModules.some((_, index) => expectedModules.every((id, offset) => app.calls.requiredModules[index + offset] === id)));
  if (!Object.keys(previousMaps).some((key) => key.includes("@")) && (variant === "historyInteractions" || (variant === "historyTab" && !previousMaps.historyInteractions) || (variant === "sessionHistory" && !previousMaps.historyTab && !previousMaps.historyInteractions) || (variant === "hostSortable" && !previousMaps.sessionHistory && !previousMaps.historyTab && !previousMaps.historyInteractions))) assert.deepEqual(app.calls.requiredModules.slice(0, expectedModules.length), expectedModules);
  cleanup();
  if (variant === "sessionHistory") for (const method of ["read", "getSnapshot", "subscribe", "register"]) {
    const incompatible = harness(ids, "tabPresence.agentTabPresenceBridge." + method, false, contribution);
    assert.throws(() => incompatible.context.contribute({ addAgentTabTitleResolver() {} }), /unsupported Paseo module exports/);
    assertUnchanged(incompatible);
  }
  for (const method of ["getSnapshot", "subscribe", "registerTabBar", "open", "activate", "close"]) {
    const incompatible = harness(ids, "newWorkspaceTabs.newWorkspaceTabsBridge." + method, false, contribution);
    assert.throws(() => incompatible.context.contribute({ addAgentTabTitleResolver() {} }), /unsupported Paseo module exports/);
    assertUnchanged(incompatible);
  }
});
}

const required = [
  "react.createElement", "react.useState", "react.useEffect", "react.useSyncExternalStore",
  "rows.WorkspaceDesktopTabsRow", "presentation.WorkspaceTabPresentationResolver",
  "navigation.navigateToWorkspace", "navigation.useLastWorkspaceSelection", "navigation.getLastWorkspaceSelection",
  "sessions.useSessionStore", "sessions.useSessionStore.getState", "sessions.useSessionStore.subscribe",
  "snapshots.normalizeAgentSnapshot", "layouts.useWorkspaceLayoutStore.getState", "layouts.useWorkspaceLayoutStore.setState",
  "hostRoutes.parseHostWorkspaceRouteFromPathname",
  "keyboardActions.useKeyboardActionHandler",
  "settings.useSettings",
];

function assertUnchanged(app) {
  assert.equal(app.calls.disposed, 0);
  assert.equal(app.calls.storage, 0);
  assert.equal(app.calls.intervals, 0);
  assert.equal(app.context.__PASEO_GLOBAL_TABS__, app.previous);
  assert.equal(app.context.__PASEO_GLOBAL_TABS_MODULES__, app.previousIds);
  assert.equal(app.context.PaseoGlobalTabsModel, app.previousModel);
}

for (const field of required) {
  test("rejects incompatible " + field + " before changing active UI", () => {
    const app = harness(titleSyncIds, field);
    assert.throws(() => app.context.contribute({ addAgentTabTitleResolver() {} }), /unsupported Paseo module exports/);
    assertUnchanged(app);
  });
}

test("rejects unknown module graph before changing active UI", () => {
  const app = harness(titleSyncIds, undefined, true);
  assert.throws(() => app.context.contribute({ addAgentTabTitleResolver() {} }), /unsupported Paseo module (graph|exports)/);
  assertUnchanged(app);
});

test("uses original map when title resolver field is not callable", () => {
  const app = harness(originalIds);
  app.context.contribute({ addAgentTabTitleResolver: true });
  assert.deepEqual(JSON.parse(JSON.stringify(app.context.__PASEO_GLOBAL_TABS_MODULES__)), originalIds);
});

test("host contributions share one controller until the final host leaves", () => {
  const app = harness(titleSyncIds);
  const firstCleanup = app.context.contribute({ addAgentTabTitleResolver() {} });
  const first = app.context.__PASEO_GLOBAL_TABS__;
  const secondCleanup = app.context.contribute({ addAgentTabTitleResolver() {} });
  const second = app.context.__PASEO_GLOBAL_TABS__;
  const wrappedRow = app.exports.rows.WorkspaceDesktopTabsRow;
  assert.equal(first, second);
  assert.equal(app.context.__PASEO_GLOBAL_TABS_LEASE__.owners.size, 2);
  firstCleanup();
  assert.equal(app.context.__PASEO_GLOBAL_TABS__, second);
  assert.equal(app.exports.rows.WorkspaceDesktopTabsRow, wrappedRow);
  secondCleanup();
  assert.equal(app.context.__PASEO_GLOBAL_TABS__, undefined);
  assert.equal(app.exports.rows.WorkspaceDesktopTabsRow, app.originalRow);
  assert.equal(app.context.__PASEO_GLOBAL_TABS_LEASE__, undefined);
});

test("disconnecting the later host keeps the first host active", () => {
  const app = harness(titleSyncIds);
  const firstCleanup = app.context.contribute({ addAgentTabTitleResolver() {} });
  const first = app.context.__PASEO_GLOBAL_TABS__;
  const secondCleanup = app.context.contribute({ addAgentTabTitleResolver() {} });
  const wrappedRow = app.exports.rows.WorkspaceDesktopTabsRow;
  secondCleanup();
  secondCleanup();
  assert.equal(app.context.__PASEO_GLOBAL_TABS__, first);
  assert.equal(app.context.__PASEO_GLOBAL_TABS_LEASE__.owners.size, 1);
  assert.equal(app.exports.rows.WorkspaceDesktopTabsRow, wrappedRow);
  const replacementCleanup = app.context.contribute({ addAgentTabTitleResolver() {} });
  firstCleanup();
  assert.equal(app.context.__PASEO_GLOBAL_TABS__, first);
  replacementCleanup();
  assert.equal(app.context.__PASEO_GLOBAL_TABS__, undefined);
});

test("a new plugin revision transfers existing owners to the replacement controller", () => {
  const app = harness(titleSyncIds);
  const firstCleanup = app.context.contribute({ addAgentTabTitleResolver() {} });
  const first = app.context.__PASEO_GLOBAL_TABS__;
  first.pinnedDrafts.add("explicitly-kept-empty-draft");
  const lease = app.context.__PASEO_GLOBAL_TABS_LEASE__;
  lease.revision = "old-revision";
  const secondCleanup = app.context.contribute({ addAgentTabTitleResolver() {} });
  const second = app.context.__PASEO_GLOBAL_TABS__;
  assert.notEqual(first, second);
  assert.equal(second.pinnedDrafts.has("explicitly-kept-empty-draft"), true);
  assert.equal(app.context.__PASEO_GLOBAL_TABS_LEASE__, lease);
  assert.equal(lease.owners.size, 2);
  secondCleanup();
  assert.equal(app.context.__PASEO_GLOBAL_TABS__, second);
  firstCleanup();
  assert.equal(app.context.__PASEO_GLOBAL_TABS__, undefined);
  assert.equal(app.exports.rows.WorkspaceDesktopTabsRow, app.originalRow);
});

test("history background retention adds pinned tabs without navigation or duplicates", () => {
  const app = harness(historyIds);
  let presence;
  app.exports.tabPresence.agentTabPresenceBridge.register = value => {presence=value;return () => {};};
  let navigations=0;
  app.exports.navigation.navigateToWorkspace=()=>{navigations++;};
  const cleanup=app.context.contribute({addAgentTabTitleResolver(){}});
  const first={serverId:"host-a",workspaceId:"workspace-a",agentId:"agent-a",tabId:"tab-a"};
  const second={serverId:"host-b",workspaceId:"workspace-b",agentId:"agent-b",tabId:"tab-b"};
  presence.retain(first);
  presence.retain(second);
  presence.retain(first);
  const entries=app.context.__PASEO_GLOBAL_TABS__.model.entries();
  assert.equal(entries.length,2);
  assert.deepEqual(Array.from(entries, entry => entry.agentId), ["agent-a","agent-b"]);
  assert.ok(entries.every(entry=>entry.pinned));
  assert.equal(app.context.__PASEO_GLOBAL_TABS__.model.tabPresence("host-a","agent-a").isOpen,true);
  assert.equal(navigations,0);
  cleanup();
});

test("rebuild with changed module ids keeps the running app map and adds a bundle-keyed map", () => {
  const appRoot = path.join(__dirname, "fixture-rebuild-app");
  const bundleRef = "_expo/static/js/web/index-a1b2c3d4.js";
  const exports = {
    rows: "WorkspaceDesktopTabsRow", presentation: "WorkspaceTabPresentationResolver",
    navigation: "useLastWorkspaceSelection", sessions: "normalizeWorkspaceDescriptor",
    layouts: "createWorkspaceLayoutStore", snapshots: "normalizeAgentSnapshot",
    hostRoutes: "parseHostWorkspaceRouteFromPathname", titles: "resolveAgentTabTitle",
    registry: "useInstalledPlugins", newWorkspaceTabs: "newWorkspaceTabsBridge", keyboardActions: "useKeyboardActionHandler", settings: "useAppSettings",
  };
  const ids = { react: 37 };
  const lines = ['// },37,[38] name:"workspace-layout-state" sidebar-activity-tabs agent-tab-title-line-primary'];
  Object.entries(exports).forEach(([name, symbol], index) => {
    ids[name] = 40000 + index;
    lines.push(`__d(function(g,r,i,a,m,e,d){e.${symbol}=function(){}},${ids[name]},[]);`);
  });
  ids.tabPresence = 41000; ids.tabGroups = 41001;
  lines.push('__d(function(g,r,i,a,m,e,d){e.agentTabPresenceBridge={}},41000,[]);');
  lines.push('__d(function(g,r,i,a,m,e,d){e.isTabGroupKeyVisible=function(){}},41001,[]);');
  const mapsPath = path.join(__dirname, "module-maps.json");
  const running = { ...ids, rows: 39999 };
  const previousMaps = Object.fromEntries(Object.entries(moduleMaps).filter(([key]) => !key.includes("@")));
  previousMaps.sidebarActivity = running;
  const files = new Map([
    [mapsPath, JSON.stringify(previousMaps)],
    [path.join(appRoot, "index.html"), `<script src="/${bundleRef}"></script>`],
    [path.join(appRoot, bundleRef), lines.join("\n")],
  ]);
  const writes = new Map();
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "build-plugin.cjs"), "utf8"), {
    __dirname,
    process: { env: { PASEO_APP_DIST: appRoot } },
    console: { log() {} },
    require(name) {
      if (name === "node:crypto") return require(name);
      if (name === "node:path") return path;
      assert.equal(name, "node:fs");
      return {
        readFileSync(file, encoding) { return files.has(file) ? files.get(file) : fs.readFileSync(file, encoding); },
        writeFileSync(file, value) { writes.set(file, value); },
      };
    },
  });
  const builtMaps = JSON.parse(writes.get(mapsPath));
  assert.deepEqual(builtMaps.sidebarActivity, running);
  assert.deepEqual(builtMaps["sidebarActivity@a1b2c3d4"], ids);
  const contribution = executableContribution(writes.get(path.join(__dirname, "index.client.js")));
  const app = harness(ids, undefined, false, contribution);
  const cleanup = app.context.contribute({ addAgentTabTitleResolver() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(app.context.__PASEO_GLOBAL_TABS_MODULES__)), ids);
  cleanup();
});
