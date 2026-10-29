import {
  createController,
  storageKey,
  type Controller,
  type HostStore,
  type Ordering,
} from "./controller";
import moduleMaps from "./module-maps";
import type { HostModuleMap } from "./resolve-modules";

interface Lease {
  controller: Controller;
  owners: number;
  stop(): void;
}
const leaseKey = "__PASEO_HOST_ORDER__";

export function acquireController(
  attachSidebar?: (controller: Controller) => () => void,
  resolvedIds?: HostModuleMap,
): {
  controller: Controller | null;
  release(): void;
} {
  const globals = globalThis as typeof globalThis & {
    __r?: (id: number) => unknown;
    [leaseKey]?: Lease;
  };
  const existing = globals[leaseKey];
  let lease = existing;
  if (!lease && typeof document !== "undefined" && typeof globals.__r === "function") {
    const bundles = new Set(
      Array.from(document.scripts, (script) => script.src.split("?")[0].split("/").pop()),
    );
    const ids = resolvedIds ?? moduleMaps.find((entry) => bundles.has(entry.bundle));
    if (ids) {
      const runtime = globals.__r(ids.runtime) as { getHostRuntimeStore?: () => HostStore };
      const ordering = globals.__r(ids.ordering) as Ordering;
      const desktop = globals.__r(ids.desktop) as {
        shouldUseDesktopDaemon(): boolean;
        getDesktopDaemonStatus(): Promise<{ serverId: string }>;
      };
      const store = runtime.getHostRuntimeStore?.();
      if (
        store &&
        typeof store.getHosts === "function" &&
        typeof store.emitHostList === "function" &&
        typeof store.subscribeHostList === "function" &&
        typeof ordering.orderHostsLocalFirst === "function"
      ) {
        const storage = globalThis.localStorage;
        const nativeReorder = typeof store.reorderHosts === "function";
        const controller = createController(store, ordering, storage);
        let detachSidebar: (() => void) | undefined;
        let storageAttached = false;
        const onStorage = (event: StorageEvent) => {
          if (event.storageArea === storage && (event.key === storageKey || event.key === null))
            controller.reload();
        };
        function stop() {
          try {
            detachSidebar?.();
          } finally {
            try { if (storageAttached) globalThis.removeEventListener("storage", onStorage); }
            finally { controller.dispose(); }
          }
        }
        try {
          detachSidebar = nativeReorder ? undefined : attachSidebar?.(controller);
          globalThis.addEventListener("storage", onStorage);
          storageAttached = true;
          const desktopDaemon = desktop.shouldUseDesktopDaemon();
          if (desktopDaemon) {
            void desktop
              .getDesktopDaemonStatus()
              .then((status) => controller.setLocalServerId(status.serverId || null))
              .catch(() => controller.setLocalServerId(null));
          }
          lease = { controller, owners: 0, stop };
          globals[leaseKey] = lease;
        } catch (error) {
          stop();
          throw error;
        }
      }
    }
  }
  if (!lease) return { controller: null, release() {} };
  lease.owners++;
  const current = lease;
  let released = false;
  return {
    controller: current.controller,
    release() {
      if (released) return;
      released = true;
      if (--current.owners === 0) {
        try { current.stop(); }
        finally { if (globals[leaseKey] === current) delete globals[leaseKey]; }
      }
    },
  };
}
