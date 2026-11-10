// Settings Sync is also distributed on its own, so plugins/settings-sync/client
// keeps an identical copy of this file. tests/bundle-modules.test.ts holds the
// two in step.
interface ModuleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// Every Suite plugin bundle carries its own copy of this file, and one window
// runs several of them. Both names are the contract between those copies.
const sourcesKey = "__PASEO_SUITE_BUNDLE_SOURCES_1__";
const cachePrefix = "@paseo-suite:bundle-modules:1:";
const releaseDelayMs = 10_000;
const readTimeoutMs = 120_000;

type Timer = ReturnType<typeof setTimeout>;
function background(timer: Timer) {
  (timer as unknown as { unref?(): void }).unref?.();
  return timer;
}

function abortable<T>(source: Promise<T>, signal?: AbortSignal) {
  if (!signal) return source;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void source
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * Reads the app bundle once per window however many plugins ask for it. The
 * signal only ends the caller's wait, because other plugins share the read.
 */
export function readAppBundle(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const runtime = globalThis as typeof globalThis & {
    [sourcesKey]?: Map<string, Promise<string>>;
  };
  const sources = (runtime[sourcesKey] ??= new Map());
  const shared = sources.get(url);
  if (shared) return abortable(shared, signal);
  // A read that never settles would keep every later caller waiting on it.
  const timeout = new AbortController();
  const timer = background(
    setTimeout(
      () => timeout.abort(new Error("현재 앱 번들을 제때 읽지 못했습니다.")),
      readTimeoutMs,
    ),
  );
  const source = (async () => {
    try {
      const response = await fetch(url, { signal: timeout.signal });
      if (!response.ok) throw new Error("현재 앱 번들을 읽을 수 없습니다.");
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  })();
  sources.set(url, source);
  const release = () => {
    if (sources.get(url) === source) sources.delete(url);
  };
  // The text is tens of megabytes, so it only outlives the read long enough
  // for the plugins that start together.
  void source.then(
    () => background(setTimeout(release, releaseDelayMs)),
    release,
  );
  return abortable(source, signal);
}

export function isModuleId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function storage() {
  try {
    return (globalThis as { localStorage?: ModuleStorage }).localStorage;
  } catch {
    return undefined;
  }
}

function update(key: string, value: string | null) {
  try {
    if (value === null) storage()?.removeItem(key);
    else storage()?.setItem(key, value);
  } catch {
    // The IDs are only a cache.
  }
}

function remembered(key: string, bundle: string): unknown {
  let entry: { bundle?: unknown; ids?: unknown } | null = null;
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return undefined;
    entry = JSON.parse(raw);
  } catch {
    // Without readable storage every start resolves from the bundle text.
  }
  if (entry?.bundle === bundle && entry.ids != null) return entry.ids;
  // Another bundle hash owns the slot, or the entry is damaged.
  update(key, null);
  return undefined;
}

export interface ResolvedBundleModules<T> {
  ids: T;
  /** Remembers freshly parsed IDs once the caller has seen the modules behind them. */
  confirm(): void;
}

/**
 * Finds module IDs for the running app bundle. IDs remembered for the same
 * bundle hash skip the bundle read, but only while `accepts` still finds the
 * expected exports behind them.
 */
export async function resolveBundleModules<T>(options: {
  /** Cache slot. Use a new name when the parse rule or the ID shape changes. */
  name: string;
  url: string;
  read(url: string): Promise<string>;
  parse(source: string): T;
  accepts(remembered: unknown): boolean;
}): Promise<ResolvedBundleModules<T>> {
  const key = cachePrefix + options.name;
  const bundle = options.url.split("?")[0].split("/").pop()!;
  const cached = remembered(key, bundle);
  if (cached !== undefined) {
    let accepted = false;
    try {
      accepted = options.accepts(cached);
    } catch {
      // A module that no longer loads is a mismatch like any other.
    }
    if (accepted) return { ids: cached as T, confirm() {} };
    update(key, null);
  }
  const ids = options.parse(await options.read(options.url));
  return {
    ids,
    confirm: () => update(key, JSON.stringify({ bundle, ids })),
  };
}
