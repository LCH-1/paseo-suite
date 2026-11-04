export interface CodexWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexReading {
  id: string;
  identity: string;
  at: number;
  plan: string;
  allowed: boolean | null;
  windows: CodexWindow[];
  blocked: boolean;
}

const paidPlans = new Set([
  "go",
  "plus",
  "pro",
  "prolite",
  "promax",
  "team",
  "business",
  "enterprise",
  "edu",
  "self_serve_business_prolite",
  "self_serve_business_usage_based",
  "ent26",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
  "edu_plus",
  "edu_pro",
  "sci",
  "sci_plus",
]);

export function hasCodexSubscription(plan: string): boolean {
  return paidPlans.has(plan.toLowerCase());
}

export function codexBudget(reading: CodexReading, now: number): number | null {
  if (
    !hasCodexSubscription(reading.plan) ||
    reading.blocked ||
    reading.allowed === false
  )
    return null;
  if (now < reading.at || now - reading.at > 360_000 || !reading.windows.length)
    return null;
  const budgets: number[] = [];
  for (const window of reading.windows) {
    if (
      !Number.isFinite(window.usedPercent) ||
      window.usedPercent < 0 ||
      window.usedPercent > 100
    )
      return null;
    if (window.resetsAt !== null && window.resetsAt <= now) return null;
    const remaining = Math.max(0, 100 - window.usedPercent);
    if (!remaining) return null;
    const duration = window.windowDurationMins;
    const hours =
      window.resetsAt === null
        ? duration === null
          ? null
          : duration / 60
        : (window.resetsAt - now) / 3_600_000;
    budgets.push(
      hours === null ? remaining : remaining / Math.max(hours, 0.25),
    );
  }
  return Math.min(...budgets);
}

export function chooseCodexAccount(input: {
  readings: CodexReading[];
  now: number;
  loads: ReadonlyMap<string, number>;
  current?: { identity: string; switchedAt: number };
  capacities?: Record<string, number>;
}): CodexReading | null {
  const unique = new Map<string, CodexReading>();
  for (const reading of input.readings) {
    const previous = unique.get(reading.identity);
    if (
      !previous ||
      reading.at > previous.at ||
      (reading.at === previous.at && reading.blocked)
    )
      unique.set(reading.identity, reading);
  }
  const ranked = [...unique.values()]
    .flatMap((reading) => {
      const budget = codexBudget(reading, input.now);
      if (budget === null) return [];
      const capacity = input.capacities?.[reading.id] ?? 1;
      if (!Number.isFinite(capacity) || capacity <= 0) return [];
      return [
        {
          reading,
          score:
            (budget * capacity) /
            ((input.loads.get(reading.identity) ?? 0) + 1),
        },
      ];
    })
    .sort(
      (a, b) => b.score - a.score || a.reading.id.localeCompare(b.reading.id),
    );
  const best = ranked[0];
  if (!best) return null;
  const current = ranked.find(
    (value) => value.reading.identity === input.current?.identity,
  );
  if (
    current &&
    input.current &&
    (input.now - input.current.switchedAt < 600_000 ||
      best.score < current.score * 1.2)
  )
    return current.reading;
  return best.reading;
}
