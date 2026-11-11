export interface WindowUsage {
  used: number;
  resetsAt: number | null;
}

export interface AccountUsage {
  id: string;
  /** Null when the report has no five-hour window at all: the account has no such limit. */
  fiveHour: WindowUsage | null;
  weekly: WindowUsage;
  /**
   * Weekly limits confined to one model family, keyed by family. A family without an entry has
   * no limit of its own; a null entry is a limit the report named without a usable value.
   */
  models?: Record<string, WindowUsage | null>;
  fetchedAt: number;
  capacity: number;
}

export interface Binding {
  accountId: string;
  switchedAt: number;
}

export const policy = {
  maxAge: 6 * 60_000,
  switchCooldown: 10 * 60_000,
  switchGain: 1.2,
};

const hour = 3_600_000;

function budget(window: WindowUsage, duration: number, now: number) {
  if (!Number.isFinite(window.used) || window.used < 0 || window.used > 100) return null;
  if (window.resetsAt !== null && (!Number.isFinite(window.resetsAt) || window.resetsAt <= now)) return null;
  if (window.resetsAt === null && window.used !== 0) return null;
  const hoursLeft = Math.max(((window.resetsAt ?? now + duration * hour) - now) / hour, 0.25);
  return Math.max(0, 100 - window.used) / hoursLeft;
}

/**
 * The weekly limit of one model family: undefined when the family has none of its own
 * (or the model is unknown), null when the report named it without a usable value.
 */
export function modelUsage(account: AccountUsage, family?: string | null): WindowUsage | null | undefined {
  if (!family || !account.models || !Object.hasOwn(account.models, family)) return undefined;
  return account.models[family];
}

/** Absent limits do not constrain; a limit with an unusable value makes the account unrankable. */
function limitBudget(window: WindowUsage | null | undefined, duration: number, now: number) {
  return window === undefined ? Infinity : window === null ? null : budget(window, duration, now);
}

const higherFirst = (a: number, b: number) => (a === b ? 0 : b - a);

/** `family` is the model family the session will run; without it model limits are not consulted. */
export function rankAccounts(accounts: AccountUsage[], now: number, loads = new Map<string, number>(), family?: string | null) {
  return accounts.flatMap((account) => {
    if (!isCurrentUsage(account, now)) return [];
    const short = limitBudget(account.fiveHour === null ? undefined : account.fiveHour, 5, now);
    const weekly = budget(account.weekly, 168, now);
    const model = limitBudget(modelUsage(account, family), 168, now);
    if (short === null || weekly === null || model === null || short <= 0 || weekly <= 0 || model <= 0) return [];
    const load = loads.get(account.id) ?? 0;
    const score = Math.min(short, weekly, model) * account.capacity / (load + 1);
    return [{ account, score, shortRate: short, weeklyRate: weekly, modelRate: model, load }];
  }).sort((a, b) => higherFirst(a.score, b.score) || higherFirst(a.shortRate, b.shortRate) || a.account.id.localeCompare(b.account.id));
}

export function isCurrentUsage(account: AccountUsage, now: number) {
  return Number.isFinite(account.fetchedAt) && now >= account.fetchedAt && now - account.fetchedAt <= policy.maxAge
    && Number.isFinite(account.capacity) && account.capacity > 0
    && (account.fiveHour === null || budget(account.fiveHour, 5, now) !== null)
    && budget(account.weekly, 168, now) !== null;
}

/** A model limit that is spent excludes the account outright, ahead of keeping the current account. */
export function selectAccount(accounts: AccountUsage[], now: number, loads = new Map<string, number>(), current?: Binding, family?: string | null) {
  const ranked = rankAccounts(accounts, now, loads, family);
  const best = ranked[0];
  if (!best) return null;
  const previous = ranked.find((entry) => entry.account.id === current?.accountId);
  if (previous && current && (now - current.switchedAt < policy.switchCooldown || best.score < previous.score * policy.switchGain)) {
    return previous.account;
  }
  return best.account;
}
