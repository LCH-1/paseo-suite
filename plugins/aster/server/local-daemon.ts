import {
  createLocalPluginConnection,
  type Connection,
} from "./legacy-credential-rpc";
import { sharedResult } from "./shared-result";

/**
 * How long the connection stays open with nothing asked of it. Aster asks every few minutes while
 * it is in use, so one connection serves a working stretch and none is left open through a quiet
 * night (an open one answers the client's liveness ping every ten seconds).
 */
const IDLE_MS = 10 * 60_000;

interface Opened {
  client: Promise<Connection>;
  /** The client once `create` has answered, so it can be closed at once. */
  resolved?: Connection;
  /** Calls running on it. */
  users: number;
  /** Whether a call has connected through it: a kept connection, not a new one. */
  connected: boolean;
  closed: boolean;
}

/** The connection went away before the daemon answered: the question got no answer at all. */
export function connectionLost(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "DAEMON_CONNECTION_LOST"
  );
}

function shut(opened: Opened) {
  if (opened.closed) return;
  opened.closed = true;
  const close = (client: Connection) => {
    try {
      void Promise.resolve(client.close() as unknown).catch(() => undefined);
    } catch {
      // A client that cannot close has nothing left to release.
    }
  };
  if (opened.resolved) close(opened.resolved);
  else void opened.client.then(close, () => undefined);
}

/**
 * One connection to the local daemon, opened when first asked and kept for the calls after it.
 * Each usage read and subscription check used to open its own socket for a single request, and
 * every one of them cost the daemon a session and two log lines.
 */
export class LocalDaemon {
  private opened: Opened | null = null;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private readonly lifetime = new AbortController();

  constructor(
    private readonly home: string,
    private readonly create: (
      home: string,
    ) => Promise<Connection> = createLocalPluginConnection,
    private readonly idleMs = IDLE_MS,
  ) {}

  /**
   * Runs `task` on the kept connection. A connection the daemon dropped is connected again, and
   * one that cannot be reached any more (the daemon restarted elsewhere) is replaced by one from
   * the address the daemon publishes now. A question the connection lost on the way is asked once
   * more on a new one; an answer the daemon gave, a refusal included, is final. A caller that stops
   * waiting (`signal`, `timeoutMs`) leaves the connection and its other calls alone.
   */
  async use<T>(
    task: (client: Connection) => Promise<T>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const signal = AbortSignal.any([
      this.lifetime.signal,
      ...(options.signal ? [options.signal] : []),
      ...(options.timeoutMs === undefined
        ? []
        : [AbortSignal.timeout(options.timeoutMs)]),
    ]);
    signal.throwIfAborted();
    const run = this.run(task, signal);
    run.catch(() => undefined);
    return sharedResult(run, signal);
  }

  /** Closes the connection; nothing is asked or opened through this one again. */
  close() {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(Error("Aster 데몬 연결이 해제되었습니다."));
    clearTimeout(this.idle);
    const opened = this.opened;
    this.opened = null;
    if (opened) shut(opened);
  }

  private async run<T>(
    task: (client: Connection) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const opened = this.open();
      const kept = opened.connected;
      let asked = false;
      try {
        const client = await opened.client;
        opened.resolved = client;
        // Connected already: an instant answer. Dropped while idle: the same client connects again.
        await sharedResult(client.connect(), this.lifetime.signal);
        opened.connected = true;
        asked = true;
        const result = await task(client);
        this.release(opened, false);
        return result;
      } catch (error) {
        const gone = !asked || connectionLost(error);
        this.release(opened, gone);
        // Once: a kept connection may only be stale, and a lost question never reached an answer.
        // A new connection that cannot connect means the daemon is not there right now.
        if (attempt > 0 || signal.aborted || !(asked ? gone : kept))
          throw error;
      }
    }
  }

  private open() {
    clearTimeout(this.idle);
    this.idle = undefined;
    if (!this.opened) {
      const client = this.create(this.home);
      client.catch(() => undefined);
      this.opened = { client, users: 0, connected: false, closed: false };
    }
    this.opened.users++;
    return this.opened;
  }

  /** A call is done with `opened`; `discard` keeps the next calls off a connection that failed. */
  private release(opened: Opened, discard: boolean) {
    opened.users--;
    if (discard && this.opened === opened) this.opened = null;
    if (opened.users > 0) return;
    if (this.opened !== opened) return shut(opened);
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (this.opened !== opened || opened.users > 0) return;
      this.opened = null;
      shut(opened);
    }, this.idleMs);
    this.idle.unref?.();
  }
}

const shared = new Map<string, LocalDaemon>();
let stopped = false;

/** The one connection this process keeps to the daemon at `home`, opened when first asked. */
export function localDaemon(home: string) {
  let daemon = shared.get(home);
  if (!daemon) {
    daemon = new LocalDaemon(home);
    if (stopped) daemon.close();
    shared.set(home, daemon);
  }
  return daemon;
}

/** The plugin stops: every kept connection closes, and none opens again in this process. */
export function closeLocalDaemons() {
  stopped = true;
  for (const daemon of shared.values()) daemon.close();
}
