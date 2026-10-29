export const storageKey = "@paseo:host-order";

export interface Host {
  serverId: string;
  label: string;
}

export interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface HostStore {
  getHosts(): Host[];
  subscribeHostList(listener: () => void): () => void;
  emitHostList(): void;
  reorderHosts?: (serverIds: readonly string[]) => void;
}

export interface Ordering {
  orderHostsLocalFirst(hosts: Host[], localServerId: string | null): Host[];
}

export function parseOrder(value: string | null): string[] | null {
  if (value === null) return null;
  const order: unknown = JSON.parse(value);
  if (
    !Array.isArray(order) ||
    !order.every((id) => typeof id === "string" && id.length > 0) ||
    new Set(order).size !== order.length
  ) {
    throw new Error("저장된 호스트 순서를 읽을 수 없습니다. 기본 순서로 복원하세요.");
  }
  return order;
}

export function projectHosts<T extends Host>(hosts: T[], order: readonly string[] | null): T[] {
  if (!order) return hosts;
  const byId = new Map(hosts.map((host) => [host.serverId, host]));
  const listed = new Set(order);
  const next = order
    .flatMap((id) => {
      const host = byId.get(id);
      return host ? [host] : [];
    })
    .concat(hosts.filter((host) => !listed.has(host.serverId)));
  return next;
}

export function createController(store: HostStore, ordering: Ordering, storage: Storage) {
  const originalGetHosts = store.getHosts;
  const originalOrdering = ordering.orderHostsLocalFirst;
  const originalReorder = store.reorderHosts;
  const listeners = new Set<() => void>();
  let order: string[] | null = null;
  let localServerId: string | null = null;
  let error = "";
  let disposed = false;
  let revision = 0;
  let cachedInput: Host[] | undefined;
  let cachedRevision = -1;
  let cachedOutput: Host[] = [];
  try {
    order = parseOrder(storage.getItem(storageKey));
  } catch {
    error = "저장된 호스트 순서를 읽을 수 없습니다. 기본 순서로 복원하세요.";
  }

  const getHosts = function (this: HostStore) {
    const hosts = originalGetHosts.call(this);
    if (disposed) return hosts;
    if (hosts !== cachedInput || revision !== cachedRevision) {
      cachedInput = hosts;
      cachedRevision = revision;
      cachedOutput = projectHosts(hosts, order);
    }
    return cachedOutput;
  };
  const sortHosts = function (hosts: Host[], localId: string | null) {
    return !disposed && order ? projectHosts(hosts, order) : originalOrdering(hosts, localId);
  };
  store.getHosts = getHosts;
  ordering.orderHostsLocalFirst = sortHosts;

  function displayedHosts() {
    const hosts = store.getHosts();
    return order ? hosts : originalOrdering(hosts, localServerId);
  }
  function readSnapshot() {
    return {
      hosts: displayedHosts().map(({ serverId, label }) => ({ serverId, label })),
      custom: order !== null,
      error,
    };
  }
  let snapshot = readSnapshot();
  function refresh() {
    const next = readSnapshot();
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  }
  const unsubscribe = store.subscribeHostList(refresh);
  function publish() {
    revision++;
    store.emitHostList();
    refresh();
  }
  function change(next: string[] | null) {
    if (disposed) return;
    try {
      if (next === null) storage.removeItem(storageKey);
      else storage.setItem(storageKey, JSON.stringify(next));
    } catch {
      error = "호스트 순서를 저장하지 못했습니다. 다시 시도하세요.";
      refresh();
      return;
    }
    order = next;
    error = "";
    publish();
  }
  function moveTo(serverId: string, targetId: string, position: "before" | "after") {
    const hosts = displayedHosts();
    if (
      serverId === targetId ||
      !hosts.some((host) => host.serverId === serverId) ||
      !hosts.some((host) => host.serverId === targetId)
    )
      return;
    const next = hosts.map((host) => host.serverId).filter((id) => id !== serverId);
    next.splice(next.indexOf(targetId) + (position === "after" ? 1 : 0), 0, serverId);
    if (next.every((id, index) => id === hosts[index].serverId)) return;
    change(next);
  }
  function reorder(serverIds: readonly string[]) {
    const current = displayedHosts().map((host) => host.serverId);
    const known = new Set(current);
    const moved = [...new Set(serverIds)].filter((id) => known.has(id));
    const visible = new Set(moved);
    let index = 0;
    const next = current.map((id) => (visible.has(id) ? moved[index++] : id));
    if (next.every((id, position) => id === current[position])) return;
    change(next);
  }
  if (originalReorder) store.reorderHosts = reorder;
  store.emitHostList();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    moveTo,
    reorder,
    move(serverId: string, direction: -1 | 1) {
      const hosts = displayedHosts();
      const index = hosts.findIndex((host) => host.serverId === serverId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= hosts.length) return;
      moveTo(serverId, hosts[target].serverId, direction === -1 ? "before" : "after");
    },
    reset() {
      change(null);
    },
    setLocalServerId(serverId: string | null) {
      if (disposed || localServerId === serverId) return;
      localServerId = serverId;
      refresh();
    },
    reload() {
      if (disposed) return;
      try {
        order = parseOrder(storage.getItem(storageKey));
        error = "";
      } catch {
        error = "저장된 호스트 순서를 읽을 수 없습니다. 기본 순서로 복원하세요.";
      }
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      if (store.getHosts === getHosts) store.getHosts = originalGetHosts;
      if (ordering.orderHostsLocalFirst === sortHosts)
        ordering.orderHostsLocalFirst = originalOrdering;
      if (store.reorderHosts === reorder) store.reorderHosts = originalReorder;
      store.emitHostList();
      listeners.clear();
    },
  };
}

export type Controller = ReturnType<typeof createController>;
