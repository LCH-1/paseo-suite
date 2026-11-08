(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PaseoGlobalTabsHistory = factory();
})(globalThis, function () {
  "use strict";
  const origin = "global-workspace-tabs";
  function install({ model, layouts, functions, reopen, navigate, pathname, terminal, shortcuts }) {
    if (!reopen || typeof layouts.getState().recordClosedTab !== "function") {
      return { restore: () => false, onKey() {}, dispose() {} };
    }
    const close = model.close;
    let stopped = false;
    function closeWithHistory(key) {
      const entries = model.entries();
      const index = entries.findIndex((entry) => entry.key === key);
      const entry = entries[index];
      close(key);
      if (stopped || !entry || model.entries().some((item) => item.key === key)) return;
      const workspaceKey = entry.serverId + ":" + entry.workspaceId;
      const tree = layouts.getState().layoutByWorkspace[workspaceKey];
      const tab = tree && functions.collectAllTabs(tree.root).find((tab) => tab.tabId === entry.tabId);
      const pane = tree && functions.findPaneContainingTab(tree.root, entry.tabId);
      layouts.getState().recordClosedTab(workspaceKey, {
        tab: tab || { tabId: entry.tabId, target: { kind: "agent", agentId: entry.agentId }, createdAt: Date.now() },
        paneId: pane?.id ?? null, browserUrl: null, origin, position: index,
      });
    }
    model.close = closeWithHistory;
    function restore() {
      if (stopped) return false;
      while (!stopped) {
        const route = pathname().match(/^\/h\/([^/]+)\/workspace\/([^/]+)/);
        let workspaceKey = route ? decodeURIComponent(route[1]) + ":" + decodeURIComponent(route[2]) : null;
        const histories = layouts.getState().closedTabsByWorkspace;
        let selected = workspaceKey ? histories[workspaceKey]?.at(-1) : null;
        for (const [key, entries] of Object.entries(histories)) {
          const candidate = entries.at(-1);
          if (candidate?.origin === origin && (!selected || (candidate.sequence ?? 0) > (selected.sequence ?? 0))) {
            workspaceKey = key; selected = candidate;
          }
        }
        if (!workspaceKey || selected?.origin !== origin || selected.tab.target.kind !== "agent") return false;
        const boundary = workspaceKey.lastIndexOf(":");
        const serverId = workspaceKey.slice(0, boundary), workspaceId = workspaceKey.slice(boundary + 1);
        if (model.retainAt(serverId, workspaceId, selected.tab, selected.position) === null) {
          const state = layouts.getState();
          if (typeof state.takeLastClosedTab !== "function" || state.closedTabsByWorkspace[workspaceKey]?.at(-1) !== selected) return false;
          state.takeLastClosedTab(workspaceKey);
          continue;
        }
        reopen({ workspaceKey, createTerminal: terminal });
        navigate({ serverId, workspaceId, target: selected.tab.target, placement: { mode: "focused" } });
        return true;
      }
      return false;
    }
    function onKey(event) {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey === event.metaKey || !event.shiftKey || event.altKey || event.code !== "KeyT") return;
      const state = shortcuts?.getState();
      if (state?.commandCenterOpen || state?.shortcutsDialogOpen || state?.capturingShortcut) return;
      if (!restore()) return;
      event.preventDefault(); event.stopImmediatePropagation?.();
    }
    return { restore, onKey, dispose() { stopped = true; if (model.close === closeWithHistory) model.close = close; } };
  }
  return { install };
});
