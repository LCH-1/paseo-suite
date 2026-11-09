(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PaseoGlobalTabsModel = factory();
})(globalThis, function () {
  "use strict";
  const STORAGE_KEY = "paseo-global-workspace-tabs:v1";
  const SHARED_PREFIX = STORAGE_KEY + ":shared:";
  const isLifecycleKey = (key) =>
    key.startsWith(SHARED_PREFIX + "archive:") ||
    key.startsWith(SHARED_PREFIX + "deleted:");
  const agentKey = (serverId, agentId) => JSON.stringify([serverId, agentId]);
  function keyOf(serverId, workspaceId, tabId) {
    return JSON.stringify([serverId, workspaceId, tabId]);
  }
  function windowStorageKey(key, scope) {
    if (!scope || isLifecycleKey(key)) return key;
    return "paseo-project-window:" + scope.windowId + ":" + key;
  }
  function windowStorage(storage, scope) {
    const prefix = scope ? "paseo-project-window:" + scope.windowId + ":" : "";
    function keys() {
      const result = [];
      if (typeof storage?.key !== "function") return result;
      const length = storage.length;
      for (let index = 0; index < length; index++) {
        const key = storage.key(index);
        if (!scope) result.push(key);
        else if (key?.startsWith(prefix + STORAGE_KEY))
          result.push(key.slice(prefix.length));
        else if (key && isLifecycleKey(key)) result.push(key);
      }
      return result;
    }
    return {
      getItem: (key) => storage.getItem(windowStorageKey(key, scope)),
      setItem: (key, value) =>
        storage.setItem(windowStorageKey(key, scope), value),
      keys,
    };
  }
  function isWindowStorageEvent(key, scope) {
    if (key === null) return true;
    if (isLifecycleKey(key)) return true;
    return key.startsWith(windowStorageKey(STORAGE_KEY, scope));
  }
  function createModel(storage, getSessionMap, scope = null) {
    storage = windowStorage(storage, scope);
    function accepts(serverId, workspaceId, allowUnresolved = false) {
      if (!scope) return true;
      if (scope.serverId !== serverId) return false;
      const workspace =
        getSessionMap?.()?.[serverId]?.workspaces?.get(workspaceId);
      return workspace
        ? workspace.projectId === scope.projectId
        : allowUnresolved;
    }
    let storageFailed = false;
    let saved;
    try {
      saved = JSON.parse(storage.getItem(STORAGE_KEY) || "null");
    } catch {
      saved = null;
      storageFailed = true;
    }
    const valid = (item) =>
      item &&
      typeof item.serverId === "string" &&
      typeof item.workspaceId === "string" &&
      typeof item.tabId === "string" &&
      typeof item.agentId === "string" &&
      accepts(item.serverId, item.workspaceId, true);
    let entries = Array.isArray(saved?.entries)
      ? saved.entries
          .filter(valid)
          .filter((item) => saved.schemaVersion !== 2 || item.pinned === true)
          .map((item) => ({
            ...item,
            pinned: true,
            key: keyOf(item.serverId, item.workspaceId, item.tabId),
          }))
      : [];
    const dismissed = new Set(
      Array.isArray(saved?.dismissed)
        ? saved.dismissed.filter((id) => typeof id === "string")
        : [],
    );
    entries = [
      ...new Map(
        entries.map((item) => [
          keyOf(item.serverId, item.workspaceId, item.tabId),
          item,
        ]),
      ).values(),
    ];
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
      const session = (getSessionMap ? getSessionMap() : observedSessions)?.[
        entry.serverId
      ];
      return [
        session?.agents?.get(entry.agentId),
        session?.agentDetails?.get(entry.agentId),
      ].filter(Boolean);
    }
    function snapshotVersion(snapshot) {
      const value = snapshot.updatedAt;
      const version = value == null ? NaN : Number(new Date(value));
      return Number.isFinite(version) ? version : null;
    }
    const closedAt = new Map(
      Array.isArray(saved?.closedAt)
        ? saved.closedAt.filter(
            (item) =>
              Array.isArray(item) &&
              typeof item[0] === "string" &&
              Number.isFinite(item[1]),
          )
        : [],
    );
    let openAgents = new Set(
      entries.map((entry) => agentKey(entry.serverId, entry.agentId)),
    );
    const known = new Set([...openAgents, ...closedAt.keys()]);
    const pendingWrites = new Map();
    const identity = (entry) => agentKey(entry.serverId, entry.agentId);
    let prunedArchived = false;
    function read(key) {
      try {
        return pendingWrites.has(key)
          ? pendingWrites.get(key)
          : JSON.parse(storage.getItem(key) || "null");
      } catch {
        storageFailed = true;
        return null;
      }
    }
    function write(key, value) {
      try {
        const serialized = JSON.stringify(value);
        if (storage.getItem(key) !== serialized)
          storage.setItem(key, serialized);
        pendingWrites.delete(key);
      } catch {
        storageFailed = true;
        pendingWrites.set(key, value);
      }
    }
    // Keep archive state separate from tab presence so a stale window cannot
    // reopen a conversation another window has archived.
    function archiveState(entry) {
      if (read(SHARED_PREFIX + "deleted:" + identity(entry))?.deleted === true)
        return true;
      const key = SHARED_PREFIX + "archive:" + identity(entry);
      let record = read(key);
      const snapshots = snapshotsFor(entry).filter(
        (snapshot) =>
          (!snapshot.id || snapshot.id === entry.agentId) &&
          Object.hasOwn(snapshot, "archivedAt"),
      );
      const latest = snapshots.reduce((previous, snapshot) => {
        const version = snapshotVersion(snapshot) ?? -Infinity;
        const previousVersion = previous
          ? (snapshotVersion(previous) ?? -Infinity)
          : -Infinity;
        return !previous ||
          version > previousVersion ||
          (version === previousVersion && snapshot.archivedAt)
          ? snapshot
          : previous;
      }, null);
      if (latest) {
        const version = snapshotVersion(latest);
        const archived = Boolean(latest.archivedAt);
        const newer =
          !record ||
          (version !== null &&
            (record.observedAt === null || version > record.observedAt));
        const equalArchive =
          archived && version === record?.observedAt && !record?.archived;
        if ((newer || equalArchive) && (archived || record)) {
          record = { archived, observedAt: version };
          write(key, record);
        }
      }
      return record?.archived === true;
    }
    function removeArchived(next) {
      return next.filter((entry) => {
        if (!archiveState(entry)) return true;
        const key = identity(entry);
        const presenceKey = SHARED_PREFIX + "presence:" + key;
        const presence = read(presenceKey);
        const lastClosedAt =
          Math.max(closedAt.get(key) ?? 0, presence?.lastClosedAt ?? 0) ||
          Date.now();
        closedAt.set(key, lastClosedAt);
        dismissed.add(entry.key);
        if (active === key) dismissedActive = key;
        if (presence?.entry) write(presenceKey, { entry: null, lastClosedAt });
        prunedArchived = true;
        return false;
      });
    }
    function trackedAgents() {
      return [...known].flatMap((key) => {
        let parts;
        try {
          parts = JSON.parse(key);
        } catch {
          return [];
        }
        return Array.isArray(parts) &&
          parts.length === 2 &&
          parts.every((part) => typeof part === "string")
          ? [{ serverId: parts[0], agentId: parts[1] }]
          : [];
      });
    }
    function records() {
      try {
        for (const key of storage.keys()) {
          if (key?.startsWith(SHARED_PREFIX + "presence:"))
            known.add(key.slice((SHARED_PREFIX + "presence:").length));
        }
      } catch {
        storageFailed = true;
      }
      return [...known].map((key) => [
        key,
        read(SHARED_PREFIX + "presence:" + key),
      ]);
    }
    if (!read(SHARED_PREFIX + "initialized")) {
      for (const entry of entries) {
        const key = identity(entry);
        if (!read(SHARED_PREFIX + "presence:" + key))
          write(SHARED_PREFIX + "presence:" + key, {
            entry,
            lastClosedAt: closedAt.get(key) ?? null,
          });
      }
      for (const [key, time] of closedAt) {
        if (!read(SHARED_PREFIX + "presence:" + key))
          write(SHARED_PREFIX + "presence:" + key, {
            entry: null,
            lastClosedAt: time,
          });
      }
      write(
        SHARED_PREFIX + "order",
        entries.filter((entry) => entry.pinned).map(identity),
      );
      write(SHARED_PREFIX + "initialized", true);
    }
    function merge() {
      const local = new Map(entries.map((entry) => [identity(entry), entry]));
      const shared = new Map();
      const found = new Set();
      for (const [key, record] of records()) {
        if (!record) continue;
        found.add(key);
        if (Number.isFinite(record.lastClosedAt))
          closedAt.set(
            key,
            Math.max(closedAt.get(key) ?? 0, record.lastClosedAt),
          );
        if (record.entry && valid(record.entry)) {
          let placement = read(SHARED_PREFIX + "placement:" + key);
          const incomingVersion = Number.isFinite(placement?.observedAt)
            ? placement.observedAt
            : null;
          const adoptedVersion = ownershipVersions.get(key);
          const previousEntry = local.get(key);
          if (
            incomingVersion !== null &&
            adoptedVersion !== undefined &&
            adoptedVersion > incomingVersion &&
            previousEntry
          ) {
            placement = {
              workspaceId: previousEntry.workspaceId,
              tabId: previousEntry.tabId,
              observedAt: adoptedVersion,
            };
            write(SHARED_PREFIX + "placement:" + key, placement);
          }
          const title = read(SHARED_PREFIX + "title:" + key);
          const entry = {
            ...record.entry,
            ...(placement
              ? { workspaceId: placement.workspaceId, tabId: placement.tabId }
              : {}),
            ...(title ? { title } : {}),
            pinned: true,
          };
          entry.key = keyOf(entry.serverId, entry.workspaceId, entry.tabId);
          const observedAt = Number.isFinite(placement?.observedAt)
            ? placement.observedAt
            : null;
          const guard = sharedOwnership.get(key);
          if (
            guard?.workspaceId !== entry.workspaceId ||
            guard.observedAt !== observedAt
          ) {
            sharedOwnership.set(key, {
              workspaceId: entry.workspaceId,
              observedAt,
              blocked: snapshotsFor(entry)
                .filter(
                  (snapshot) => snapshot.workspaceId !== entry.workspaceId,
                )
                .map((snapshot) => ({
                  workspaceId: snapshot.workspaceId,
                  observedAt: snapshotVersion(snapshot),
                })),
            });
          }
          ownership.set(key, entry.workspaceId);
          if (observedAt === null) ownershipVersions.delete(key);
          else {
            ownershipVersions.set(key, observedAt);
            observedVersions.set(
              key,
              Math.max(observedVersions.get(key) ?? -Infinity, observedAt),
            );
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
      const keys = [
        ...new Set([
          ...(Array.isArray(order) ? order : []),
          ...entries.map(identity),
          ...shared.keys(),
        ]),
      ];
      entries = removeArchived(
        keys.flatMap((key) =>
          shared.has(key)
            ? [shared.get(key)]
            : local.has(key) && (!local.get(key).pinned || !found.has(key))
              ? [local.get(key)]
              : [],
        ),
      );
      openAgents = new Set(entries.map(identity));
    }
    merge();
    let previous = entries;
    function persist() {
      write(STORAGE_KEY, {
        schemaVersion: 2,
        entries: entries.filter((entry) => entry.pinned),
        dismissed: [...dismissed],
        closedAt: [...closedAt],
      });
    }
    function notify(
      reordered = false,
      explicitlyClosed = null,
      explicitlyOpened = null,
    ) {
      const nextOpenAgents = new Set(
        entries.map((entry) => agentKey(entry.serverId, entry.agentId)),
      );
      const now = Date.now();
      for (const key of openAgents)
        if (!nextOpenAgents.has(key)) closedAt.set(key, now);
      const before = new Map(previous.map((entry) => [identity(entry), entry]));
      const after = new Map(entries.map((entry) => [identity(entry), entry]));
      for (const [key, entry] of after) {
        known.add(key);
        const old = before.get(key);
        if (entry.pinned && (!old?.pinned || explicitlyOpened === key)) {
          const shared = read(SHARED_PREFIX + "presence:" + key);
          const lastClosedAt =
            Math.max(closedAt.get(key) ?? 0, shared?.lastClosedAt ?? 0) || null;
          if (lastClosedAt !== null) closedAt.set(key, lastClosedAt);
          write(SHARED_PREFIX + "presence:" + key, { entry, lastClosedAt });
        }
        if (
          entry.pinned &&
          (!old || entry.key !== old.key || placementChanges.has(key))
        )
          write(SHARED_PREFIX + "placement:" + key, {
            workspaceId: entry.workspaceId,
            tabId: entry.tabId,
            observedAt: ownershipVersions.get(key) ?? null,
          });
        if (entry.pinned && entry.title && entry.title !== old?.title)
          write(SHARED_PREFIX + "title:" + key, entry.title);
      }
      for (const [key, entry] of before) {
        if (after.has(key)) continue;
        known.add(key);
        const shared = read(SHARED_PREFIX + "presence:" + key);
        if (entry.pinned || explicitlyClosed === key || !shared?.entry)
          write(SHARED_PREFIX + "presence:" + key, {
            entry: null,
            lastClosedAt: closedAt.get(key) ?? now,
          });
      }
      if (reordered) write(SHARED_PREFIX + "order", entries.map(identity));
      placementChanges.clear();
      merge();
      previous = entries;
      revision++;
      persist();
      listeners.forEach((listener) => listener());
    }
    if (saved && (saved.schemaVersion !== 2 || prunedArchived)) persist();
    return {
      entries: () => entries,
      isArchived: (serverId, agentId) => archiveState({ serverId, agentId }),
      tabPresence(serverId, agentId) {
        const key = agentKey(serverId, agentId);
        return {
          isOpen: openAgents.has(key),
          lastClosedAt: closedAt.get(key) ?? null,
        };
      },
      preview: () => entries.find((entry) => !entry.pinned) || null,
      isPinned: (key) =>
        Boolean(entries.find((entry) => entry.key === key)?.pinned),
      pin(key) {
        const entry = entries.find((entry) => entry.key === key);
        if (entry && archiveState(entry)) {
          entries = removeArchived(entries);
          notify();
          return false;
        }
        if (!entry || entry.pinned) return false;
        entries = entries.map((item) =>
          item === entry ? { ...item, pinned: true } : item,
        );
        notify(true);
        return true;
      },
      revision: () => revision,
      storageStatus: () => ({
        state: storageFailed ? "memory-only" : "ready",
        pendingWrites: pendingWrites.size,
        message: storageFailed
          ? "탭 저장소에 접근하지 못했습니다. 현재 창의 탭은 유지하지만 저장과 다른 창의 동기화를 확인할 수 없습니다."
          : null,
      }),
      synchronize() {
        const before = JSON.stringify([entries, [...closedAt]]);
        merge();
        previous = entries;
        if (before === JSON.stringify([entries, [...closedAt]])) return;
        revision++;
        persist();
        listeners.forEach((listener) => listener());
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      retainAt(serverId, workspaceId, tab, index = entries.length) {
        if (!accepts(serverId, workspaceId)) return null;
        if (
          ![serverId, workspaceId, tab?.tabId, tab?.target?.agentId].every(
            (value) => typeof value === "string" && value.length,
          ) ||
          tab.target.kind !== "agent"
        )
          return null;
        const identity = agentKey(serverId, tab.target.agentId);
        if (archiveState({ serverId, agentId: tab.target.agentId })) {
          const next = removeArchived(entries);
          if (next.length !== entries.length) {
            entries = next;
            notify();
          }
          return null;
        }
        const previous = entries.find(
          (entry) => agentKey(entry.serverId, entry.agentId) === identity,
        );
        const key = keyOf(serverId, workspaceId, tab.tabId);
        const entry = {
          ...previous,
          key,
          serverId,
          workspaceId,
          tabId: tab.tabId,
          agentId: tab.target.agentId,
          pinned: true,
        };
        const next = entries.filter(
          (item) => agentKey(item.serverId, item.agentId) !== identity,
        );
        next.splice(
          Math.max(
            0,
            Math.min(
              Number.isFinite(index) ? Math.trunc(index) : next.length,
              next.length,
            ),
          ),
          0,
          entry,
        );
        ownership.set(identity, workspaceId);
        if (previous?.workspaceId !== workspaceId) {
          const versions = snapshotsFor(entry)
            .filter((snapshot) => snapshot.workspaceId === workspaceId)
            .map(snapshotVersion)
            .filter((version) => version !== null);
          if (versions.length) {
            ownershipVersions.set(identity, Math.max(...versions));
            observedVersions.set(
              identity,
              Math.max(
                observedVersions.get(identity) ?? -Infinity,
                ...versions,
              ),
            );
          } else ownershipVersions.delete(identity);
        }
        dismissed.delete(key);
        if (dismissedActive === identity) dismissedActive = null;
        if (
          next.length === entries.length &&
          next.every(
            (item, position) =>
              item.key === entries[position].key &&
              item.pinned === entries[position].pinned,
          ) &&
          read(SHARED_PREFIX + "presence:" + identity)?.entry
        )
          return entries.find((item) => item.key === key);
        entries = next;
        notify(true, null, identity);
        return entry;
      },
      reconcile(sessionMap) {
        observedSessions = sessionMap;
        for (const entry of trackedAgents())
          if (!openAgents.has(identity(entry))) archiveState(entry);
        let changed = false;
        const seen = new Map();
        const next = [];
        for (const entry of entries) {
          if (
            archiveState(entry) ||
            !accepts(entry.serverId, entry.workspaceId, true)
          ) {
            changed = true;
            continue;
          }
          const session = sessionMap?.[entry.serverId];
          const candidates = [
            session?.agents?.get(entry.agentId),
            session?.agentDetails?.get(entry.agentId),
          ];
          const identity = agentKey(entry.serverId, entry.agentId);
          const guard = sharedOwnership.get(identity);
          const watermark = observedVersions.get(identity);
          const usable = candidates.filter((item) => {
            if (
              !item ||
              (item.id && item.id !== entry.agentId) ||
              typeof item.workspaceId !== "string" ||
              !item.workspaceId.length
            )
              return false;
            const version = snapshotVersion(item);
            if (
              watermark !== undefined &&
              (version === null ||
                version < watermark ||
                (version === watermark &&
                  item.workspaceId !== entry.workspaceId))
            )
              return false;
            if (!guard || item.workspaceId === guard.workspaceId) return true;
            if (guard.observedAt !== null)
              return version !== null && version > guard.observedAt;
            return !guard.blocked.some(
              (blocked) =>
                blocked.workspaceId === item.workspaceId &&
                (version === null ||
                  (blocked.observedAt !== null &&
                    version <= blocked.observedAt)),
            );
          });
          const agent = usable.reduce(
            (latest, item) =>
              !latest ||
              (snapshotVersion(item) ?? -Infinity) >
                (snapshotVersion(latest) ?? -Infinity)
                ? item
                : latest,
            null,
          );
          if (agent) {
            ownership.set(identity, agent.workspaceId);
            const observedAt = snapshotVersion(agent);
            if (
              observedAt !== null &&
              (ownershipVersions.get(identity) !== observedAt ||
                agent.workspaceId !== entry.workspaceId)
            ) {
              ownershipVersions.set(identity, observedAt);
              observedVersions.set(
                identity,
                Math.max(
                  observedVersions.get(identity) ?? -Infinity,
                  observedAt,
                ),
              );
              placementChanges.add(identity);
              changed = true;
            }
          }
          const workspaceId = ownership.get(identity);
          if (!workspaceId) {
            next.push(entry);
            continue;
          }
          let updated = entry;
          if (workspaceId !== entry.workspaceId) {
            updated = {
              ...entry,
              workspaceId,
              key: keyOf(entry.serverId, workspaceId, entry.tabId),
            };
            if (dismissed.delete(entry.key)) dismissed.add(updated.key);
            changed = true;
          }
          const previous = seen.get(identity);
          if (previous !== undefined) {
            if (updated.pinned && !next[previous].pinned)
              next[previous] = { ...next[previous], pinned: true };
            changed = true;
            continue;
          }
          seen.set(identity, next.length);
          if (accepts(updated.serverId, updated.workspaceId, true))
            next.push(updated);
          else changed = true;
        }
        if (changed) {
          entries = next;
          notify();
        }
      },
      rememberTitle(serverId, agentId, title) {
        if (typeof title !== "string" || !title.trim()) return;
        let changed = false;
        entries = entries.map((entry) => {
          if (
            entry.serverId !== serverId ||
            entry.agentId !== agentId ||
            entry.title === title
          )
            return entry;
          changed = true;
          return { ...entry, title };
        });
        if (changed) notify();
      },
      ingest(serverId, workspaceId, rows) {
        if (!accepts(serverId, workspaceId)) return;
        const next = removeArchived(entries);
        let changed = next.length !== entries.length;
        entries = next;
        const selected = rows.find(
          (row) =>
            row.isActive &&
            row.tab.target.kind === "agent" &&
            !archiveState({ serverId, agentId: row.tab.target.agentId }),
        );
        if (selected)
          workspaceId =
            ownership.get(agentKey(serverId, selected.tab.target.agentId)) ||
            workspaceId;
        const selectedKey = selected
          ? keyOf(serverId, workspaceId, selected.tab.tabId)
          : null;
        const selectedIdentity = selected
          ? agentKey(serverId, selected.tab.target.agentId)
          : null;
        if (selectedIdentity !== active) {
          active = selectedIdentity;
          dismissedActive = null;
          if (selectedKey && dismissed.delete(selectedKey)) changed = true;
        }
        if (
          selected &&
          selectedIdentity !== dismissedActive &&
          !dismissed.has(selectedKey) &&
          !entries.some(
            (item) =>
              item.serverId === serverId &&
              item.agentId === selected.tab.target.agentId,
          )
        ) {
          const entry = {
            key: selectedKey,
            serverId,
            workspaceId,
            tabId: selected.tab.tabId,
            agentId: selected.tab.target.agentId,
            pinned: false,
          };
          const previewIndex = entries.findIndex((item) => !item.pinned);
          entries =
            previewIndex < 0
              ? [...entries, entry]
              : entries.map((item, index) =>
                  index === previewIndex ? entry : item,
                );
          changed = true;
        }
        if (changed) notify();
      },
      close(key) {
        const entry = entries.find((item) => item.key === key);
        if (entry && agentKey(entry.serverId, entry.agentId) === active)
          dismissedActive = active;
        dismissed.add(key);
        entries = entries.filter((item) => item.key !== key);
        notify(false, entry ? identity(entry) : null);
      },
      forgetAgent(serverId, agentId) {
        const key = agentKey(serverId, agentId);
        write(SHARED_PREFIX + "deleted:" + key, { deleted: true });
        for (const entry of entries.filter((entry) => identity(entry) === key))
          dismissed.add(entry.key);
        if (active === key) dismissedActive = active;
        entries = entries.filter((entry) => identity(entry) !== key);
        notify();
      },
      closeWorkspace(serverId, workspaceId) {
        const closing = entries.filter(
          (entry) =>
            entry.serverId === serverId && entry.workspaceId === workspaceId,
        );
        const affected = new Map(
          closing.map((entry) => [identity(entry), entry]),
        );
        for (const entry of trackedAgents()) {
          if (
            entry.serverId === serverId &&
            (ownership.get(identity(entry)) === workspaceId ||
              snapshotsFor(entry).some(
                (snapshot) => snapshot.workspaceId === workspaceId,
              ))
          )
            affected.set(identity(entry), entry);
        }
        for (const entry of affected.values()) {
          const versions = snapshotsFor(entry)
            .map(snapshotVersion)
            .filter((version) => version !== null);
          write(SHARED_PREFIX + "archive:" + identity(entry), {
            archived: true,
            observedAt: versions.length ? Math.max(...versions) : null,
          });
        }
        if (!closing.length) return;
        for (const entry of closing) {
          dismissed.add(entry.key);
          if (identity(entry) === active) dismissedActive = active;
        }
        entries = entries.filter(
          (entry) =>
            entry.serverId !== serverId || entry.workspaceId !== workspaceId,
        );
        notify();
      },
      reorder(keys) {
        const rank = new Map(keys.map((key, index) => [key, index]));
        entries = [...entries].sort(
          (a, b) =>
            (rank.get(a.key) ?? keys.length) - (rank.get(b.key) ?? keys.length),
        );
        notify(true);
      },
      keyOf,
    };
  }
  return {
    createModel,
    keyOf,
    STORAGE_KEY,
    SHARED_PREFIX,
    windowStorageKey,
    isWindowStorageEvent,
  };
});
