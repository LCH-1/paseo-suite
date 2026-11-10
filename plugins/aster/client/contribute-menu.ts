import { installMenuPresentation } from "./menu";
import { resolveMenuModules } from "./modules";
import { installRuntimeModelPresentation } from "./runtime-model";

interface MenuLease {
  version?: number;
  owners: number;
  ready: Promise<void>;
  failed?: boolean;
  retry?(): void;
  dispose(): void;
}

export function contributeMenu() {
  const runtime = globalThis as typeof globalThis & {
    __r?: (id: number) => any;
    document?: { scripts: ArrayLike<{ src: string }> };
    __PASEO_ASTER_MENU__?: MenuLease;
  };
  if (typeof runtime.__r !== "function" || !runtime.document) return () => {};
  const key = "__PASEO_ASTER_MENU__";
  function releaseOwner(lease: MenuLease) {
    if (--lease.owners === 0) {
      try {
        lease.dispose();
      } finally {
        if (runtime[key] === lease) delete runtime[key];
      }
    }
  }
  const legacy =
    runtime[key] && (runtime[key]?.version ?? 0) < 11
      ? runtime[key]
      : undefined;
  const disposeLegacy = legacy?.dispose.bind(legacy);
  if (legacy) {
    disposeLegacy!();
    if (runtime[key] === legacy) delete runtime[key];
  }
  if (!runtime[key]) {
    let request: AbortController | undefined;
    const requireModule = runtime.__r;
    let restore: (() => void) | undefined;
    const lease: MenuLease = {
      version: 11,
      owners: 0,
      ready: Promise.resolve(),
      retry() {
        if (lease.failed) start();
      },
      dispose() {
        request?.abort();
        const cleanup = restore;
        restore = undefined;
        cleanup?.();
      },
    };
    runtime[key] = lease;
    function start() {
      request?.abort();
      const currentRequest = new AbortController();
      request = currentRequest;
      lease.failed = false;
      let bundleSource = "";
      lease.ready = resolveMenuModules(
        Array.from(runtime.document!.scripts, (script) => script.src),
        async (url) => {
          const response = await runtime.fetch(url, {
            signal: currentRequest.signal,
          });
          if (!response.ok)
            throw new Error("Aster: 현재 앱의 메뉴 모듈을 읽을 수 없습니다.");
          bundleSource = await response.text();
          return bundleSource;
        },
      )
        .then((ids) => {
          if (currentRequest.signal.aborted) return;
          const form = requireModule(ids.form);
          const profiles = requireModule(ids.profiles);
          const registry = requireModule(ids.registry);
          const catalog = requireModule(ids.catalog);
          const profileState = requireModule(ids.profileState);
          const settings = requireModule(ids.settings);
          const browser = requireModule(ids.browser);
          const store = requireModule(ids.sessions)?.useSessionStore;
          if (
            typeof form?.useAgentFormState !== "function" ||
            typeof profiles?.useAgentProfilePicker !== "function" ||
            typeof registry?.pluginRegistry?.getSnapshot !== "function" ||
            typeof catalog?.useAgentProfileFormCatalog !== "function" ||
            typeof profileState?.useAgentProfileFormState !== "function" ||
            typeof settings?.useSessionSettings !== "function" ||
            typeof browser?.useModelBrowser !== "function" ||
            typeof store?.getState !== "function" ||
            typeof store?.setState !== "function" ||
            typeof store?.subscribe !== "function" ||
            typeof registry?.pluginRegistry?.subscribe !== "function"
          ) {
            throw new Error(
              "Aster: 현재 앱의 메뉴 확장 호환성을 확인할 수 없습니다.",
            );
          }
          const menuRestore = installMenuPresentation(
            form,
            profiles,
            registry,
            catalog,
            profileState,
            settings,
            browser,
          );
          restore = menuRestore;
          try {
            const runtimeRestore = installRuntimeModelPresentation(
              store,
              registry.pluginRegistry,
            );
            restore = () => {
              try {
                runtimeRestore();
              } finally {
                menuRestore();
              }
            };
          } catch (error) {
            menuRestore();
            restore = undefined;
            throw error;
          }
        })
        .catch((error: unknown) => {
          if (!currentRequest.signal.aborted) {
            lease.failed = true;
            console.error("[aster] 메뉴 확장을 초기화하지 못했습니다.", error);
          }
        });
    }
    start();
  }
  const lease = runtime[key];
  if (legacy && legacy.owners > 0) {
    lease.owners++;
    let held = true;
    legacy.dispose = () => {
      try {
        disposeLegacy!();
      } finally {
        if (held) {
          held = false;
          releaseOwner(lease);
        }
      }
    };
  }
  lease.retry?.();
  lease.owners++;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    releaseOwner(lease);
  };
}
