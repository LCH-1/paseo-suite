import { selectAccount, type AccountUsage, type Binding } from "./scheduler.ts";

export class Controller {
  readonly bindings = new Map<string, Binding>();
  readonly busy = new Set<string>();
  readonly pendingPermission = new Set<string>();
  private reservations = new Map<string, number>();
  private blocked = new Map<string, number>();
  private bootstrapOrder = new Map<string, number>();
  private bootstrapSequence = 0;
  private queue: Promise<unknown> = Promise.resolve();

  serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }

  choose(agentId: string, readings: AccountUsage[], now: number) {
    const loads = new Map<string, number>();
    for (const [otherId, binding] of this.bindings) {
      if (otherId !== agentId && (this.busy.has(otherId) || (this.reservations.get(otherId) ?? 0) > now)) {
        loads.set(binding.accountId, (loads.get(binding.accountId) ?? 0) + 1);
      }
    }
    return selectAccount(readings.filter((reading) => (this.blocked.get(reading.id) ?? 0) <= now), now, loads, this.bindings.get(agentId));
  }

  bind(agentId: string, accountId: string, now: number) {
    const current = this.bindings.get(agentId);
    if (current?.accountId !== accountId) this.bindings.set(agentId, { accountId, switchedAt: now });
    this.reservations.set(agentId, now + 30_000);
  }

  restore(agentId: string, binding: Binding) {
    if (!this.bindings.has(agentId)) this.bindings.set(agentId, { ...binding });
  }

  limitAccount(accountId: string, now: number) {
    this.blocked.set(accountId, now + 60_000);
  }

  /** Whether bootstrap could pick an account, without advancing its rotation. */
  isBlocked(accountId: string, now: number) {
    return (this.blocked.get(accountId) ?? 0) > now;
  }

  canBootstrap(accountIds: readonly string[], now: number) {
    return accountIds.some((id) => (this.blocked.get(id) ?? 0) <= now);
  }

  bootstrap(agentId: string, accountIds: readonly string[], now: number) {
    const load = (id: string) => [...this.bindings].filter(([otherId, binding]) => otherId !== agentId && binding.accountId === id && (this.busy.has(otherId) || (this.reservations.get(otherId) ?? 0) > now)).length;
    const selected = [...new Set(accountIds)].filter(id => (this.blocked.get(id) ?? 0) <= now)
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
