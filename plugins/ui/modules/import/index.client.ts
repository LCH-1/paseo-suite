import { readAppBundle, resolveBundleModules } from "../../client/bundle-modules";
import { importModulesMatch, installImportPresentation, parseImportPresentationModules } from "./client/import-presentation";

interface ImportLease {
  version?: number;
  owners: Set<symbol>;
  ready: Promise<void>;
  failed: boolean;
  retry(): void;
  dispose(): void;
}

export default function contribute() {
  const runtime = globalThis as typeof globalThis & {
    __r?: (id: number) => any;
    document?: { scripts: ArrayLike<{ src: string }> };
    __PASEO_SESSION_IMPORT__?: ImportLease;
  };
  if (!runtime.document || typeof runtime.__r !== "function") return () => {};
  const key = "__PASEO_SESSION_IMPORT__";
  const legacy = runtime[key] && (runtime[key]?.version ?? 1) < 2 ? runtime[key] : undefined;
  const disposeLegacy = legacy?.dispose.bind(legacy);
  if (legacy) {
    disposeLegacy!();
    if (runtime[key] === legacy) delete runtime[key];
  }
  function releaseIfEmpty(lease: ImportLease) {
    if (lease.owners.size === 0) {
      try { lease.dispose(); }
      finally { if (runtime[key] === lease) delete runtime[key]; }
    }
  }
  if (!runtime[key]) {
    const requireModule = runtime.__r;
    let request: AbortController | undefined;
    let restore: (() => void) | undefined;
    let disposed = false;
    const lease: ImportLease = {
      version: 2, owners: new Set(), ready: Promise.resolve(), failed: false,
      retry() { if (lease.failed) start(); },
      dispose() {
        disposed = true;
        request?.abort();
        restore?.();
        restore = undefined;
      },
    };
    runtime[key] = lease;
    function start() {
      request?.abort();
      const currentRequest = new AbortController();
      request = currentRequest;
      lease.failed = false;
      lease.ready = (async () => {
        const bundles = [...new Set(Array.from(runtime.document!.scripts, script => script.src)
          .filter(src => /\/index-[a-f0-9]+\.js(?:\?.*)?$/.test(src)))];
        if (bundles.length !== 1) throw new Error("Session Import: 앱 번들을 확인할 수 없습니다.");
        const { ids, confirm } = await resolveBundleModules({
          name: "session-import",
          url: bundles[0],
          read: url => readAppBundle(url, currentRequest.signal),
          parse: parseImportPresentationModules,
          accepts: remembered => importModulesMatch(remembered, requireModule),
        });
        if (disposed || currentRequest.signal.aborted) return;
        if (!ids) throw new Error("Session Import: 불러오기 화면이 없습니다.");
        restore = installImportPresentation(ids, requireModule);
        confirm();
      })().catch(error => {
        if (!disposed && !currentRequest.signal.aborted) {
          lease.failed = true;
          console.error("[session-import] 불러오기 확장을 초기화하지 못했습니다.", error);
        }
      });
    }
    start();
  }
  const lease = runtime[key];
  if (legacy && legacy.owners.size > 0) {
    const retainedOwner = Symbol();
    lease.owners.add(retainedOwner);
    legacy.dispose = () => {
      try { disposeLegacy!(); }
      finally { lease.owners.delete(retainedOwner); releaseIfEmpty(lease); }
    };
  }
  lease.retry();
  const owner = Symbol();
  lease.owners.add(owner);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lease.owners.delete(owner);
    releaseIfEmpty(lease);
  };
}
