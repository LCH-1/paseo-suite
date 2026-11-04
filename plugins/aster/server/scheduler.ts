export interface WindowUsage {
  used: number;
  resetsAt: number | null;
}

export interface AccountUsage {
  id: string;
  fiveHour: WindowUsage;
  weekly: WindowUsage;
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

export function rankAccounts(accounts: AccountUsage[], now: number, loads = new Map<string, number>()) {
  return accounts.flatMap((account) => {
    if (!isCurrentUsage(account, now)) return [];
    const short = budget(account.fiveHour, 5, now);
    const weekly = budget(account.weekly, 168, now);
    if (short === null || weekly === null || short <= 0 || weekly <= 0) return [];
    const load = loads.get(account.id) ?? 0;
    const score = Math.min(short, weekly) * account.capacity / (load + 1);
    return [{ account, score, shortRate: short, weeklyRate: weekly, load }];
  }).sort((a, b) => b.score - a.score || b.shortRate - a.shortRate || a.account.id.localeCompare(b.account.id));
}

export function isCurrentUsage(account: AccountUsage, now: number) {
  return Number.isFinite(account.fetchedAt) && now >= account.fetchedAt && now - account.fetchedAt <= policy.maxAge
    && Number.isFinite(account.capacity) && account.capacity > 0
    && budget(account.fiveHour, 5, now) !== null
    && budget(account.weekly, 168, now) !== null;
}

export function selectAccount(accounts: AccountUsage[], now: number, loads = new Map<string, number>(), current?: Binding) {
  const ranked = rankAccounts(accounts, now, loads);
  const best = ranked[0];
  if (!best) return null;
  const previous = ranked.find((entry) => entry.account.id === current?.accountId);
  if (previous && current && (now - current.switchedAt < policy.switchCooldown || best.score < previous.score * policy.switchGain)) {
    return previous.account;
  }
  return best.account;
}
