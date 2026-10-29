const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const mapsPath = path.join(__dirname, "module-maps.json");
const maps = JSON.parse(fs.readFileSync(mapsPath, "utf8"));
const roots = process.argv?.includes("--existing-maps") ? []
  : [process.env.PASEO_APP_DIST || "C:/Program Files/Paseo/resources/app-dist", process.env.PASEO_TITLE_SYNC_LEGACY_APP_DIST, process.env.PASEO_TITLE_SYNC_APP_DIST].filter(Boolean);
for (const root of roots) {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const bundleRef = html.match(/src="([^"\n]*\/index-[a-f0-9]+\.js)"/);
  if (!bundleRef) throw new Error("Paseo app bundle not found");
  const bundle = fs.readFileSync(path.join(root, bundleRef[1].replace(/^\//, "")), "utf8");
  const modules = bundle.split("\n");
  function hasExport(line, symbol) {
    return line.includes("." + symbol + "=")
      || new RegExp("Object\\.defineProperty\\([^,]+,[\"']" + symbol + "[\"'],").test(line);
  }
  function moduleId(symbol) {
    const candidates = modules.filter((line) => hasExport(line, symbol));
    if (candidates.length !== 1) throw new Error("Ambiguous module: " + symbol);
    const match = candidates[0].match(/},(\d+),\[[^\]]*\]\);?$/);
    if (!match) throw new Error("Module ID missing: " + symbol);
    return Number(match[1]);
  }
  if (!bundle.includes('},37,[38]') || !bundle.includes('name:"workspace-layout-state"')) throw new Error("Unsupported Paseo bundle");
  const hasNewWorkspaceTabs = modules.some((line) => hasExport(line, "newWorkspaceTabsBridge"));
  const variant = bundle.includes("sidebar-activity-tabs") ? "sidebarActivity"
    : bundle.includes("sidebar-host-menu-terminal-directory-") ? "terminalDirectoryMenu"
    : bundle.includes("desktopTabsDragSpace") ? "noDesktopHeader"
    : bundle.includes("workspace-header-toggle-sidebar") ? "trailingOverflow"
    : modules.some((line) => hasExport(line, "isTabGroupKeyVisible")) ? "tabGroups"
    : modules.some((line) => hasExport(line, "WorkspaceHeaderMenuOverflow")) ? "tabTrailingMenu"
    : modules.some((line) => hasExport(line, "attachHistoryRowInteractions")) ? "historyInteractions"
    : modules.some((line) => hasExport(line, "useHistoryTabPresence")) ? "historyTab"
    : modules.some((line) => hasExport(line, "agentTabPresenceBridge")) ? "sessionHistory"
    : modules.some((line) => hasExport(line, "reorderHostProfiles")) ? "hostSortable"
    : bundle.includes("Bulk session settings") ? "sessionIdentity"
    : modules.some((line) => hasExport(line, "selectAgentTabCompletedAt")) ? "completionAge"
    : modules.some((line) => hasExport(line, "followSidebarWorkspace")) ? "sidebarScroll"
    : modules.some((line) => hasExport(line, "useSidebarRevealStore")) ? "sidebarReveal"
    : bundle.includes("sidebar-collapse-all-hosts") ? "sidebarBulkCollapse"
    : bundle.includes("sidebar-host-project-list") ? "hostProjectGroups"
    : hasNewWorkspaceTabs ? "workspaceCreateTabs"
    : bundle.includes("agent-tab-title-line-primary") ? "titleSyncTwoLine"
    : bundle.includes("addAgentTabTitleResolver") ? "titleSync" : "original";
  const previousVariantMap = maps[variant];
  maps[variant] = { react: 37, rows: moduleId("WorkspaceDesktopTabsRow"),
    presentation: moduleId("WorkspaceTabPresentationResolver"), navigation: moduleId("useLastWorkspaceSelection"),
    sessions: moduleId("normalizeWorkspaceDescriptor"), layouts: moduleId("createWorkspaceLayoutStore"),
    snapshots: moduleId("normalizeAgentSnapshot"), hostRoutes: moduleId("parseHostWorkspaceRouteFromPathname") };
  if(["tabGroups","trailingOverflow","noDesktopHeader","terminalDirectoryMenu","sidebarActivity"].includes(variant))maps[variant].tabGroups=moduleId("isTabGroupKeyVisible");
  maps[variant].keyboardActions = moduleId("useKeyboardActionHandler");
  maps[variant].settings = moduleId("useAppSettings");
  if (modules.some((line) => hasExport(line, "reopenLastClosedWorkspaceTab"))) {
    maps[variant].reopen = moduleId("reopenLastClosedWorkspaceTab");
    maps[variant].shortcuts = moduleId("useKeyboardShortcutsStore");
  }
  if (variant !== "original") {
    maps[variant].titles = moduleId("resolveAgentTabTitle");
    maps[variant].registry = moduleId("useInstalledPlugins");
  }
  if (hasNewWorkspaceTabs) maps[variant].newWorkspaceTabs = moduleId("newWorkspaceTabsBridge");
  if (["sessionHistory", "historyTab", "historyInteractions", "tabTrailingMenu", "tabGroups", "trailingOverflow", "noDesktopHeader", "terminalDirectoryMenu", "sidebarActivity"].includes(variant)) maps[variant].tabPresence = moduleId("agentTabPresenceBridge");
  // A rebuild without a new marker keeps the running app's map; the new build gets its own key.
  if (previousVariantMap && JSON.stringify(previousVariantMap) !== JSON.stringify(maps[variant])) {
    const bundleKey = variant + "@" + bundleRef[1].match(/index-([a-f0-9]+)\.js/)[1].slice(0, 12);
    maps[bundleKey] = maps[variant];
    maps[variant] = previousVariantMap;
  }
}
if (!maps.original || !maps.titleSync) throw new Error("Both Paseo module maps must be retained");
const model = fs.readFileSync(path.join(__dirname, "model.js"), "utf8");
const factory = model.slice(model.indexOf('})(globalThis, function () {') + '})(globalThis, function () {'.length, model.lastIndexOf('});'));
const client = fs.readFileSync(path.join(__dirname, "client.js"), "utf8");
const metadata = fs.readFileSync(path.join(__dirname, "metadata.js"), "utf8");
const metadataFactory = metadata.slice(metadata.indexOf('})(globalThis, function () {') + '})(globalThis, function () {'.length, metadata.lastIndexOf('});'));
const history = fs.readFileSync(path.join(__dirname, "history.js"), "utf8");
const historyFactory = history.slice(history.indexOf('})(globalThis, function () {') + '})(globalThis, function () {'.length, history.lastIndexOf('});'));
const revision = createHash("sha256").update("shared-hosts-v1" + JSON.stringify(maps) + model + metadata + history + client).digest("hex");
const plugin = `import { getPaseoClient } from "@getpaseo/plugin/client";
export default function contribute(client) {
  if (typeof document === "undefined" || typeof globalThis.__r !== "function") return () => {};
  const candidates = typeof client?.addAgentTabTitleResolver === "function"
    ? ${JSON.stringify([...Object.keys(maps).filter((key) => key.includes("@")).reverse().map((key) => maps[key]), maps.sidebarActivity, maps.terminalDirectoryMenu, maps.noDesktopHeader, maps.trailingOverflow, maps.tabGroups, maps.tabTrailingMenu, maps.historyInteractions, maps.historyTab, maps.sessionHistory, maps.hostSortable, maps.completionAge, maps.sessionIdentity, maps.sidebarScroll, maps.sidebarReveal, maps.sidebarBulkCollapse, maps.hostProjectGroups, maps.workspaceCreateTabs, maps.titleSyncTwoLine, maps.titleSync].filter(Boolean))}
    : [${JSON.stringify(maps.original)}];
  let ids, modules;
  for (const candidate of candidates) {
    let loaded;
    try {
      loaded = Object.fromEntries(Object.entries(candidate).map(([name, id]) => [name, globalThis.__r(id)]));
    } catch { continue; }
    const valid = typeof loaded.react?.createElement === "function"
      && typeof loaded.react?.useState === "function"
      && typeof loaded.react?.useEffect === "function"
      && typeof loaded.react?.useSyncExternalStore === "function"
      && typeof loaded.rows?.WorkspaceDesktopTabsRow === "function"
      && typeof loaded.presentation?.WorkspaceTabPresentationResolver === "function"
      && typeof loaded.navigation?.navigateToWorkspace === "function"
      && typeof loaded.navigation?.useLastWorkspaceSelection === "function"
      && typeof loaded.navigation?.getLastWorkspaceSelection === "function"
      && typeof loaded.hostRoutes?.parseHostWorkspaceRouteFromPathname === "function"
      && typeof loaded.keyboardActions?.useKeyboardActionHandler === "function"
      && (!candidate.settings || typeof loaded.settings?.useSettings === "function")
      && (!candidate.titles || ["selectAgentTabSidebarLabel", "selectAgentTabProjectLabel"]
        .every((name) => typeof loaded.titles?.[name] === "function"))
      && (!candidate.tabGroups || (typeof loaded.tabGroups?.isTabGroupKeyVisible === "function"
        && typeof loaded.tabGroups?.forgetTabGroupKey === "function"
        && typeof loaded.tabGroups?.useTabGroups === "function"
        && typeof loaded.tabGroups?.useTabGroups?.getState === "function"
        && typeof loaded.tabGroups?.useTabGroups?.subscribe === "function"
        && typeof loaded.tabGroups?.useTabGroups?.getState()?.update === "function"))
      && typeof loaded.sessions?.useSessionStore === "function"
      && typeof loaded.sessions?.useSessionStore?.getState === "function"
      && typeof loaded.sessions?.useSessionStore?.subscribe === "function"
      && typeof loaded.sessions?.useSessionStore?.getState()?.setAgentDetails === "function"
      && typeof loaded.snapshots?.normalizeAgentSnapshot === "function"
      && typeof loaded.layouts?.useWorkspaceLayoutStore?.getState === "function"
      && typeof loaded.layouts?.useWorkspaceLayoutStore?.setState === "function"
      && (!candidate.reopen || typeof loaded.reopen?.reopenLastClosedWorkspaceTab === "function")
      && (!candidate.tabPresence || ["read", "getSnapshot", "subscribe", "register"]
        .every((name) => typeof loaded.tabPresence?.agentTabPresenceBridge?.[name] === "function"))
      && (!candidate.newWorkspaceTabs || ["getSnapshot", "subscribe", "registerTabBar", "open", "activate", "close"]
        .every((name) => typeof loaded.newWorkspaceTabs?.newWorkspaceTabsBridge?.[name] === "function"));
    if (valid) { ids = candidate; modules = loaded; break; }
  }
  if (!modules) throw new Error("Global Workspace Tabs: unsupported Paseo module exports");
  const leaseKey = "__PASEO_GLOBAL_TABS_LEASE__";
  const revision = ${JSON.stringify(revision)};
  let lease = globalThis[leaseKey];
  function retain(current) {
    const owner = Symbol();
    current.owners.add(owner);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      current.owners.delete(owner);
      if (current.owners.size > 0) return;
      current.controller.dispose();
      if (globalThis[leaseKey] === current) delete globalThis[leaseKey];
    };
  }
  if (lease?.revision === revision && lease.controller === globalThis.__PASEO_GLOBAL_TABS__) return retain(lease);
  globalThis.__PASEO_GLOBAL_TABS__?.dispose();
  globalThis.__PASEO_GLOBAL_TABS_MODULES__ = ids;
  globalThis.PaseoGlobalTabsModel = (function () {${factory}})();
  globalThis.PaseoGlobalTabsMetadata = (function () {${metadataFactory}})();
  globalThis.PaseoGlobalTabsHistory = (function () {${historyFactory}})();
  ${client}
  const installed = globalThis.__PASEO_GLOBAL_TABS__;
  lease ??= { owners: new Set() };
  lease.controller = installed;
  lease.revision = revision;
  globalThis[leaseKey] = lease;
  return retain(lease);
}
`;
fs.writeFileSync(path.join(__dirname, "index.client.js"), plugin);
fs.writeFileSync(mapsPath, JSON.stringify(maps, null, 2) + "\n");
console.log("Built plugin with both Paseo module maps:", JSON.stringify(maps));
