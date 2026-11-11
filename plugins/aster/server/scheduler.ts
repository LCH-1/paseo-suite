export interface WindowUsage {
  used: number;
  resetsAt: number | null;
}

/** A limit beyond the account's five-hour and weekly windows and the per-model weekly ones. */
export interface ExtraLimit {
  /** The model family the limit is confined to; null limits every session on the account. */
  family: string | null;
  /** The length of the limit's window, which a fresh window without a reset time runs for. */
  hours: number;
  /** Null when the report named the limit without a usable value. */
  usage: WindowUsage | null;
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
  /** Limits of other shapes: a model's five-hour limit, or the Claude Code surface's own limits. */
  limits?: ExtraLimit[];
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

/**
 * Every limit a session on `family` runs into, each with the length of its window. The account's
 * own limits always count; a model's only for that model. Without a family no model limit counts.
 */
export function sessionLimits(account: AccountUsage, family?: string | null): ExtraLimit[] {
  const limits: ExtraLimit[] = [];
  if (account.fiveHour) limits.push({ family: null, hours: 5, usage: account.fiveHour });
  limits.push({ family: null, hours: 168, usage: account.weekly });
  const model = modelUsage(account, family);
  if (model !== undefined) limits.push({ family: family!, hours: 168, usage: model });
  for (const limit of account.limits ?? [])
    if (limit.family === null || (!!family && limit.family === family)) limits.push(limit);
  return limits;
}

/** Whether any model's own limit is used up while its reset is still ahead or unknown. */
export function spentModelLimit(account: AccountUsage, now: number) {
  const spent = (window: WindowUsage | null) =>
    window !== null && window.used >= 100 && (window.resetsAt === null || window.resetsAt > now);
  return Object.values(account.models ?? {}).some(spent)
    || (account.limits ?? []).some((limit) => limit.family !== null && spent(limit.usage));
}

/** Absent limits do not constrain; a limit with an unusable value makes the account unrankable. */
function limitBudget(window: WindowUsage | null | undefined, duration: number, now: number) {
  return window === undefined ? Infinity : window === null ? null : budget(window, duration, now);
}

const higherFirst = (a: number, b: number) => (a === b ? 0 : b - a);

/**
 * `family` is the model family the session will run; without it model limits are not consulted.
 * The score is the slowest sustainable rate among the session's limits (remaining share over the
 * hours until its reset), times the account's capacity, shared among the sessions already on it.
 */
export function rankAccounts(accounts: AccountUsage[], now: number, loads = new Map<string, number>(), family?: string | null) {
  const ranked = accounts.flatMap((account) => {
    if (!isCurrentUsage(account, now)) return [];
    const short = limitBudget(account.fiveHour === null ? undefined : account.fiveHour, 5, now);
    const weekly = budget(account.weekly, 168, now);
    const model = limitBudget(modelUsage(account, family), 168, now);
    const extra = (account.limits ?? [])
      .filter((limit) => limit.family === null || (!!family && limit.family === family))
      .map((limit) => limitBudget(limit.usage, limit.hours, now));
    const rates = [short, weekly, model, ...extra];
    if (rates.some((rate) => rate === null || rate <= 0)) return [];
    const load = loads.get(account.id) ?? 0;
    const score = Math.min(...(rates as number[])) * account.capacity / (load + 1);
    return [{ account, score, shortRate: short!, weeklyRate: weekly!, modelRate: model!, load }];
  });
  // More five-hour room breaks a tie only between accounts that all have that limit: an account
  // without one would otherwise always win the tie for lacking it.
  const shortTies = ranked.every((entry) => entry.account.fiveHour !== null);
  ranked.sort((a, b) => higherFirst(a.score, b.score) || (shortTies ? higherFirst(a.shortRate, b.shortRate) : 0) || a.account.id.localeCompare(b.account.id));
  // A session whose model is unknown may well run one whose limit is spent somewhere, so an account
  // with every model limit left goes first when it scores within the margin a switch would need.
  if (!family && ranked[0] && spentModelLimit(ranked[0].account, now)) {
    const best = ranked[0].score;
    const index = ranked.findIndex((entry) => !spentModelLimit(entry.account, now) && entry.score * policy.switchGain >= best);
    if (index > 0) ranked.unshift(...ranked.splice(index, 1));
  }
  return ranked;
}

/** The account's own limits are all usable; model limits are judged per session in `rankAccounts`. */
export function isCurrentUsage(account: AccountUsage, now: number) {
  return Number.isFinite(account.fetchedAt) && now >= account.fetchedAt && now - account.fetchedAt <= policy.maxAge
    && Number.isFinite(account.capacity) && account.capacity > 0
    && (account.fiveHour === null || budget(account.fiveHour, 5, now) !== null)
    && budget(account.weekly, 168, now) !== null
    && (account.limits ?? []).every((limit) => limit.family !== null || (limit.usage !== null && budget(limit.usage, limit.hours, now) !== null));
}

/**
 * A model limit that is spent excludes the account outright, ahead of keeping the current account.
 * `keep: false` drops the hold on the current account and the margin a switch needs.
 */
export function selectAccount(accounts: AccountUsage[], now: number, loads = new Map<string, number>(), current?: Binding, family?: string | null, keep = true) {
  const ranked = rankAccounts(accounts, now, loads, family);
  const best = ranked[0];
  if (!best) return null;
  const previous = ranked.find((entry) => entry.account.id === current?.accountId);
  if (keep && previous && current && (now - current.switchedAt < policy.switchCooldown || best.score < previous.score * policy.switchGain)) {
    return previous.account;
  }
  return best.account;
}
