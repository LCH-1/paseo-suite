import { getPaseoClient } from "@getpaseo/plugin/client";
export default function contribute(client) {
  if (typeof document === "undefined" || typeof globalThis.__r !== "function") return () => {};
  const candidates = typeof client?.addAgentTabTitleResolver === "function"
    ? [{"react":37,"rows":5346,"presentation":4893,"navigation":3911,"sessions":3660,"layouts":3810,"snapshots":3851,"hostRoutes":3915,"tabGroups":5353,"keyboardActions":4723,"settings":887,"reopen":5326,"shortcuts":4035,"titles":4861,"registry":3681,"newWorkspaceTabs":4473,"tabPresence":5352},{"react":37,"rows":5346,"presentation":4893,"navigation":3911,"sessions":3660,"layouts":3810,"snapshots":3851,"hostRoutes":3915,"tabGroups":5353,"keyboardActions":4723,"settings":887,"titles":4861,"registry":3681,"newWorkspaceTabs":4473,"tabPresence":5352},{"react":37,"rows":5325,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5332,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5331},{"react":37,"rows":5324,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5331,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5330},{"react":37,"rows":5324,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5331,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5330},{"react":37,"rows":5324,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5331,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5330},{"react":37,"rows":5324,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5331,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5330},{"react":37,"rows":5324,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5331,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5330},{"react":37,"rows":5324,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5331,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5330},{"react":37,"rows":5321,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5328,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5327},{"react":37,"rows":5319,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5326,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5325},{"react":37,"rows":5318,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5325,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5324},{"react":37,"rows":5316,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5323,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5322},{"react":37,"rows":5316,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5323,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5322},{"react":37,"rows":5316,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5453},{"react":37,"rows":5317,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5454},{"react":37,"rows":5315,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5452},{"react":37,"rows":5315,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5452},{"react":37,"rows":5316,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453},{"react":37,"rows":5315,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453},{"react":37,"rows":5316,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453},{"react":37,"rows":5314,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453},{"react":37,"rows":5313,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453},{"react":37,"rows":5312,"presentation":4872,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"keyboardActions":4702,"settings":887,"titles":4840,"registry":3681,"newWorkspaceTabs":4452},{"react":37,"rows":5311,"presentation":4871,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"titles":4839,"registry":3681,"newWorkspaceTabs":4449,"keyboardActions":4701,"settings":887},{"react":37,"rows":5309,"presentation":4869,"navigation":3890,"sessions":3659,"layouts":3790,"snapshots":3831,"hostRoutes":3894,"titles":4837,"registry":3680,"newWorkspaceTabs":4447,"keyboardActions":4699,"settings":887},{"react":37,"rows":5307,"presentation":4696,"navigation":3890,"sessions":3659,"layouts":3790,"snapshots":3831,"hostRoutes":3894,"titles":4978,"registry":3680,"keyboardActions":4541,"settings":887},{"react":37,"rows":5307,"presentation":4696,"navigation":3890,"sessions":3659,"layouts":3790,"snapshots":3831,"hostRoutes":3894,"titles":4978,"registry":3680,"keyboardActions":4541,"settings":887}]
    : [{"react":37,"rows":5324,"presentation":4715,"navigation":3909,"sessions":3659,"layouts":3809,"snapshots":3850,"hostRoutes":3913,"keyboardActions":4559,"settings":887}];
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
  const revision = "7f56fd40ecdcac5eb0834d20896e88497a4af809680fedf3febb6700f544d0b9";
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
  globalThis.PaseoGlobalTabsModel = (function () {
  "use strict";
  const STORAGE_KEY = "paseo-global-workspace-tabs:v1";
  const SHARED_PREFIX = STORAGE_KEY + ":shared:";
  const agentKey = (serverId, agentId) => JSON.stringify([serverId, agentId]);
  function keyOf(serverId, workspaceId, tabId) {
    return JSON.stringify([serverId, workspaceId, tabId]);
  }
  function createModel(storage, getSessionMap) {
    let storageFailed = false;
    let saved;
    try { saved = JSON.parse(storage.getItem(STORAGE_KEY) || "null"); }
    catch { saved = null; storageFailed = true; }
    const valid = (item) => item && typeof item.serverId === "string"
      && typeof item.workspaceId === "string" && typeof item.tabId === "string"
      && typeof item.agentId === "string";
    let entries = Array.isArray(saved?.entries) ? saved.entries.filter(valid)
      .filter((item) => saved.schemaVersion !== 2 || item.pinned === true)
      .map((item) => ({ ...item, pinned: true, key: keyOf(item.serverId, item.workspaceId, item.tabId) })) : [];
    const dismissed = new Set(Array.isArray(saved?.dismissed) ? saved.dismissed.filter((id) => typeof id === "string") : []);
    entries = [...new Map(entries.map((item) => [keyOf(item.serverId, item.workspaceId, item.tabId), item])).values()];
    let active = null;
    let dismissedActive = null;
    let revision = 0;
    const listeners = new Set();
    const ownership = new Map();
    const ownershipVersions = new Map();
    const observedVersions = new Map();
    const placementChanges = new Set();
    const sharedOwnership = new Map();
    let observedSessions = {};
    function snapshotsFor(entry) {
      const session = (getSessionMap ? getSessionMap() : observedSessions)?.[entry.serverId];
      return [session?.agents?.get(entry.agentId), session?.agentDetails?.get(entry.agentId)].filter(Boolean);
    }
    function snapshotVersion(snapshot) {
      const value = snapshot.updatedAt;
      const version = value == null ? NaN : Number(new Date(value));
      return Number.isFinite(version) ? version : null;
    }
    const closedAt = new Map(Array.isArray(saved?.closedAt) ? saved.closedAt.filter(item =>
      Array.isArray(item) && typeof item[0] === "string" && Number.isFinite(item[1])) : []);
    let openAgents = new Set(entries.map(entry => agentKey(entry.serverId, entry.agentId)));
    const known = new Set([...openAgents, ...closedAt.keys()]);
    const pendingWrites = new Map();
    const identity = (entry) => agentKey(entry.serverId, entry.agentId);
    function read(key) {
      try { return pendingWrites.has(key) ? pendingWrites.get(key) : JSON.parse(storage.getItem(key) || "null"); }
      catch { storageFailed = true; return null; }
    }
    function write(key, value) {
      try { storage.setItem(key, JSON.stringify(value)); pendingWrites.delete(key); }
      catch { storageFailed = true; pendingWrites.set(key, value); }
    }
    function records() {
      try {
        if (typeof storage?.key === "function") {
          for (let index = 0; index < storage.length; index++) {
            const key = storage.key(index);
            if (key?.startsWith(SHARED_PREFIX + "presence:")) known.add(key.slice((SHARED_PREFIX + "presence:").length));
          }
        }
      } catch { storageFailed = true; }
      return [...known].map((key) => [key, read(SHARED_PREFIX + "presence:" + key)]);
    }
    if (!read(SHARED_PREFIX + "initialized")) {
      for (const entry of entries) {
        const key = identity(entry);
        if (!read(SHARED_PREFIX + "presence:" + key)) write(SHARED_PREFIX + "presence:" + key,
          { entry, lastClosedAt: closedAt.get(key) ?? null });
      }
      for (const [key, time] of closedAt) {
        if (!read(SHARED_PREFIX + "presence:" + key)) write(SHARED_PREFIX + "presence:" + key,
          { entry: null, lastClosedAt: time });
      }
      write(SHARED_PREFIX + "order", entries.filter(entry => entry.pinned).map(identity));
      write(SHARED_PREFIX + "initialized", true);
    }
    function merge() {
      const local = new Map(entries.map(entry => [identity(entry), entry]));
      const shared = new Map();
      const found = new Set();
      for (const [key, record] of records()) {
        if (!record) continue;
        found.add(key);
        if (Number.isFinite(record.lastClosedAt)) closedAt.set(key, Math.max(closedAt.get(key) ?? 0, record.lastClosedAt));
        if (record.entry && valid(record.entry)) {
          let placement = read(SHARED_PREFIX + "placement:" + key);
          const incomingVersion = Number.isFinite(placement?.observedAt) ? placement.observedAt : null;
          const adoptedVersion = ownershipVersions.get(key);
          const previousEntry = local.get(key);
          if (incomingVersion !== null && adoptedVersion !== undefined && adoptedVersion > incomingVersion && previousEntry) {
            placement = { workspaceId: previousEntry.workspaceId, tabId: previousEntry.tabId, observedAt: adoptedVersion };
            write(SHARED_PREFIX + "placement:" + key, placement);
          }
          const title = read(SHARED_PREFIX + "title:" + key);
          const entry = { ...record.entry,
            ...(placement ? { workspaceId: placement.workspaceId, tabId: placement.tabId } : {}),
            ...(title ? { title } : {}), pinned: true };
          entry.key = keyOf(entry.serverId, entry.workspaceId, entry.tabId);
          const observedAt = Number.isFinite(placement?.observedAt) ? placement.observedAt : null;
          const guard = sharedOwnership.get(key);
          if (guard?.workspaceId !== entry.workspaceId || guard.observedAt !== observedAt) {
            sharedOwnership.set(key, { workspaceId: entry.workspaceId, observedAt,
              blocked: snapshotsFor(entry).filter(snapshot => snapshot.workspaceId !== entry.workspaceId)
                .map(snapshot => ({ workspaceId: snapshot.workspaceId, observedAt: snapshotVersion(snapshot) })) });
          }
          ownership.set(key, entry.workspaceId);
          if (observedAt === null) ownershipVersions.delete(key);
          else {
            ownershipVersions.set(key, observedAt);
            observedVersions.set(key, Math.max(observedVersions.get(key) ?? -Infinity, observedAt));
          }
          shared.set(key, entry);
          dismissed.delete(entry.key);
          if (dismissedActive === key) dismissedActive = null;
        } else if (local.get(key)?.pinned) {
          dismissed.add(local.get(key).key);
          if (active === key) dismissedActive = key;
        }
      }
      const order = read(SHARED_PREFIX + "order");
      const keys = [...new Set([...(Array.isArray(order) ? order : []), ...entries.map(identity), ...shared.keys()])];
      entries = keys.flatMap(key => shared.has(key) ? [shared.get(key)]
        : local.has(key) && (!local.get(key).pinned || !found.has(key)) ? [local.get(key)] : []);
      openAgents = new Set(entries.map(identity));
    }
    merge();
    let previous = entries;
    function persist() {
      try { storage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 2,
        entries: entries.filter((entry) => entry.pinned), dismissed: [...dismissed], closedAt: [...closedAt] })); }
      catch { storageFailed = true; }
    }
    function notify(reordered = false, explicitlyClosed = null, explicitlyOpened = null) {
      const nextOpenAgents = new Set(entries.map(entry => agentKey(entry.serverId, entry.agentId)));
      const now = Date.now();
      for (const key of openAgents) if (!nextOpenAgents.has(key)) closedAt.set(key, now);
      const before = new Map(previous.map(entry => [identity(entry), entry]));
      const after = new Map(entries.map(entry => [identity(entry), entry]));
      for (const [key, entry] of after) {
        known.add(key);
        const old = before.get(key);
        if (entry.pinned && (!old?.pinned || explicitlyOpened === key)) {
          const shared = read(SHARED_PREFIX + "presence:" + key);
          const lastClosedAt = Math.max(closedAt.get(key) ?? 0, shared?.lastClosedAt ?? 0) || null;
          if (lastClosedAt !== null) closedAt.set(key, lastClosedAt);
          write(SHARED_PREFIX + "presence:" + key, { entry, lastClosedAt });
        }
        if (entry.pinned && (!old || entry.key !== old.key || placementChanges.has(key)))
          write(SHARED_PREFIX + "placement:" + key, { workspaceId: entry.workspaceId, tabId: entry.tabId,
            observedAt: ownershipVersions.get(key) ?? null });
        if (entry.pinned && entry.title && entry.title !== old?.title) write(SHARED_PREFIX + "title:" + key, entry.title);
      }
      for (const [key, entry] of before) {
        if (after.has(key)) continue;
        known.add(key);
        const shared = read(SHARED_PREFIX + "presence:" + key);
        if (entry.pinned || explicitlyClosed === key || !shared?.entry) write(SHARED_PREFIX + "presence:" + key,
          { entry: null, lastClosedAt: closedAt.get(key) ?? now });
      }
      if (reordered) write(SHARED_PREFIX + "order", entries.map(identity));
      placementChanges.clear();
      merge();
      previous = entries;
      revision++;
      persist();
      listeners.forEach((listener) => listener());
    }
    if (saved && saved.schemaVersion !== 2) persist();
    return {
      entries: () => entries,
      tabPresence(serverId, agentId) {
        const key = agentKey(serverId, agentId);
        return { isOpen: openAgents.has(key), lastClosedAt: closedAt.get(key) ?? null };
      },
      preview: () => entries.find((entry) => !entry.pinned) || null,
      isPinned: (key) => Boolean(entries.find((entry) => entry.key === key)?.pinned),
      pin(key) {
        const entry = entries.find((entry) => entry.key === key);
        if (!entry || entry.pinned) return false;
        entries = entries.map((item) => item === entry ? { ...item, pinned: true } : item);
        notify(true);
        return true;
      },
      revision: () => revision,
      storageStatus: () => ({ state: storageFailed ? "memory-only" : "ready", pendingWrites: pendingWrites.size,
        message: storageFailed ? "탭 저장소에 접근하지 못했습니다. 현재 창의 탭은 유지하지만 저장과 다른 창의 동기화를 확인할 수 없습니다." : null }),
      synchronize() {
        const before = JSON.stringify([entries, [...closedAt]]);
        merge();
        previous = entries;
        if (before === JSON.stringify([entries, [...closedAt]])) return;
        revision++;
        listeners.forEach((listener) => listener());
      },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      retainAt(serverId, workspaceId, tab, index = entries.length) {
        if (![serverId, workspaceId, tab?.tabId, tab?.target?.agentId].every((value) => typeof value === "string" && value.length)
          || tab.target.kind !== "agent") return null;
        const identity = agentKey(serverId, tab.target.agentId);
        const previous = entries.find((entry) => agentKey(entry.serverId, entry.agentId) === identity);
        const key = keyOf(serverId, workspaceId, tab.tabId);
        const entry = { ...previous, key, serverId, workspaceId, tabId: tab.tabId, agentId: tab.target.agentId, pinned: true };
        const next = entries.filter((item) => agentKey(item.serverId, item.agentId) !== identity);
        next.splice(Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : next.length, next.length)), 0, entry);
        ownership.set(identity, workspaceId);
        if (previous?.workspaceId !== workspaceId) {
          const versions = snapshotsFor(entry).filter(snapshot => snapshot.workspaceId === workspaceId)
            .map(snapshotVersion).filter(version => version !== null);
          if (versions.length) {
            ownershipVersions.set(identity, Math.max(...versions));
            observedVersions.set(identity, Math.max(observedVersions.get(identity) ?? -Infinity, ...versions));
          }
          else ownershipVersions.delete(identity);
        }
        dismissed.delete(key);
        if (dismissedActive === identity) dismissedActive = null;
        if (next.length === entries.length && next.every((item, position) => item.key === entries[position].key
          && item.pinned === entries[position].pinned) && read(SHARED_PREFIX + "presence:" + identity)?.entry)
          return entries.find((item) => item.key === key);
        entries = next;
        notify(true, null, identity);
        return entry;
      },
      reconcile(sessionMap) {
        observedSessions = sessionMap;
        let changed = false;
        const seen = new Map();
        const next = [];
        for (const entry of entries) {
          const session = sessionMap?.[entry.serverId];
          const candidates = [session?.agents?.get(entry.agentId), session?.agentDetails?.get(entry.agentId)];
          const identity = agentKey(entry.serverId, entry.agentId);
          const guard = sharedOwnership.get(identity);
          const watermark = observedVersions.get(identity);
          const usable = candidates.filter((item) => {
            if (!item || item.id && item.id !== entry.agentId || typeof item.workspaceId !== "string" || !item.workspaceId.length) return false;
            const version = snapshotVersion(item);
            if (watermark !== undefined && (version === null || version < watermark
              || version === watermark && item.workspaceId !== entry.workspaceId)) return false;
            if (!guard || item.workspaceId === guard.workspaceId) return true;
            if (guard.observedAt !== null) return version !== null && version > guard.observedAt;
            return !guard.blocked.some(blocked => blocked.workspaceId === item.workspaceId
              && (version === null || blocked.observedAt !== null && version <= blocked.observedAt));
          });
          const agent = usable.reduce((latest, item) => !latest
            || (snapshotVersion(item) ?? -Infinity) > (snapshotVersion(latest) ?? -Infinity) ? item : latest, null);
          if (agent) {
            ownership.set(identity, agent.workspaceId);
            const observedAt = snapshotVersion(agent);
            if (observedAt !== null && (ownershipVersions.get(identity) !== observedAt || agent.workspaceId !== entry.workspaceId)) {
              ownershipVersions.set(identity, observedAt);
              observedVersions.set(identity, Math.max(observedVersions.get(identity) ?? -Infinity, observedAt));
              placementChanges.add(identity);
              changed = true;
            }
          }
          const workspaceId = ownership.get(identity);
          if (!workspaceId) { next.push(entry); continue; }
          let updated = entry;
          if (workspaceId !== entry.workspaceId) {
            updated = { ...entry, workspaceId, key: keyOf(entry.serverId, workspaceId, entry.tabId) };
            if (dismissed.delete(entry.key)) dismissed.add(updated.key);
            changed = true;
          }
          const previous = seen.get(identity);
          if (previous !== undefined) {
            if (updated.pinned && !next[previous].pinned) next[previous] = { ...next[previous], pinned: true };
            changed = true;
            continue;
          }
          seen.set(identity, next.length);
          next.push(updated);
        }
        if (changed) { entries = next; notify(); }
      },
      rememberTitle(serverId, agentId, title) {
        if (typeof title !== "string" || !title.trim()) return;
        let changed = false;
        entries = entries.map((entry) => {
          if (entry.serverId !== serverId || entry.agentId !== agentId || entry.title === title) return entry;
          changed = true;
          return { ...entry, title };
        });
        if (changed) notify();
      },
      ingest(serverId, workspaceId, rows) {
        let changed = false;
        const selected = rows.find((row) => row.isActive && row.tab.target.kind === "agent");
        if (selected) workspaceId = ownership.get(agentKey(serverId, selected.tab.target.agentId)) || workspaceId;
        const selectedKey = selected ? keyOf(serverId, workspaceId, selected.tab.tabId) : null;
        const selectedIdentity = selected ? agentKey(serverId, selected.tab.target.agentId) : null;
        if (selectedIdentity !== active) {
          active = selectedIdentity;
          dismissedActive = null;
          if (selectedKey && dismissed.delete(selectedKey)) changed = true;
        }
        if (selected && selectedIdentity !== dismissedActive && !dismissed.has(selectedKey)
          && !entries.some((item) => item.serverId === serverId && item.agentId === selected.tab.target.agentId)) {
          const entry = { key: selectedKey, serverId, workspaceId, tabId: selected.tab.tabId,
            agentId: selected.tab.target.agentId, pinned: false };
          const previewIndex = entries.findIndex((item) => !item.pinned);
          entries = previewIndex < 0 ? [...entries, entry]
            : entries.map((item, index) => index === previewIndex ? entry : item);
          changed = true;
        }
        if (changed) notify();
      },
      close(key) {
        const entry = entries.find((item) => item.key === key);
        if (entry && agentKey(entry.serverId, entry.agentId) === active) dismissedActive = active;
        dismissed.add(key);
        entries = entries.filter((item) => item.key !== key);
        notify(false, entry ? identity(entry) : null);
      },
      reorder(keys) {
        const rank = new Map(keys.map((key, index) => [key, index]));
        entries = [...entries].sort((a, b) => (rank.get(a.key) ?? keys.length) - (rank.get(b.key) ?? keys.length));
        notify(true);
      },
      keyOf,
    };
  }
  return { createModel, keyOf, STORAGE_KEY, SHARED_PREFIX };
})();
  globalThis.PaseoGlobalTabsMetadata = (function () {
  "use strict";
  const keyOf = (entry) => JSON.stringify([entry.serverId, entry.agentId]);
  function createLoader({ model, sessions, getPaseoClient, normalizeAgentSnapshot }) {
    let stopped = false;
    let queued = false;
    let running = 0;
    let revision = 0;
    const listeners = new Set();
    const attempts = new Map();
    const releases = [];
    function notify() {
      revision++;
      listeners.forEach((listener) => listener());
    }
    function sessionFor(entry) { return sessions.getState().sessions[entry.serverId]; }
    function cached(entry) {
      const session = sessionFor(entry);
      return session?.agents.get(entry.agentId) ?? session?.agentDetails.get(entry.agentId);
    }
    function sameConnection(entry, attempt) {
      const session = sessionFor(entry);
      return session?.client === attempt.client && session?.clientGeneration === attempt.generation;
    }
    function state(entry) {
      const agent = cached(entry);
      if (agent) return { tag: "ready", title: agent.title };
      const attempt = attempts.get(keyOf(entry));
      if (attempt && sameConnection(entry, attempt)) return attempt;
      return { tag: "waiting" };
    }
    function schedule() {
      if (stopped || queued) return;
      queued = true;
      Promise.resolve().then(() => { queued = false; pump(); });
    }
    async function fetch(entry, attempt) {
      try {
        const result = await getPaseoClient(entry.serverId).agents.ref(entry.agentId).refresh();
        if (stopped || !sameConnection(entry, attempt)) return;
        if (!result) {
          attempt.tag = "missing";
          return;
        }
        if (result.agent.id !== entry.agentId) {
          attempt.tag = "mismatch";
          return;
        }
        const agent = { ...normalizeAgentSnapshot(result.agent, entry.serverId), projectPlacement: result.project };
        if (!cached(entry)) {
          sessions.getState().setAgentDetails(entry.serverId, (previous) => {
            if (previous.has(agent.id)) return previous;
            const next = new Map(previous);
            next.set(agent.id, agent);
            return next;
          });
        }
        model.reconcile(sessions.getState().sessions);
        model.rememberTitle(entry.serverId, entry.agentId, cached(entry)?.title ?? agent.title);
        attempt.tag = "ready";
      } catch (error) {
        if (!stopped && sameConnection(entry, attempt)) {
          attempt.tag = "error";
          console.warn("[global-workspace-tabs] Agent metadata lookup failed", entry.serverId, entry.agentId, error);
        }
      } finally {
        running--;
        if (!stopped) { notify(); schedule(); }
      }
    }
    function pump() {
      if (stopped || typeof getPaseoClient !== "function") return;
      model.reconcile(sessions.getState().sessions);
      for (const entry of model.entries()) {
        const agent = cached(entry);
        if (agent) {
          model.rememberTitle(entry.serverId, entry.agentId, agent.title);
          continue;
        }
        const session = sessionFor(entry);
        if (!session?.client || session.client.isConnected === false) continue;
        const existing = attempts.get(keyOf(entry));
        if (existing && sameConnection(entry, existing)) continue;
        if (running >= 4) break;
        const attempt = { tag: "loading", client: session.client, generation: session.clientGeneration };
        attempts.set(keyOf(entry), attempt);
        running++;
        notify();
        void fetch(entry, attempt);
      }
    }
    releases.push(model.subscribe(schedule), sessions.subscribe(schedule));
    schedule();
    return {
      state,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      revision: () => revision,
      dispose() {
        stopped = true;
        releases.forEach((release) => release());
        listeners.clear();
        attempts.clear();
      },
    };
  }
  return { createLoader };
})();
  globalThis.PaseoGlobalTabsHistory = (function () {
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
      model.retainAt(serverId, workspaceId, selected.tab, selected.position);
      reopen({ workspaceKey, createTerminal: terminal });
      navigate({ serverId, workspaceId, target: selected.tab.target, placement: { mode: "focused" } });
      return true;
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
})();
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
  const pinnedDrafts = new Set(bridgeState.entries.map((entry) => entry.draftId));
  let lastCompletion = Math.max(0, ...(bridgeState.completions || []).map((item) => item.sequence));
  bridgeState.entries.forEach((entry) => knownDrafts.set(entry.draftId, entry));
  let rendered = false;
  let disposed = false;
  let pinIntent = null;
  let cycleCursor = null;
  const pendingNativeCloses = new Set();
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
    bridgeState.entries.forEach((entry) => knownDrafts.set(entry.draftId, entry));
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
    const tab = pane?.tabs.find((item) => item.tabId === pane.focusedTabId);
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
        if (!id.startsWith(workspacePrefix) && !id.startsWith(agentPrefix)) continue;
        if (actionInside(element, node)) return;
        pinIntent = { serverId, expires: Date.now() + 2500,
          ...(id.startsWith(workspacePrefix) ? { workspaceId: id.slice(workspacePrefix.length) }
            : { agentId: id.slice(agentPrefix.length) }) };
        flushPinIntent();
        return;
      }
    }
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
    if (!paneNode) return;
    const selection = currentSelection();
    if (selection) pinSelected(selection, paneNode.getAttribute("data-testid").slice("workspace-pane-".length));
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
  function cycleRows(source) {
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
        if (row) result.push(row);
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
  const documentEvents = [["dblclick", onDoubleClick], ["input", onDraftInput],
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
    if(!preserveGroup)groupModule?.forgetTabGroupKey(virtualId(draft.draftId));
    const items = cycleRows(props);
    const index = items.findIndex((item) => item.key === virtualId(draft.draftId));
    const replacement = items[index + 1] || items[index - 1];
    const active = props.globalDraftContext ? bridgeState.activeDraftId === draft.draftId
      : draft.target && draft.serverId === props.normalizedServerId && draft.workspaceId === props.normalizedWorkspaceId
        && props.tabs.some((row) => row.isActive && row.tab.tabId === draft.tabId);
    knownDrafts.delete(draft.draftId);
    draftSlots.delete(draft.draftId);
    if (draft.target) {
      handoffs.delete(draft.draftId);
      notifyProjection();
      sourceAction(draft, "onCloseTab", draft.tabId);
    }
    else draftBridge.close(draft.draftId, {preserveDraft});
    if (!active) return;
    if (replacement) activateItem(replacement, props);
    else {
      const selected = navigation.getLastWorkspaceSelection();
      if (selected) navigation.navigateToWorkspace({ ...selected, target: { kind: "new_tab" }, placement: { mode: "focused" } });
    }
  }
  function sourceAction(entry, name, value) {
    const sourceForEntry = () => {
      const registered = [...(sources.get(JSON.stringify([entry.serverId, entry.workspaceId]))?.values() || [])];
      return registered.find(source => source.isFocused !== false) || registered[0];
    };
    const source = sourceForEntry();
    if (source) return source[name](value);
    if (entry.target) activateVirtual(entry);
    else activate(entry);
    let attempts = 0;
    const timer = setInterval(() => {
      const source = sourceForEntry();
      if (source || ++attempts >= 30) { clearInterval(timer); timers.delete(timer); }
      if (source) source[name](value);
    }, 50);
    timers.add(timer);
  }
  function closeGlobal(entry, props, preserveGroup = false) {
    if(!preserveGroup)groupModule?.forgetTabGroupKey(syntheticId(entry));
    const ordered = cycleRows(props);
    const index = ordered.findIndex((item) => item.key === syntheticId(entry));
    const replacement = ordered[index + 1] || ordered[index - 1];
    const current = props.tabs.find((row) => row.isActive && row.tab.target.kind === "agent");
    const isActive = entry.serverId === props.normalizedServerId && entry.workspaceId === props.normalizedWorkspaceId
      && current?.tab.target.agentId === entry.agentId;
    model.close(entry.key);
    if (isActive && replacement) activateItem(replacement, props);
    if (isActive && !replacement) props.onCreateNewTab({ paneId: props.paneId });
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
    else {
      const key = JSON.stringify([paneKey(source), item.tab.tabId]);
      if (pendingNativeCloses.has(key)) return true;
      pendingNativeCloses.add(key);
      let result;
      try { result = source.onCloseTab(item.tab.tabId); }
      catch (error) { pendingNativeCloses.delete(key); throw error; }
      const release = () => pendingNativeCloses.delete(key);
      Promise.resolve(result).then(release, release);
    }
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
      return entry ? closeGlobal(entry, props) : draft ? closeVirtual(draft, props) : props.onCloseTab(tabId);
    };
    const actOnAgent = (name, agentId, tab) => {
      const matching = model.entries().filter(item => item.agentId === agentId);
      const entry = tab ? lookup(tab.tabId) : matching.length === 1 ? matching[0] : null;
      if (tab?.tabId.startsWith(prefix) && !entry) return;
      if (!entry && matching.length > 1) return;
      return entry ? sourceAction(entry, name, agentId) : props[name](agentId);
    };
    const closeRange = (tabId, predicate) => {
      const index = tabs.findIndex((row) => row.tab.tabId === tabId);
      const selected = tabs.filter((row, i) => predicate(i, index));
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
  const releaseBar = draftBridge ? draftBridge.registerTabBar(NewWorkspaceTabsBar) : () => {};
  const releasePresence = presenceBridge ? presenceBridge.register({read: model.tabPresence, subscribe: model.subscribe,
    retain: ({serverId, workspaceId, agentId, tabId}) => {
      const entries = model.entries();
      const index = entries.findIndex(entry => entry.serverId === serverId && entry.agentId === agentId);
      model.retainAt(serverId, workspaceId, {tabId, target: {kind: "agent", agentId}}, index < 0 ? entries.length : index);
    }}) : () => {};
  globalThis.__PASEO_GLOBAL_TABS__ = { version: 2, model, dispose() {
    if (disposed) return;
    disposed = true;
    resetCycle();
    pendingNativeCloses.clear();
    releaseBar();
    releaseBridge();
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

  const installed = globalThis.__PASEO_GLOBAL_TABS__;
  lease ??= { owners: new Set() };
  lease.controller = installed;
  lease.revision = revision;
  globalThis[leaseKey] = lease;
  return retain(lease);
}
