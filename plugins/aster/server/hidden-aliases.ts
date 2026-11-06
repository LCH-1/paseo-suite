import { createLocalPluginConnection, type Connection } from "./legacy-credential-rpc";
import { providerFamily, type ProviderEntries } from "./provider-policy";

/** Account aliases that a picker would show; only the claude and codex roots belong there. */
export function hiddenAliasPatch(providers: ProviderEntries) {
  const patch: Record<string, { selectable: false }> = {};
  for (const [id, entry] of Object.entries(providers)) {
    if (entry.enabled === false || entry.selectable === false) continue;
    const family = providerFamily(id, providers);
    if (id !== family && (family === "claude" || family === "codex"))
      patch[id] = { selectable: false };
  }
  return patch;
}

/**
 * Stock Linux daemons keep \`selectable\` in memory only, so a restart shows aliases again.
 * Plugins load before the daemon accepts connections, so a failed attempt is retried.
 */
export function keepAliasesHidden(
  home: string,
  options: {
    create?: (home: string) => Promise<Pick<Connection, "connect" | "close" | "getDaemonConfig" | "patchDaemonConfig">>;
    retryMs?: number;
    attempts?: number;
  } = {},
) {
  const create = options.create ?? createLocalPluginConnection,
    retryMs = options.retryMs ?? 5000;
  let remaining = options.attempts ?? 24,
    timer: ReturnType<typeof setTimeout> | undefined,
    stopped = false;
  const attempt = async () => {
    const client = await create(home);
    try {
      await client.connect();
      if (stopped) return;
      const { config } = await client.getDaemonConfig();
      const patch = hiddenAliasPatch((config.providers ?? {}) as ProviderEntries);
      if (!stopped && Object.keys(patch).length)
        await client.patchDaemonConfig({ providers: patch } as never);
    } finally {
      client.close();
    }
  };
  const run = () => {
    attempt().catch(() => {
      if (stopped || --remaining <= 0) return;
      timer = setTimeout(run, retryMs);
      timer.unref?.();
    });
  };
  run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
