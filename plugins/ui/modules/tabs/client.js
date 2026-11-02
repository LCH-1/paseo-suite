(function () {
  "use strict";
  const ids = globalThis.__PASEO_GLOBAL_TABS_MODULES__;
  const requireModule = globalThis.__r;
  const React = requireModule(ids.react);
  const rowsModule = requireModule(ids.rows);
  const presentationModule = requireModule(ids.presentation);
  const navigation = requireModule(ids.navigation);
  const sessions = requireModule(ids.sessions).useSessionStore;
  const layouts = requireModule(ids.layouts).useWorkspaceLayoutStore;
  const parseWorkspaceRoute = requireModule(ids.hostRoutes).parseHostWorkspaceRouteFromPathname;
  const normalizeAgentSnapshot = requireModule(ids.snapshots).normalizeAgentSnapshot;
  const useKeyboardActionHandler = requireModule(ids.keyboardActions).useKeyboardActionHandler;
  const titleSelectors = ids.titles == null ? null : requireModule(ids.titles);
  const useSettings = ids.settings == null ? null : requireModule(ids.settings).useSettings;
  const draftBridge = ids.newWorkspaceTabs == null ? null : requireModule(ids.newWorkspaceTabs).newWorkspaceTabsBridge;
  const presenceBridge = ids.tabPresence == null ? null : requireModule(ids.tabPresence).agentTabPresenceBridge;
  const groupModule = ids.tabGroups == null ? null : requireModule(ids.tabGroups);
  const originalRow = rowsModule.WorkspaceDesktopTabsRow;
  const originalPresentation = presentationModule.WorkspaceTabPresentationResolver;
  let storage;
  try { storage = globalThis.localStorage; } catch {}
  const model = globalThis.PaseoGlobalTabsModel.createModel(storage, () => sessions.getState().sessions);
  let storageWarningShown = false;
  function reportStorageStatus() {
    const status = model.storageStatus();
    if (status.state !== "memory-only" || storageWarningShown) return;
    storageWarningShown = true;
    console.warn("[global-workspace-tabs] " + status.message);
  }
  const releaseStorageStatus = model.subscribe(reportStorageStatus);
  reportStorageStatus();
  const metadata = globalThis.PaseoGlobalTabsMetadata.createLoader({ model, sessions, normalizeAgentSnapshot,
    getPaseoClient: typeof getPaseoClient === "function" ? getPaseoClient : null });
  const sources = new Map();
  const keyboardSources = new Map();
  const bySyntheticId = new Map();
  const timers = new Set();
  const virtualTabs = new Map();
  const handoffs = new Map();
  const knownDrafts = new Map();
  const draftSlots = new Map();
  const projectionListeners = new Set();
  const draftPresentations = new Map();
  let draftOrder = [];
  let projectionRevision = 0;
  let bridgeState = draftBridge?.getSnapshot() || { entries: [], activeDraftId: null, completions: [] };
  const pinnedDrafts = new Set([...(typeof previousDraftPins === "undefined" ? [] : previousDraftPins),
    ...bridgeState.entries.filter((entry) => draftBridge?.hasInput?.(entry.draftId)).map((entry) => entry.draftId)]);
  let reconcilingPreview = false;
  let observedPreview = model.preview()?.key;
  let lastCompletion = Math.max(0, ...(bridgeState.completions || []).map((item) => item.sequence));
  bridgeState.entries.forEach((entry) => knownDrafts.set(entry.draftId, entry));
  let rendered = false;
  let disposed = false;
  let pinIntent = null;
  let cycleCursor = null;
  const pendingNativeCloses = new Set();
  const dismissPreview = model.close;
  const history = globalThis.PaseoGlobalTabsHistory.install({
    model, layouts, functions: requireModule(ids.layouts),
    reopen: ids.reopen == null ? null : requireModule(ids.reopen).reopenLastClosedWorkspaceTab,
    shortcuts: ids.shortcuts == null ? null : requireModule(ids.shortcuts).useKeyboardShortcutsStore,
    navigate: navigation.navigateToWorkspace, pathname: () => globalThis.location?.pathname || "",
    terminal() {},
  });
  const prefix = "global-agent:";
  const draftPrefix = "global-new-workspace:";
  const virtualId = (draftId) => draftPrefix + JSON.stringify(draftId);
  const syntheticId = (entry) => prefix + entry.key;
  function syncGroupSources() {
    if (!groupModule) return;
    const store = groupModule.useTabGroups.getState();
    const current = store.state;
    const replacements = new Map();
    const groups = current.groups.map(group => ({ ...group, tabs: group.tabs.map(tab => {
      if (tab.target.kind !== "agent" || !tab.key.startsWith(prefix)) return tab;
      const source = tab.groupSource;
      const entry = model.entries().find(item => item.serverId === source?.serverId && item.agentId === tab.target.agentId);
      if (!entry) return tab;
      const key = syntheticId(entry);
      if (tab.key === key && source.workspaceId === entry.workspaceId && source.tabId === entry.tabId) return tab;
      replacements.set(tab.key, key);
      return { ...tab, key, tabId: key, groupSource: { serverId: entry.serverId, workspaceId: entry.workspaceId, tabId: entry.tabId } };
    }) }));
    if (replacements.size) store.update(state => ({ ...state, groups,
      order: [...new Set(state.order.map(key => replacements.get(key) || key))] }));
  }
  const releaseGroupModel = model.subscribe(syncGroupSources);
  const releaseGroupStore = groupModule ? groupModule.useTabGroups.subscribe(syncGroupSources) : () => {};
  syncGroupSources();
  const liveKey = (props) => props.globalDraftContext ? JSON.stringify(["new-workspace", props.globalDraftId])
    : JSON.stringify([props.normalizedServerId, props.normalizedWorkspaceId]);
  const paneKey = (props) => JSON.stringify([liveKey(props), props.paneId]);
  function lookup(tabId) {
    const cached = bySyntheticId.get(tabId);
    return cached && model.entries().find(entry => entry.serverId === cached.serverId && entry.agentId === cached.agentId);
  }
  function lookupVirtual(tabId) { return virtualTabs.get(tabId); }
  function notifyProjection() {
    projectionRevision++;
    projectionListeners.forEach((listener) => listener());
  }
  function subscribeProjection(listener) { projectionListeners.add(listener); return () => projectionListeners.delete(listener); }
  function pinDraft(draftId) {
    if (!knownDrafts.has(draftId) || pinnedDrafts.has(draftId)) return false;
    pinnedDrafts.add(draftId);
    draftPresentations.delete(virtualId(draftId));
    notifyProjection();
    return true;
  }
  // Agent previews and empty workspace drafts share one temporary tab slot.
  // Replacing a draft only removes its tab; its saved input remains recoverable.
  function replacePreview(draftId) {
    if (reconcilingPreview) return;
    reconcilingPreview = true;
    try {
      if (draftId && model.preview()) dismissPreview(model.preview().key);
      for (const entry of [...bridgeState.entries]) {
        if (entry.kind === "history" || entry.draftId === draftId || pinnedDrafts.has(entry.draftId)) continue;
        if (draftBridge.hasInput?.(entry.draftId)) { pinDraft(entry.draftId); continue; }
        draftBridge.close(entry.draftId, { preserveDraft: true });
      }
      observedPreview = model.preview()?.key;
    } finally { reconcilingPreview = false; }
  }
  const releasePreview = model.subscribe(() => {
    const key = model.preview()?.key;
    if (!reconcilingPreview && key && key !== observedPreview) replacePreview(null);
    observedPreview = model.preview()?.key;
  });
  function setDraftOrder(keys) {
    let count = 0;
    draftOrder = [];
    for (const key of keys) {
      if (key.startsWith(prefix)) count++;
      else if (key.startsWith(draftPrefix)) {
        const draftId = JSON.parse(key.slice(draftPrefix.length));
        draftSlots.set(draftId, count);
        draftOrder.push(draftId);
      }
    }
  }
  function visibleEntries(state) {
    return model.entries().filter((entry) => {
      if(groupModule&&!groupModule.isTabGroupKeyVisible(syntheticId(entry)))return false;
      const session = state[entry.serverId];
      const agent = session?.agents.get(entry.agentId) || session?.agentDetails.get(entry.agentId);
      return !agent?.archivedAt;
    });
  }
  function globalItems(state, snapshot = bridgeState) {
    virtualTabs.clear();
    const agents = visibleEntries(state).map((entry) => ({ key: syntheticId(entry), entry }));
    const drafts = [...snapshot.entries, ...[...handoffs.values()].filter((entry) => !snapshot.entries.some((item) => item.draftId === entry.draftId))];
    const rank = new Map(draftOrder.map((id, index) => [id, index]));
    drafts.sort((left, right) => (rank.get(left.draftId) ?? draftOrder.length) - (rank.get(right.draftId) ?? draftOrder.length));
    const slots = new Map();
    drafts.forEach((draft) => {
      if (!draftSlots.has(draft.draftId)) draftSlots.set(draft.draftId, agents.length);
      const position = Math.min(draftSlots.get(draft.draftId), agents.length);
      const item = { key: virtualId(draft.draftId), draft };
      virtualTabs.set(item.key, draft);
      if (!slots.has(position)) slots.set(position, []);
      slots.get(position).push(item);
    });
    return agents.flatMap((agent, index) => [...(slots.get(index) || []), agent]).concat(slots.get(agents.length) || []);
  }
  function syncBridge() {
    if (disposed) return;
    let before = globalItems(sessions.getState().sessions);
    bridgeState = draftBridge.getSnapshot();
    const added = bridgeState.entries.filter(entry => !knownDrafts.has(entry.draftId) && entry.kind !== "history");
    bridgeState.entries.forEach((entry) => {
      knownDrafts.set(entry.draftId, entry);
      if (draftBridge.hasInput?.(entry.draftId)) pinDraft(entry.draftId);
    });
    for (const completion of [...(bridgeState.completions || [])].sort((left, right) => left.sequence - right.sequence)) {
      if (completion.sequence <= lastCompletion) continue;
      lastCompletion = completion.sequence;
      const draft = knownDrafts.get(completion.draftId);
      if (!draft) continue;
      const id = virtualId(completion.draftId);
      const position = before.findIndex((item) => item.key === id);
      if (completion.target?.kind === "agent" && completion.tabId) {
        const prior = before.slice(0, position < 0 ? before.length : position).filter((item) => item.entry).at(-1)?.entry;
        const index = prior ? model.entries().findIndex((entry) => entry.key === prior.key) + 1 : 0;
        const tab = { tabId: completion.tabId, target: completion.target };
        const agentKey = prefix + model.keyOf(completion.serverId, completion.workspaceId, tab.tabId);
        setDraftOrder(before.map((item) => item.key === id ? agentKey : item.key));
        handoffs.delete(completion.draftId);
        knownDrafts.delete(completion.draftId);
        draftSlots.delete(completion.draftId);
        const entry = model.retainAt(completion.serverId, completion.workspaceId, tab, index);
        before = before.map((item) => item.key === id ? { key: agentKey, entry } : item);
      } else if (completion.target && completion.tabId) {
        handoffs.set(completion.draftId, { ...draft, serverId: completion.serverId, workspaceId: completion.workspaceId,
          target: completion.target, tabId: completion.tabId });
        before = before.map((item) => item.key === id ? { key: id, draft: handoffs.get(completion.draftId) } : item);
      } else {
        handoffs.delete(completion.draftId);
        knownDrafts.delete(completion.draftId);
        draftSlots.delete(completion.draftId);
        before = before.filter((item) => item.key !== id);
      }
    }
    for (const id of knownDrafts.keys()) {
      if (!bridgeState.entries.some((entry) => entry.draftId === id) && !handoffs.has(id)) knownDrafts.delete(id);
    }
    for (const id of pinnedDrafts) if (!knownDrafts.has(id)) pinnedDrafts.delete(id);
    const previewDraft = added.filter(entry => !pinnedDrafts.has(entry.draftId)).at(-1);
    if (previewDraft) replacePreview(previewDraft.draftId);
    notifyProjection();
  }
  function currentSelection() {
    return typeof globalThis.location?.pathname === "string" ? parseWorkspaceRoute(globalThis.location.pathname) : null;
  }
  function cycleSelection() {
    if (draftBridge && ["/new", "/sessions"].includes(globalThis.location?.pathname) && bridgeState.activeDraftId) {
      return { draftId: bridgeState.activeDraftId };
    }
    return currentSelection();
  }
  function selectionKey(selection) {
    return selection.draftId ? JSON.stringify(["new-workspace", selection.draftId])
      : JSON.stringify([selection.serverId, selection.workspaceId]);
  }
  function findPane(node, paneId) {
    if (!node) return null;
    if (node.kind === "pane") return node.pane.id === paneId ? node.pane : null;
    for (const child of node.group?.children || []) {
      const pane = findPane(child, paneId);
      if (pane) return pane;
    }
    return null;
  }
  function activeTarget(selection, paneId) {
    if (!selection) return null;
    const layout = layouts.getState().layoutByWorkspace[selection.serverId + ":" + selection.workspaceId];
    const pane = findPane(layout?.root, paneId || layout?.focusedPaneId);
    const source = [...(sources.get(JSON.stringify([selection.serverId, selection.workspaceId]))?.values() || [])]
      .find(item => paneId ? item.paneId === paneId : item.isFocused !== false);
    const tab = pane ? pane.tabs.find((item) => item.tabId === pane.focusedTabId)
      : source?.tabs.find(item => item.isActive)?.tab;
    return tab?.target?.kind === "agent" ? tab : null;
  }
  function pinSelected(selection, paneId, agentId) {
    const tab = activeTarget(selection, paneId);
    if (!tab || (agentId && tab.target.agentId !== agentId)) return false;
    const state = sessions.getState().sessions;
    const session = state[selection.serverId];
    const agent = session?.agents.get(tab.target.agentId) || session?.agentDetails.get(tab.target.agentId);
    if (agent?.workspaceId && agent.workspaceId !== selection.workspaceId) return false;
    model.reconcile(state);
    model.ingest(selection.serverId, selection.workspaceId, [{ tab, isActive: true }]);
    const entry = model.entries().find((item) => item.serverId === selection.serverId
      && item.workspaceId === selection.workspaceId && item.agentId === tab.target.agentId);
    if (!entry) return false;
    model.pin(entry.key);
    return true;
  }
  function flushPinIntent() {
    if (!pinIntent || disposed) return;
    if (Date.now() > pinIntent.expires) { pinIntent = null; return; }
    const selection = currentSelection();
    if (!selection || selection.serverId !== pinIntent.serverId
      || (pinIntent.workspaceId && selection.workspaceId !== pinIntent.workspaceId)) return;
    const intent = pinIntent;
    pinIntent = null;
    if (!pinSelected(selection, null, intent.agentId)) pinIntent = intent;
  }
  function eventElement(event) {
    return event.target?.nodeType === 3 ? event.target.parentElement : event.target;
  }
  function ancestors(element) {
    const result = [];
    for (let node = element; node?.getAttribute; node = node.parentElement) result.push(node);
    return result;
  }
  function actionInside(element, row) {
    return ancestors(element).some((node) => node !== row && row.contains(node)
      && (node.tagName === "BUTTON" || node.getAttribute("role") === "button"
        || node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.isContentEditable));
  }
  function onDoubleClick(event) {
    const element = eventElement(event);
    const nodes = ancestors(element);
    const state = sessions.getState().sessions;
    const selection = currentSelection();
    for (const node of nodes) {
      const id = node.getAttribute("data-testid") || "";
      const draft = virtualTabs.get(id.slice("workspace-tab-".length));
      if (id.startsWith("workspace-tab-" + draftPrefix) && draft) {
        if (!actionInside(element, node)) pinDraft(draft.draftId);
        return;
      }
      if (id.startsWith("workspace-tab-agent_")) {
        if (!selection || actionInside(element, node)) return;
        const agentId = id.slice("workspace-tab-agent_".length);
        const entry = model.entries().find((item) => item.serverId === selection.serverId && item.agentId === agentId);
        if (entry) model.pin(entry.key);
        else {
          pinIntent = { serverId: selection.serverId, workspaceId: selection.workspaceId, agentId, expires: Date.now() + 2500 };
          flushPinIntent();
        }
        return;
      }
      for (const serverId of Object.keys(state)) {
        const workspacePrefix = "sidebar-workspace-row-" + serverId + ":";
        const agentPrefix = "agent-row-" + serverId + "-";
        const activityPrefix = "sidebar-activity-session-" + serverId + "-";
        if (!id.startsWith(workspacePrefix) && !id.startsWith(agentPrefix) && !id.startsWith(activityPrefix)) continue;
        if (actionInside(element, node)) return;
        pinIntent = { serverId, expires: Date.now() + 2500,
          ...(id.startsWith(workspacePrefix) ? { workspaceId: id.slice(workspacePrefix.length) }
            : { agentId: id.slice(id.startsWith(activityPrefix) ? activityPrefix.length : agentPrefix.length) }) };
        flushPinIntent();
        return;
      }
    }
  }
  let lastClick = null;
  function onClick(event) {
    if (event.isTrusted === false || event.button > 0) return;
    const element = eventElement(event);
    const row = ancestors(element).find(node => /^(sidebar-activity-session-|sidebar-workspace-row-|agent-row-)/.test(node.getAttribute("data-testid") || ""));
    if (!row || actionInside(element, row)) { lastClick = null; return; }
    const id = row.getAttribute("data-testid");
    const now = Date.now();
    if (lastClick?.id === id && now - lastClick.time <= 500) {
      lastClick = null;
      onDoubleClick(event);
    } else lastClick = { id, time: now };
  }
  function onDraftInput(event) {
    if (event.isTrusted === false) return;
    const element = eventElement(event);
    if (!element?.hasAttribute?.("data-composer-input") || element.disabled || element.readOnly) return;
    const nodes = ancestors(element);
    if (!nodes.some((node) => node.getAttribute("data-testid") === "message-input-root")) return;
    const inserted = typeof event.data === "string" && event.data.length > 0;
    const realDraft = typeof element.value === "string" && element.value.length > 0
      && (event.type === "input" && !String(event.inputType || "").startsWith("delete"));
    if (!inserted && !realDraft) return;
    if (draftBridge && globalThis.location?.pathname === "/new" && bridgeState.activeDraftId) {
      pinDraft(bridgeState.activeDraftId);
      return;
    }
    if (nodes.some((node) => node.getAttribute("data-testid") === "workspace-setup-dialog")) return;
    const paneNode = nodes.find((node) => (node.getAttribute("data-testid") || "").startsWith("workspace-pane-"));
    const selection = currentSelection();
    if (selection) pinSelected(selection, paneNode?.getAttribute("data-testid").slice("workspace-pane-".length));
  }
  function visibleOverlay(node) {
    if (ancestors(node).some((item) => item.hidden || item.getAttribute("aria-hidden") === "true")) return false;
    if (typeof node.getClientRects === "function" && node.getClientRects().length === 0) return false;
    const style = globalThis.window?.getComputedStyle?.(node);
    return !style || (style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse");
  }
  function keyboardBlocked() {
    if (globalThis.document?.visibilityState === "hidden") return true;
    if (!globalThis.document?.querySelectorAll) return false;
    const selector = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],[data-testid="command-center-panel"],[data-menu-surface="true"]';
    if ([...document.querySelectorAll(selector)].some(visibleOverlay)) return true;
    try { return [...document.querySelectorAll(":popover-open")].some(visibleOverlay); }
    catch { return false; }
  }
  function focusedKeyboardSource(selection) {
    if (selection.draftId) return [...keyboardSources.values()].find((source) => source.globalDraftContext
      && source.globalDraftId === selection.draftId && source.isFocused !== false) || null;
    const candidates = [...keyboardSources.values()].filter((source) => source.normalizedServerId === selection.serverId
      && source.normalizedWorkspaceId === selection.workspaceId && source.isFocused !== false
      && source.ownsKeyboardShortcuts !== false);
    const layout = layouts.getState().layoutByWorkspace[selection.serverId + ":" + selection.workspaceId];
    if (layout?.focusedPaneId) return candidates.find((source) => source.paneId === layout.focusedPaneId) || null;
    return candidates.length === 1 ? candidates[0] : null;
  }
  function cycleRows(source, visibleOnly = false, includeKey) {
    const rows = [...globalItems(sessions.getState().sessions),
      ...source.tabs.filter((row) => row.tab.target.kind !== "agent")
        .filter((row) => ![...handoffs.values()].some((entry) => entry.serverId === source.normalizedServerId
          && entry.workspaceId === source.normalizedWorkspaceId && entry.tabId === row.tab.tabId))
        .map((row) => ({ key: JSON.stringify([paneKey(source), row.tab.tabId]), tab: row.tab }))];
    if (!groupModule) return rows;
    // The host projects group order after receiving our rows. Use that same order
    // for navigation, including collapsed members (activation expands the group).
    const state = groupModule.useTabGroups.getState().state;
    const byKey = new Map(rows.map(row => [row.tab?.key ?? row.key, row])
      .filter(([key]) => groupModule.isTabGroupKeyVisible(key)));
    const order = [...state.order.filter(key => byKey.has(key)),
      ...[...byKey.keys()].filter(key => !state.order.includes(key))];
    const membership = new Map(state.groups.flatMap(group => group.tabs.map(tab => [tab.key, group])));
    const seen = new Set();
    const result = [];
    for (const key of order) {
      const group = membership.get(key);
      if (!group) { result.push(byKey.get(key)); continue; }
      if (seen.has(group.id) || group.closed) continue;
      seen.add(group.id);
      for (const member of group.tabs) {
        const row = byKey.get(member.key);
        if (row && (!visibleOnly || !group.collapsed || row.key === includeKey)) result.push(row);
      }
    }
    return result;
  }
  function activeCycleKey(source, rows) {
    if (source.globalDraftContext) return bridgeState.activeDraftId ? virtualId(bridgeState.activeDraftId) : null;
    const layout = layouts.getState().layoutByWorkspace[source.normalizedServerId + ":" + source.normalizedWorkspaceId];
    const pane = findPane(layout?.root, source.paneId);
    const tab = pane ? pane.tabs.find((item) => item.tabId === pane.focusedTabId)
      : source.tabs.find((row) => row.isActive)?.tab;
    if (!tab) return null;
    return rows.find((row) => row.entry ? row.entry.serverId === source.normalizedServerId
      && row.entry.workspaceId === source.normalizedWorkspaceId && row.entry.agentId === tab.target?.agentId
      : row.draft ? row.draft.serverId === source.normalizedServerId && row.draft.workspaceId === source.normalizedWorkspaceId
        && row.draft.tabId === tab.tabId : row.tab.tabId === tab.tabId)?.key || null;
  }
  function resetCycle() { cycleCursor = null; }
  function onCycleKey(event) {
    if (disposed) return;
    if (event.key !== "Tab" || !event.ctrlKey || event.altKey || event.metaKey) {
      if (event.key !== "Control" && event.key !== "Shift") resetCycle();
      return;
    }
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || keyboardBlocked()) {
      resetCycle();
      return;
    }
    const selection = cycleSelection();
    if (!selection) { resetCycle(); return; }
    const now = Date.now();
    const recent = cycleCursor && now - cycleCursor.time < 1500;
    const selectedScope = selectionKey(selection);
    let source = focusedKeyboardSource(selection);
    if (!source && recent && cycleCursor.scopes.has(selectedScope)) {
      const previous = keyboardSources.get(cycleCursor.sourceKey);
      if (previous?.isFocused !== false && previous?.ownsKeyboardShortcuts !== false) source = previous;
    }
    if (!source) { resetCycle(); return; }
    const rows = cycleRows(source);
    if (!rows.length) { resetCycle(); return; }
    const scope = liveKey(source);
    const sourceKey = paneKey(source);
    const activeKey = activeCycleKey(source, rows);
    const continued = recent && cycleCursor.scopes.has(scope)
      && (!cycleCursor.panes.has(scope) || cycleCursor.panes.get(scope) === sourceKey)
      && cycleCursor.trail.has(activeKey) && rows.some((row) => row.key === cycleCursor.key);
    const previousKey = continued ? cycleCursor.key : activeKey;
    const index = rows.findIndex((row) => row.key === previousKey);
    const nextIndex = index < 0 ? (event.shiftKey ? rows.length - 1 : 0)
      : (index + (event.shiftKey ? -1 : 1) + rows.length) % rows.length;
    const target = rows[nextIndex];
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const cursor = continued ? cycleCursor : { trail: new Set([activeKey]), scopes: new Set([scope]), panes: new Map() };
    cursor.key = target.key;
    cursor.time = now;
    cursor.sourceKey = sourceKey;
    cursor.trail.add(target.key);
    cursor.panes.set(scope, sourceKey);
    if (target.entry) cursor.scopes.add(JSON.stringify([target.entry.serverId, target.entry.workspaceId]));
    if (target.draft) cursor.scopes.add(target.draft.target
      ? JSON.stringify([target.draft.serverId, target.draft.workspaceId])
      : JSON.stringify(["new-workspace", target.draft.draftId]));
    cycleCursor = cursor;
    if (target.key === previousKey) return;
    if (target.entry) activate(target.entry);
    else if (target.draft) activateVirtual(target.draft);
    else source.onNavigateTab(target.tab.tabId);
  }
  const documentEvents = [["click", onClick], ["dblclick", onDoubleClick], ["input", onDraftInput],
    ["compositionupdate", onDraftInput], ["compositionend", onDraftInput]];
  if (globalThis.document?.addEventListener) documentEvents.forEach(([name, listener]) => document.addEventListener(name, listener, true));
  function onStorage(event) {
    const key = globalThis.PaseoGlobalTabsModel.STORAGE_KEY;
    if (event.key === null || event.key === key || event.key?.startsWith(key + ":shared:")) model.synchronize();
  }
  function onGlobalKey(event) {
    history.onKey(event);
    if (!event.defaultPrevented) onCycleKey(event);
  }
  const windowEvents = [["keydown", onGlobalKey], ["pointerdown", resetCycle], ["blur", resetCycle], ["storage", onStorage]];
  if (globalThis.window?.addEventListener) windowEvents.forEach(([name, listener]) => window.addEventListener(name, listener, true));
  const releaseLayout = typeof layouts.subscribe === "function" ? layouts.subscribe(flushPinIntent) : () => {};
  function activate(entry) {
    navigation.navigateToWorkspace({ serverId: entry.serverId, workspaceId: entry.workspaceId,
      target: { kind: "agent", agentId: entry.agentId }, placement: { mode: "focused" } });
  }
  function activateVirtual(draft) {
    if (draft.target) navigation.navigateToWorkspace({ serverId: draft.serverId, workspaceId: draft.workspaceId,
      target: draft.target, placement: { mode: "focused" } });
    else draftBridge.activate(draft.draftId);
  }
  function activateItem(item, props) {
    if (item.entry) activate(item.entry);
    else if (item.draft) activateVirtual(item.draft);
    else if (item.tab) props.onNavigateTab(item.tab.tabId);
  }
  function closeVirtual(draft, props, preserveGroup=false, preserveDraft=false) {
    if (draft.target) return sourceAction(draft, "onCloseTab", draft.tabId,
      source => closeNative(draft.tabId, source, { draft, preserveGroup }));
    const items = cycleRows(props, true, virtualId(draft.draftId));
    const index = items.findIndex((item) => item.key === virtualId(draft.draftId));
    const replacement = items[index + 1] || items[index - 1];
    if(!preserveGroup)groupModule?.forgetTabGroupKey(virtualId(draft.draftId));
    const active = props.globalDraftContext && bridgeState.activeDraftId === draft.draftId;
    knownDrafts.delete(draft.draftId);
    draftSlots.delete(draft.draftId);
    draftBridge.close(draft.draftId, {preserveDraft});
    if (!active) return;
    if (replacement) activateItem(replacement, props);
    else {
      const selected = navigation.getLastWorkspaceSelection();
      if (selected) navigation.navigateToWorkspace({ ...selected, target: { kind: "new_tab" }, placement: { mode: "focused" } });
      else draftBridge.dismiss?.();
    }
  }
  function sourceAction(entry, name, value, action) {
    const sourceForEntry = () => {
      const registered = [...(sources.get(JSON.stringify([entry.serverId, entry.workspaceId]))?.values() || [])];
      return registered.find(source => source.isFocused !== false) || registered[0];
    };
    const source = sourceForEntry();
    if (source) return action ? action(source) : source[name](value);
    if (entry.target) activateVirtual(entry);
    else activate(entry);
    let attempts = 0;
    const timer = setInterval(() => {
      const source = sourceForEntry();
      if (source || ++attempts >= 30) { clearInterval(timer); timers.delete(timer); }
      if (source) { if (action) action(source); else source[name](value); }
    }, 50);
    timers.add(timer);
  }
  function closeGlobal(entry, props, preserveGroup = false) {
    const ordered = cycleRows(props, true, syntheticId(entry));
    const index = ordered.findIndex((item) => item.key === syntheticId(entry));
    const replacement = ordered[index + 1] || ordered[index - 1];
    if(!preserveGroup)groupModule?.forgetTabGroupKey(syntheticId(entry));
    const current = props.tabs.find((row) => row.isActive && row.tab.target.kind === "agent");
    const isActive = entry.serverId === props.normalizedServerId && entry.workspaceId === props.normalizedWorkspaceId
      && current?.tab.target.agentId === entry.agentId;
    model.close(entry.key);
    if (isActive && replacement) activateItem(replacement, props);
    if (isActive && !replacement) props.onCreateNewTab({ paneId: props.paneId });
  }
  function closeNative(tabId, source, virtual) {
    const key = JSON.stringify([paneKey(source), tabId]);
    if (pendingNativeCloses.has(key)) return;
    const includeKey = virtual ? virtualId(virtual.draft.draftId) : JSON.stringify([paneKey(source), tabId]);
    const items = cycleRows(source, true, includeKey);
    const index = items.findIndex(item => item.tab?.tabId === tabId || item.draft?.tabId === tabId);
    const replacement = items[index + 1] || items[index - 1];
    const active = index >= 0 && activeCycleKey(source, items) === items[index].key;
    pendingNativeCloses.add(key);
    let result;
    try { result = source.onCloseTab(tabId); }
    catch (error) { pendingNativeCloses.delete(key); throw error; }
    const release = () => pendingNativeCloses.delete(key);
    return Promise.resolve(result).then(() => {
      release();
      if (disposed) return;
      const layout = layouts.getState().layoutByWorkspace[source.normalizedServerId + ":" + source.normalizedWorkspaceId];
      const pane = findPane(layout?.root, source.paneId);
      // A canceled confirmation leaves the native tab in place.
      const remaining = pane?.tabs.find(tab => tab.tabId === tabId);
      // The host keeps the last root launcher alive; global tabs can still
      // leave it by selecting their visible neighbor.
      const rootLauncher = remaining?.target.kind === "new_tab" && pane.tabs.length === 1;
      if (!layout || remaining && !rootLauncher) return;
      if (virtual) {
        const id = virtual.draft.draftId;
        if (!virtual.preserveGroup) groupModule?.forgetTabGroupKey(virtualId(id));
        handoffs.delete(id);
        knownDrafts.delete(id);
        draftSlots.delete(id);
        pinnedDrafts.delete(id);
        notifyProjection();
      }
      const selected = currentSelection();
      if (!active || selected?.serverId !== source.normalizedServerId || selected.workspaceId !== source.normalizedWorkspaceId) return;
      if (replacement) activateItem(replacement, source);
      else if (rootLauncher) draftBridge?.dismiss?.();
    }, release);
  }
  function closeCurrentShownTab() {
    const selection = cycleSelection();
    const source = selection && focusedKeyboardSource(selection);
    if (!source) return false;
    const items = cycleRows(source);
    const activeKey = activeCycleKey(source, items);
    const item = items.find((candidate) => candidate.key === activeKey);
    resetCycle();
    if (!item) return true;
    if (item.entry) closeGlobal(item.entry, source);
    else if (item.draft) closeVirtual(item.draft, source);
    else closeNative(item.tab.tabId, source);
    return true;
  }
  presentationModule.WorkspaceTabPresentationResolver = function GlobalTabPresentation(props) {
    React.useSyncExternalStore(metadata.subscribe, metadata.revision, metadata.revision);
    React.useSyncExternalStore(model.subscribe, model.revision, model.revision);
    React.useSyncExternalStore(subscribeProjection, () => projectionRevision, () => projectionRevision);
    const sessionState = sessions((state) => state.sessions);
    const settings = useSettings ? useSettings().settings : null;
    const draft = lookupVirtual(props.tab.tabId);
    if (draft) {
      if (draft.target) return React.createElement(originalPresentation, { ...props, serverId: draft.serverId,
        workspaceId: draft.workspaceId, tab: { ...props.tab, key: draft.tabId, tabId: draft.tabId } });
      if (!draftPresentations.has(props.tab.key)) {
        const history = draft.kind === "history";
        const label = history ? "기록" : "새 워크스페이스";
        const icon = ({ size = 14, color }) => React.createElement("span", { style: { fontSize: size, color } }, history ? "◷" : "+");
        draftPresentations.set(props.tab.key, { key: props.tab.key, kind: "new_tab", label, tooltip: label,
          subtitle: "", modified: false, showCloseButton: true, titleState: "ready", icon, statusBucket: null, isPreview: history ? false : !pinnedDrafts.has(draft.draftId) });
      }
      return props.children(draftPresentations.get(props.tab.key));
    }
    const entry = lookup(props.tab.tabId);
    if (!entry) return React.createElement(originalPresentation, props);
    return React.createElement(originalPresentation, { ...props, serverId: entry.serverId, workspaceId: entry.workspaceId,
      tab: { ...props.tab, key: entry.tabId, tabId: entry.tabId }, children(presentation) {
        let titlePresentation = { ...presentation, isPreview: !entry.pinned };
        if (titleSelectors && settings) {
          const context = { ...entry, defaultLabel: presentation.label };
          const session = sessionState[entry.serverId];
          const sidebarLabel = titleSelectors.selectAgentTabSidebarLabel({ session, context,
            workspaceTitleSource: settings.workspaceTitleSource });
          if (sidebarLabel !== null) {
            const projectLabel = titleSelectors.selectAgentTabProjectLabel({ session, context });
            const label = projectLabel ? projectLabel + "-" + sidebarLabel : sidebarLabel;
            titlePresentation = { ...titlePresentation, label, tooltip: label, titleState: "ready",
              titleLines: projectLabel ? { primaryLabel: projectLabel, secondaryLabel: sidebarLabel,
                ...(presentation.completedAt != null ? { completedAt: presentation.completedAt } : {}) } : undefined };
          }
        }
        if (titlePresentation.titleState === "ready") return props.children(titlePresentation);
        const status = metadata.state(entry);
        const title = (typeof entry.title === "string" && entry.title) || (status.tag === "ready" ? "대화" : status.tag === "missing" ? "대화를 찾을 수 없음"
          : status.tag === "mismatch" ? "대화 소속 확인 필요" : status.tag === "error" ? "대화 정보 확인 실패" : null);
        if (!title) return props.children(titlePresentation);
        return props.children({ ...titlePresentation, label: title, tooltip: title, titleState: "ready" });
      } });
  };
  rowsModule.WorkspaceDesktopTabsRow = function GlobalWorkspaceTabs(props) {
    if (props.host !== "explorer") rendered = true;
    const [hovered, setHovered] = React.useState(null);
    React.useSyncExternalStore(model.subscribe, model.revision, model.revision);
    React.useSyncExternalStore(subscribeProjection, () => projectionRevision, () => projectionRevision);
    if(groupModule) groupModule.useTabGroups(state=>state.state);
    const sessionState = sessions((state) => state.sessions);
    const lastSelection = navigation.useLastWorkspaceSelection();
    const relevant = props.host !== "explorer";
    useKeyboardActionHandler({
      handlerId: "global-workspace-tabs:close:" + paneKey(props),
      actions: ["workspace.tab.close-current"], enabled: relevant, priority: 1000,
      isActive() {
        if (disposed) return false;
        const selection = cycleSelection();
        const source = selection && focusedKeyboardSource(selection);
        return Boolean(source && paneKey(source) === paneKey(props));
      },
      handle: closeCurrentShownTab,
    });
    useKeyboardActionHandler({
      handlerId: "global-workspace-tabs:reopen:" + paneKey(props),
      actions: ["workspace.tab.reopen"], enabled: relevant, priority: 1000,
      isActive: () => !disposed,
      handle: history.restore,
    });
    const activeWorkspace = relevant && !props.globalDraftContext && lastSelection?.serverId === props.normalizedServerId
      && lastSelection?.workspaceId === props.normalizedWorkspaceId && props.isFocused !== false;
    React.useEffect(() => {
      if (!relevant) return;
      if (!props.globalDraftContext) {
        if (!sources.has(liveKey(props))) sources.set(liveKey(props), new Map());
        sources.get(liveKey(props)).set(paneKey(props), props);
      }
      keyboardSources.set(paneKey(props), props);
      model.reconcile(sessionState);
      if (activeWorkspace) model.ingest(props.normalizedServerId, props.normalizedWorkspaceId, props.tabs);
      flushPinIntent();
      return () => {
        if (keyboardSources.get(paneKey(props)) === props) keyboardSources.delete(paneKey(props));
        const registered = sources.get(liveKey(props));
        if (registered?.get(paneKey(props)) === props) registered.delete(paneKey(props));
        if (registered?.size === 0) sources.delete(liveKey(props));
      };
    }, [props, relevant, activeWorkspace, sessionState]);
    if (!relevant) return React.createElement(originalRow, props);
    const globalRows = globalItems(sessionState).map((item) => {
      if (item.draft) {
        const draft = item.draft;
        const target = draft.target || { kind: "new_tab" };
        const active = props.globalDraftContext ? bridgeState.activeDraftId === draft.draftId
          : draft.target && draft.serverId === props.normalizedServerId && draft.workspaceId === props.normalizedWorkspaceId
            && props.tabs.some((row) => row.isActive && row.tab.tabId === draft.tabId);
        return { tab: { key: item.key, tabId: item.key, ...(draft.target?{}:{groupDraft:{draftId:draft.draftId,serverId:draft.serverId,href:draft.href,...(draft.kind?{kind:draft.kind}:{})}}), kind: target.kind, target },
          isActive: Boolean(active), isCloseHovered: hovered === item.key, isClosingTab: false };
      }
      const entry = item.entry;
      const id = syntheticId(entry);
      bySyntheticId.set(id, entry);
      const local = entry.serverId === props.normalizedServerId && entry.workspaceId === props.normalizedWorkspaceId
        ? props.tabs.find((row) => row.tab.target.kind === "agent" && row.tab.target.agentId === entry.agentId) : null;
      return { tab: { key: id, tabId: id, groupSource: {serverId:entry.serverId,workspaceId:entry.workspaceId,tabId:entry.tabId}, kind: "agent", target: { kind: "agent", agentId: entry.agentId } },
        isActive: Boolean(local?.isActive), isCloseHovered: hovered === id, isClosingTab: false };
    });
    const otherRows = props.tabs.filter((row) => row.tab.target.kind !== "agent")
      .filter(row=>!groupModule||groupModule.isTabGroupKeyVisible(row.tab.key))
      .filter((row) => ![...handoffs.values()].some((entry) => entry.serverId === props.normalizedServerId
        && entry.workspaceId === props.normalizedWorkspaceId && entry.tabId === row.tab.tabId));
    const tabs = [...globalRows, ...otherRows];
    const close = (tabId) => {
      const entry = lookup(tabId);
      const draft = lookupVirtual(tabId);
      return entry ? closeGlobal(entry, props) : draft ? closeVirtual(draft, props) : closeNative(tabId, props);
    };
    const actOnAgent = (name, agentId, tab) => {
      const matching = model.entries().filter(item => item.agentId === agentId);
      const entry = tab ? lookup(tab.tabId) : matching.length === 1 ? matching[0] : null;
      if (tab?.tabId.startsWith(prefix) && !entry) return;
      if (!entry && matching.length > 1) return;
      return entry ? sourceAction(entry, name, agentId) : props[name](agentId);
    };
    const closeRange = (tabId, predicate) => {
      const ordered = cycleRows(props, true).map(item => tabs.find(row => row.tab.tabId === (item.tab?.tabId || item.key))).filter(Boolean);
      const index = ordered.findIndex((row) => row.tab.tabId === tabId);
      if (index < 0) return;
      const selected = ordered.filter((row, i) => predicate(i, index));
      selected.filter((row) => !row.isActive).forEach((row) => close(row.tab.tabId));
      selected.filter((row) => row.isActive).forEach((row) => close(row.tab.tabId));
    };
    return React.createElement(originalRow, { ...props, tabs, externalDndContext: false,
      activeDragTabId: null, tabDropPreviewIndex: null,
      setHoveredCloseTabKey(key) {
        setHovered(key);
        props.setHoveredCloseTabKey(key && !lookup(key) ? key : null);
      },
      onNavigateTab(tabId) {
        const entry = lookup(tabId);
        const draft = lookupVirtual(tabId);
        return entry ? activate(entry) : draft ? activateVirtual(draft) : props.onNavigateTab(tabId);
      },
      onCloseGroupedTabs(tabIds, preserveDraft=true) { for(const tabId of tabIds) {const entry=lookup(tabId),draft=lookupVirtual(tabId); if(entry)closeGlobal(entry,props,true);else if(draft)closeVirtual(draft,props,true,preserveDraft);else close(tabId);} },
      onKeepTab(tab) { const entry=lookup(tab.tabId), draft=lookupVirtual(tab.tabId); if(entry)model.pin(entry.key);else if(draft)pinDraft(draft.draftId); },
      onCloseTab: close,
      onCloseTabsToLeft: (id) => closeRange(id, (i, index) => i < index),
      onCloseTabsToRight: (id) => closeRange(id, (i, index) => i > index),
      onCloseOtherTabs: (id) => closeRange(id, (i, index) => i !== index),
      onCopyResumeCommand: (id, tab) => actOnAgent("onCopyResumeCommand", id, tab),
      onCopyAgentId: (id, tab) => actOnAgent("onCopyAgentId", id, tab),
      onReloadAgent: (id, tab) => actOnAgent("onReloadAgent", id, tab),
      onRenameTab(tab) {
        const draft = lookupVirtual(tab.tabId);
        if (draft) return draft.target ? sourceAction(draft, "onRenameTab", { ...tab, key: draft.tabId, tabId: draft.tabId }) : undefined;
        const entry = lookup(tab.tabId);
        if (!entry && tab.tabId.startsWith(prefix)) return;
        return entry ? sourceAction(entry, "onRenameTab", { ...tab, key: entry.tabId, tabId: entry.tabId }) : props.onRenameTab(tab);
      },
      onReorderTabs(next) {
        setDraftOrder(next.map((tab) => tab.tabId));
        model.reorder(next.map((tab) => lookup(tab.tabId)?.key).filter(Boolean));
        const local = next.flatMap((tab) => {
          if (lookupVirtual(tab.tabId)) return [];
          const entry = lookup(tab.tabId);
          if (!entry) return [tab];
          if (entry.serverId !== props.normalizedServerId || entry.workspaceId !== props.normalizedWorkspaceId) return [];
          return [{ ...tab, key: entry.tabId, tabId: entry.tabId }];
        });
        const included = new Set(local.map((tab) => tab.tabId));
        const orderedLocal = [...local, ...props.tabs.map((row) => row.tab).filter((tab) => !included.has(tab.tabId))];
        if (!props.globalDraftContext && orderedLocal.some((tab,index)=>tab.tabId !== props.tabs[index]?.tab.tabId)) props.onReorderTabs(orderedLocal);
      },
    });
  };
  function NewWorkspaceTabsBar() {
    React.useSyncExternalStore(subscribeProjection, () => projectionRevision, () => projectionRevision);
    const draft = bridgeState.entries.find((entry) => entry.draftId === bridgeState.activeDraftId);
    if (!draft) return null;
    const noop = () => {};
    return React.createElement(rowsModule.WorkspaceDesktopTabsRow, {
      globalDraftContext: true, globalDraftId: draft.draftId, host: "main", paneId: "new-workspace",
      normalizedServerId: draft.serverId, normalizedWorkspaceId: "", isFocused: true, ownsKeyboardShortcuts: true,
      tabs: [], focusModeEnabled: false, showPaneSplitActions: false, showPaneMaximizeAction: false,
      setHoveredCloseTabKey: noop, onNavigateTab: noop, onCloseTab: noop, onCopyResumeCommand: noop,
      onCopyAgentId: noop, onCopyTerminalId: noop, onCopyFilePath: noop, onReloadAgent: noop,
      onRenameTab: noop, onCloseTabsToLeft: noop, onCloseTabsToRight: noop, onCloseOtherTabs: noop,
      onCreateNewTab: () => draftBridge.open({ serverId: draft.serverId }), onReorderTabs: noop, onExitFocusMode: noop,
    });
  }
  const releaseBridge = draftBridge ? draftBridge.subscribe(syncBridge) : () => {};
  const initialPreviewDraft = bridgeState.entries.filter(entry => entry.kind !== "history" && !pinnedDrafts.has(entry.draftId)).at(-1);
  if (initialPreviewDraft) replacePreview(initialPreviewDraft.draftId);
  const releaseBar = draftBridge ? draftBridge.registerTabBar(NewWorkspaceTabsBar) : () => {};
  const releasePresence = presenceBridge ? presenceBridge.register({read: model.tabPresence, subscribe: model.subscribe,
    retain: ({serverId, workspaceId, agentId, tabId}) => {
      const entries = model.entries();
      const index = entries.findIndex(entry => entry.serverId === serverId && entry.agentId === agentId);
      model.retainAt(serverId, workspaceId, {tabId, target: {kind: "agent", agentId}}, index < 0 ? entries.length : index);
    }}) : () => {};
  globalThis.__PASEO_GLOBAL_TABS__ = { version: 2, model, pinnedDrafts, dispose() {
    if (disposed) return;
    disposed = true;
    resetCycle();
    pendingNativeCloses.clear();
    releaseBar();
    releaseBridge();
    releasePreview();
    releasePresence();
    releaseStorageStatus();
    releaseGroupModel();
    releaseGroupStore();
    projectionListeners.clear();
    virtualTabs.clear();
    handoffs.clear();
    knownDrafts.clear();
    draftSlots.clear();
    draftPresentations.clear();
    pinIntent = null;
    releaseLayout();
    history.dispose();
    if (globalThis.document?.removeEventListener) documentEvents.forEach(([name, listener]) => document.removeEventListener(name, listener, true));
    if (globalThis.window?.removeEventListener) windowEvents.forEach(([name, listener]) => window.removeEventListener(name, listener, true));
    metadata.dispose();
    rowsModule.WorkspaceDesktopTabsRow = originalRow;
    presentationModule.WorkspaceTabPresentationResolver = originalPresentation;
    timers.forEach(clearInterval);
    sources.clear();
    keyboardSources.clear();
    bySyntheticId.clear();
    delete globalThis.__PASEO_GLOBAL_TABS__;
  } };
  let refreshAttempts = 0;
  const refreshTimer = setInterval(() => {
    if (rendered || ++refreshAttempts > 100) {
      clearInterval(refreshTimer);
      timers.delete(refreshTimer);
      return;
    }
    const selected = navigation.getLastWorkspaceSelection();
    if (!selected) return;
    const key = selected.serverId + ":" + selected.workspaceId;
    const state = layouts.getState();
    const layout = state.layoutByWorkspace[key];
    if (!layout) return;
    // 이미 마운트된 React 컴파일러 캐시가 새 탭 행을 참조하도록 동일 값의 새 객체를 전달한다.
    layouts.setState({ layoutByWorkspace: { ...state.layoutByWorkspace, [key]: structuredClone(layout) } });
  }, 100);
  timers.add(refreshTimer);
  console.info("[global-workspace-tabs] ready");
})();
