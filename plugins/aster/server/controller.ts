import { selectAccount, type AccountUsage, type Binding, type WindowUsage } from "./scheduler.ts";

/** What a limit notice says about the block it calls for. */
export interface AccountLimit {
  /** When the limit lifts, if the notice named a time. */
  resetsAt?: number | null;
  /** The model family the limit is confined to; without one it covers the whole account. */
  family?: string | null;
  /** When the turn that hit the limit began. */
  startedAt?: number;
}

interface LimitBlock {
  since: number;
  until: number;
  level: number;
  /** Ends at the time the notice named, rather than after a backoff step. */
  timed: boolean;
}

const hold = 60_000;
const backoff = [5 * 60_000, 15 * 60_000, 60 * 60_000];
const hour = 3_600_000;

export class Controller {
  readonly bindings = new Map<string, Binding>();
  readonly busy = new Set<string>();
  readonly pendingPermission = new Set<string>();
  private reservations = new Map<string, number>();
  private blocked = new Map<string, number>();
  /** Limit blocks per account, keyed by model family ("" covers every model). */
  private limits = new Map<string, Map<string, LimitBlock>>();
  private bootstrapOrder = new Map<string, number>();
  private bootstrapSequence = 0;
  private queue: Promise<unknown> = Promise.resolve();

  serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Blocks only rank accounts: `includeBlocked` is the last resort when nothing else can be chosen. */
  choose(agentId: string, readings: AccountUsage[], now: number, family?: string | null, includeBlocked = false) {
    this.observe(readings);
    const loads = new Map<string, number>();
    for (const [otherId, binding] of this.bindings) {
      if (otherId !== agentId && (this.busy.has(otherId) || (this.reservations.get(otherId) ?? 0) > now)) {
        loads.set(binding.accountId, (loads.get(binding.accountId) ?? 0) + 1);
      }
    }
    return selectAccount(includeBlocked ? readings : readings.filter((reading) => !this.isBlocked(reading.id, now, family)), now, loads, this.bindings.get(agentId));
  }

  bind(agentId: string, accountId: string, now: number) {
    const current = this.bindings.get(agentId);
    if (current?.accountId !== accountId) this.bindings.set(agentId, { accountId, switchedAt: now });
    this.reservations.set(agentId, now + 30_000);
  }

  restore(agentId: string, binding: Binding) {
    if (!this.bindings.has(agentId)) this.bindings.set(agentId, { ...binding });
  }

  /**
   * Without a limit the account only steps aside for a minute. A limit holds until the reset the
   * notice named, or through a growing backoff when it named none. Returns when the block ends.
   */
  limitAccount(accountId: string, now: number, limit?: AccountLimit) {
    if (!limit) {
      this.blocked.set(accountId, now + hold);
      return now + hold;
    }
    const scopes = this.limits.get(accountId) ?? new Map<string, LimitBlock>();
    this.limits.set(accountId, scopes);
    const previous = scopes.get(limit.family ?? "");
    let level = 0;
    // A limit that returns much later starts over. Turns already running when the block began
    // report the same incident; only a turn started afterwards shows the limit came straight back.
    if (previous && now - previous.until < backoff[backoff.length - 1])
      level = limit.startedAt !== undefined && limit.startedAt >= previous.since ? Math.min(previous.level + 1, backoff.length - 1) : previous.level;
    const named = typeof limit.resetsAt === "number" && limit.resetsAt > now;
    // A later notice without a time does not shorten a reset the CLI already named.
    const kept = !named && previous !== undefined && previous.timed && previous.until > now;
    const until = named ? limit.resetsAt! : kept ? previous.until : now + backoff[level];
    scopes.set(limit.family ?? "", { since: now, until, level, timed: named || kept });
    return until;
  }

  /** A block confined to one model family leaves sessions known to run another family alone. */
  isBlocked(accountId: string, now: number, family?: string | null) {
    if ((this.blocked.get(accountId) ?? 0) > now) return true;
    for (const [scope, block] of this.limits.get(accountId) ?? [])
      if (block.until > now && (scope === "" || !family || scope === family)) return true;
    return false;
  }

  /** Whether telling this account's sessions apart by model would change the answer of `isBlocked`. */
  hasModelLimit(accountId: string, now: number) {
    for (const [scope, block] of this.limits.get(accountId) ?? []) if (scope !== "" && block.until > now) return true;
    return false;
  }

  /**
   * A turn that began after the block and ended normally shows the limit has lifted.
   * A limit that already came straight back once is trusted over such a turn, which may
   * have run on a model the limit does not cover.
   */
  succeeded(accountId: string, startedAt: number, now: number, family?: string | null) {
    let released = false;
    for (const [scope, block] of this.limits.get(accountId) ?? [])
      if (block.until > now && block.level === 0 && startedAt >= block.since && (scope === "" || scope === family)) {
        block.until = now;
        released = true;
      }
    return released;
  }

  /** A usage window that began after a backoff block shows the limit behind it has reset. */
  private observe(readings: AccountUsage[]) {
    for (const reading of readings) {
      const block = this.limits.get(reading.id)?.get("");
      if (!block || block.timed || reading.fetchedAt <= block.since) continue;
      const began = (window: WindowUsage, hours: number) => window.resetsAt !== null && window.resetsAt - hours * hour > block.since;
      if (began(reading.fiveHour, 5) || began(reading.weekly, 168)) this.limits.get(reading.id)!.delete("");
    }
  }

  /** Whether bootstrap could pick an account, without advancing its rotation. */
  canBootstrap(accountIds: readonly string[], now: number, includeBlocked = false) {
    return accountIds.some((id) => includeBlocked || !this.isBlocked(id, now));
  }

  bootstrap(agentId: string, accountIds: readonly string[], now: number, includeBlocked = false) {
    const load = (id: string) => [...this.bindings].filter(([otherId, binding]) => otherId !== agentId && binding.accountId === id && (this.busy.has(otherId) || (this.reservations.get(otherId) ?? 0) > now)).length;
    const selected = [...new Set(accountIds)].filter(id => includeBlocked || !this.isBlocked(id, now))
      .sort((a, b) => load(a) - load(b) || (this.bootstrapOrder.get(a) ?? 0) - (this.bootstrapOrder.get(b) ?? 0) || a.localeCompare(b))[0];
    if (!selected) return null;
    this.bootstrapOrder.set(selected, ++this.bootstrapSequence);
    return selected;
  }

  limited(agentId: string, now: number) {
    const binding = this.bindings.get(agentId);
    if (binding) this.limitAccount(binding.accountId, now);
  }

  end(agentId: string) {
    this.busy.delete(agentId);
    this.reservations.delete(agentId);
  }

  close(agentId: string) {
    this.end(agentId);
    this.bindings.delete(agentId);
    this.pendingPermission.delete(agentId);
  }
}
