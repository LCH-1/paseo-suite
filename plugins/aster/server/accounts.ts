import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, normalize, win32, posix } from "node:path";
import { z } from "zod";
import {
  commandSchema,
  defaultCommand,
  portableCommand,
  type Command,
} from "./paseo.ts";
import {
  isCurrentUsage,
  policy,
  type AccountUsage,
  type ExtraLimit,
  type WindowUsage,
} from "./scheduler.ts";
import { hostUsageReader } from "./host-usage";
import { sharedResult } from "./shared-result";

export const paseoHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
export const stateDirectory = join(paseoHome, "aster");
const readHostUsage = hostUsageReader(paseoHome);
const registrySchema = z.object({
  accounts: z.array(
    z.object({
      id: z.string(),
      base: z.string(),
      home: z.string().nullable(),
      signedIn: z.boolean(),
      email: z.string().nullable(),
      identity: z.string().nullable(),
    }),
  ),
});
const windowSchema = z.object({
  id: z.string(),
  // Display only: a label of another shape must not cost the report.
  label: z.string().optional().catch(undefined),
  // The host passes the provider's utilization through; anything past the limit is a spent limit.
  usedPct: z
    .number()
    .min(0)
    .transform((used) => Math.min(used, 100))
    .nullable(),
  resetsAt: z.string().nullable(),
});
const reportSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  account: z.object({ label: z.string().optional() }),
  fetchedAt: z.string(),
  successfulAt: z.string().optional(),
  report: z.object({
    status: z.string(),
    error: z.string().optional(),
    planLabel: z.string().optional(),
    windows: z.array(windowSchema).optional(),
    problem: z
      .object({ kind: z.string(), expiresAt: z.string().optional() })
      .optional(),
  }),
});
export const reportsSchema = z.array(reportSchema);
type UsageWindow = z.infer<typeof windowSchema>;
type Report = z.infer<typeof reportSchema>;

export type LimitPeriod = "five_hour" | "weekly";
const periodHours: Record<LimitPeriod, number> = { five_hour: 5, weekly: 168 };

/**
 * Paseo starts every Claude session through Claude Code, so a limit on the Claude Code surface
 * (`Code` in the host's usage source) limits each of them like the account's own windows.
 */
const claudeCodeSurface = /^(?:claude[-_]?)?code(?:_\d+)?$/;

/**
 * What a usage window limits: `period` is its length, `family` the model family it is confined to
 * (null for the whole account). The account's `five_hour` and `weekly` windows, and windows named
 * `<period>_model_<family>` or `<period>_surface_<surface>`. Null for a window that limits no
 * Paseo session in a way Aster can tell: another surface, or a model it cannot tie to a family.
 */
export function windowLimit(
  id: string,
): { period: LimitPeriod; family: string | null } | null {
  if (id === "five_hour" || id === "weekly")
    return { period: id, family: null };
  const match = /^(five_hour|weekly)_(model|surface)_(.+)$/.exec(
    id.toLowerCase(),
  );
  if (!match) return null;
  const period = match[1] as LimitPeriod;
  if (match[2] === "surface")
    return claudeCodeSurface.test(match[3]) ? { period, family: null } : null;
  // A bare family name, optionally after `claude-` and before a version.
  const family = /^(?:claude[-_])?([a-z]+)(?:[-_]\d[\w.-]*)?$/.exec(
    match[3],
  )?.[1];
  return family ? { period, family } : null;
}

/** The model family a model window is confined to, or null for any other window. */
export function windowFamily(id: string) {
  return windowLimit(id)?.family ?? null;
}

/** The name of a surface other than Claude Code that a window limits, for display only. */
function otherSurface(window: UsageWindow) {
  const match = /^(?:five_hour|weekly)_surface_(.+)$/.exec(
    window.id.toLowerCase(),
  );
  if (!match || claudeCodeSurface.test(match[1])) return null;
  const label = window.label?.split("\u00b7").pop()?.trim();
  return label || match[1].charAt(0).toUpperCase() + match[1].slice(1);
}

/**
 * Whether a window limits a session on `family`: the account's own limits always do, a model's
 * limit only for that model. Without a family the model limits are left out.
 */
function limitsSession(id: string, family?: string | null) {
  const limit = windowLimit(id);
  return (
    limit !== null &&
    (limit.family === null || (!!family && limit.family === family))
  );
}

function windowUsage(window: UsageWindow): WindowUsage | null {
  return window.usedPct === null
    ? null
    : {
        used: window.usedPct,
        resetsAt: window.resetsAt === null ? null : Date.parse(window.resetsAt),
      };
}

/** A limit named twice keeps its unknown value, otherwise its more used one. */
function tighter(
  previous: WindowUsage | null | undefined,
  usage: WindowUsage | null,
) {
  return previous === undefined
    ? usage
    : previous === null || usage === null
      ? null
      : previous.used >= usage.used
        ? previous
        : usage;
}

/** The limits beyond the account's five-hour and weekly windows, by model family and period. */
function scopedLimits(windows: UsageWindow[]) {
  const models: Record<string, WindowUsage | null> = {};
  const limits = new Map<string, ExtraLimit>();
  for (const window of windows) {
    const limit = windowLimit(window.id);
    if (!limit || window.id === "five_hour" || window.id === "weekly") continue;
    const usage = windowUsage(window);
    if (limit.family !== null && limit.period === "weekly") {
      const family = limit.family;
      models[family] = tighter(
        Object.hasOwn(models, family) ? models[family] : undefined,
        usage,
      );
      continue;
    }
    const key = `${limit.period}:${limit.family ?? ""}`;
    limits.set(key, {
      family: limit.family,
      hours: periodHours[limit.period],
      usage: tighter(limits.get(key)?.usage, usage),
    });
  }
  return { models, limits: [...limits.values()] };
}

const fetchedAt = (entry: Report) => {
  const at = Date.parse(entry.fetchedAt);
  return Number.isFinite(at) ? at : -Infinity;
};

/**
 * One account's windows across its reports. The windows of `base`, the newest reports, stand as
 * they are, so a newer value always wins and an early reset shows. A window they leave out or name
 * without a value takes the newest value another report has for it: one source's sparse answer
 * must not hide a limit another source confirmed. The five-hour window is the exception: newer
 * reports that name the weekly window but not that one say the account no longer has the limit.
 * `fill` narrows which windows other reports may complete.
 */
function mergeWindows(
  base: Report[],
  others: Report[],
  fill: (id: string) => boolean = () => true,
) {
  const windows = new Map<string, UsageWindow>();
  for (const entry of base)
    for (const window of entry.report.windows ?? []) {
      const previous = windows.get(window.id);
      if (
        previous === undefined ||
        previous.usedPct === null ||
        (window.usedPct !== null && window.usedPct > previous.usedPct)
      )
        windows.set(window.id, window);
    }
  const lifted = windows.has("weekly") && !windows.has("five_hour");
  for (const entry of [...others].sort((a, b) => fetchedAt(b) - fetchedAt(a)))
    for (const window of entry.report.windows ?? []) {
      if (
        window.usedPct === null ||
        !fill(window.id) ||
        (lifted && window.id === "five_hour")
      )
        continue;
      const current = windows.get(window.id);
      if (current === undefined || current.usedPct === null)
        windows.set(window.id, window);
    }
  return [...windows.values()];
}

export const settingsSchema = z.object({
  command: commandSchema.default(defaultCommand),
  capacities: z.record(z.string(), z.number().positive()).default({}),
  profileUsageFallback: z.boolean().optional(),
  continueAfterLimitSwitch: z.boolean().optional(),
});

/** One malformed report, often from another provider's source, must not hide every other account. */
export function parseReports(value: unknown): z.infer<typeof reportsSchema> {
  const entries = z.array(z.unknown()).parse(value);
  const reports = entries.flatMap((entry) => {
    const parsed = reportSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  if (reports.length < entries.length)
    console.warn(
      `[aster] 형식이 맞지 않는 사용량 보고서 ${entries.length - reports.length}건을 제외하고 ${reports.length}건을 사용`,
    );
  return reports;
}

export interface Account {
  id: string;
  home: string;
  email: string | null;
  identity: string | null;
}

export async function readSettings(
  file = join(stateDirectory, "settings.json"),
) {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    raw = "{}";
  }
  const settings = settingsSchema.parse(JSON.parse(raw));
  return { ...settings, command: portableCommand(settings.command) };
}

export function accountSecureDirectory(
  account: Pick<Account, "home">,
  platform = process.platform,
  userHome = homedir(),
) {
  const paths = platform === "win32" ? win32 : posix;
  const normalized = (value: string) => {
    const resolved = paths.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalized(account.home) ===
    normalized(paths.join(userHome, ".claude"))
    ? ""
    : account.home;
}

export async function discoverAccounts() {
  let raw: string;
  try {
    raw = await readFile(
      join(paseoHome, "paseo-accounts", "accounts.json"),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const registry = registrySchema.parse(JSON.parse(raw));
  if (
    !registry.accounts.some(
      (account) => account.base === "claude" && account.signedIn,
    )
  )
    return [];
  const defaultHome = join(homedir(), ".claude");
  const sharedProjects = normalize(
    await realpath(join(defaultHome, "projects")),
  );
  const accounts: Account[] = [];
  for (const entry of registry.accounts.filter(
    (account) => account.base === "claude" && account.signedIn,
  )) {
    const home = entry.home ?? defaultHome;
    const projects = await realpath(join(home, "projects")).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      },
    );
    if (projects === null || normalize(projects) !== sharedProjects) {
      console.warn(
        `[aster] account ${entry.id}: 대화 기록이 공유되지 않아 제외`,
      );
      continue;
    }
    accounts.push({
      id: entry.id,
      home,
      email: entry.email,
      identity: entry.identity,
    });
  }
  return accounts;
}

function matchingReports(
  account: Account,
  reports: z.infer<typeof reportsSchema>,
) {
  const candidates = reports.filter(
    (entry) =>
      ["claude", "claude-windows", "claude-profiles"].includes(
        entry.sourceId,
      ) &&
      account.email !== null &&
      entry.account.label?.toLowerCase() === account.email.toLowerCase(),
  );
  const organization = account.identity?.split("|")[0],
    identities = new Set(
      candidates.map((entry) => entry.id.slice(entry.id.indexOf(":") + 1)),
    );
  const matching = organization
    ? candidates.filter((entry) => entry.id.endsWith(`.${organization}`))
    : identities.size === 1
      ? candidates
      : [];
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const service = `Claude Code-credentials${accountSecureDirectory(account) === "" ? "" : "-" + hash(account.home.normalize("NFC")).slice(0, 8)}`;
  const routes = [
    hash(JSON.stringify({ store: "windows-credman", service })),
    hash(
      JSON.stringify({
        store: "claude",
        path: join(account.home, ".credentials.json"),
      }),
    ),
  ];
  return [
    ...matching,
    ...reports.filter(
      (entry) =>
        ["claude", "claude-windows", "claude-profiles"].includes(
          entry.sourceId,
        ) &&
        entry.account.label === undefined &&
        routes.includes(entry.id.slice(entry.id.indexOf(":") + 1)),
    ),
  ];
}
/**
 * A root Claude session with no recorded account would reopen on the main login,
 * which may be gone, so it has nothing worth preserving.
 */
export function hasPreviousAccount(
  request: { provider: string; env: Record<string, string | undefined> },
  bound: boolean,
) {
  return (
    bound || !!request.env.ASTER_ACCOUNT_ID || request.provider !== "claude"
  );
}
/** No usable login, as opposed to an ended subscription or a usage API failure. */
export function needsLogin(
  account: Account,
  reports: z.infer<typeof reportsSchema>,
) {
  const matching = matchingReports(account, reports);
  if (matching.some((entry) => entry.report.status === "available"))
    return false;
  return (
    matching.length === 0 ||
    matching.some(
      ({ report }) =>
        (report.status === "unavailable" &&
          ["expired", "rejected", "missing"].includes(
            report.problem?.kind ?? "",
          )) ||
        (report.status === "error" && /login store/i.test(report.error ?? "")),
    )
  );
}
function deniesUsage(report: z.infer<typeof reportsSchema>[number]) {
  return (
    /^free\b/i.test(report.report.planLabel ?? "") ||
    (report.report.status === "unavailable" &&
      [
        "expired",
        "rejected",
        "missing",
        "subscription_required",
        "subscription_inactive",
        "subscription_expired",
        "billing_error",
      ].includes(report.report.problem?.kind ?? ""))
  );
}

export function mapReports(
  accounts: Account[],
  reports: z.infer<typeof reportsSchema>,
  capacities: Record<string, number>,
  now = Date.now(),
): AccountUsage[] {
  const seenReports = new Set<string>();
  return accounts.flatMap((account) => {
    const matching = matchingReports(account, reports);
    const answers = matching.filter(
      (report) => report.report.status === "available" && !deniesUsage(report),
    );
    const current = answers.filter(
      (report) =>
        fetchedAt(report) <= now && now - fetchedAt(report) <= policy.maxAge,
    );
    // A model's or a surface's limit takes its newest value among the account's current reports,
    // as `accountWindows` shows it: the older complete report a score comes from must not outvote
    // a newer partial one that shows the limit spent, or reset early.
    const latestAt = Math.max(...current.map(fetchedAt));
    const scopedWindows = mergeWindows(
      current.filter((report) => fetchedAt(report) === latestAt),
      current.filter((report) => fetchedAt(report) !== latestAt),
      (id) => id !== "five_hour" && id !== "weekly",
    );
    const usable = answers
      .flatMap((report) => {
        const windows = report.report.windows ?? [];
        const short = windows.find((window) => window.id === "five_hour");
        const weekly = windows.find((window) => window.id === "weekly");
        // A missing five-hour window is a limit the account does not have; a window
        // without its value is an incomplete answer, and no value is made up for it.
        if (
          !weekly ||
          weekly.usedPct === null ||
          (short !== undefined && short.usedPct === null)
        )
          return [];
        const planCapacity = /Max\s+20x/i.test(report.report.planLabel ?? "")
          ? 20
          : /Max\s+5x/i.test(report.report.planLabel ?? "")
            ? 5
            : 1;
        // The account's own windows come from this one report, the other limits from the newest
        // values. A limit only this report names, and without a value, stays unknown.
        const scoped = scopedLimits([
          ...scopedWindows,
          ...windows.filter(
            (window) => !scopedWindows.some((entry) => entry.id === window.id),
          ),
        ]);
        const usage: AccountUsage = {
          id: account.id,
          capacity: capacities[account.id] ?? planCapacity,
          fetchedAt: Date.parse(report.fetchedAt),
          fiveHour: short ? windowUsage(short) : null,
          weekly: windowUsage(weekly)!,
          models: scoped.models,
          ...(scoped.limits.length ? { limits: scoped.limits } : {}),
        };
        return isCurrentUsage(usage, now)
          ? [{ usage, identity: report.id.slice(report.id.indexOf(":") + 1) }]
          : [];
      })
      .sort((a, b) => b.usage.fetchedAt - a.usage.fetchedAt);
    const selected = usable[0];
    if (!selected || seenReports.has(selected.identity)) return [];
    if (
      matching.some(
        (report) =>
          deniesUsage(report) &&
          Date.parse(report.fetchedAt) >= selected.usage.fetchedAt &&
          Date.parse(report.fetchedAt) <= now &&
          now - Date.parse(report.fetchedAt) <= policy.maxAge,
      )
    )
      return [];
    seenReports.add(selected.identity);
    return [selected.usage];
  });
}

export function expiredAccounts(
  accounts: Account[],
  reports: z.infer<typeof reportsSchema>,
  now = Date.now(),
) {
  const seen = new Set<string>();
  return accounts.filter((account) => {
    const identity =
      account.identity ?? account.email?.toLowerCase() ?? account.home;
    if (seen.has(identity)) return false;
    const matches = matchingReports(account, reports);
    const newest = matches
      .filter(
        (report) =>
          Number.isFinite(Date.parse(report.fetchedAt)) &&
          Date.parse(report.fetchedAt) <= now,
      )
      .sort(
        (a, b) =>
          Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt) ||
          Number(a.report.problem?.kind === "expired") -
            Number(b.report.problem?.kind === "expired"),
      )[0];
    const expiry = Date.parse(newest?.report.problem?.expiresAt ?? "");
    if (
      newest?.report.status !== "unavailable" ||
      newest.report.problem?.kind !== "expired" ||
      !Number.isFinite(expiry) ||
      expiry > now
    )
      return false;
    seen.add(identity);
    return true;
  });
}

/**
 * When each window the reports show spent lifts, as far as they tell: going from the newest
 * reports back, the latest reset still ahead among reports of one time that show it spent. A spent
 * window naming no reset takes one from an older report that still shows it spent; a report that
 * shows the window with room, or spent with a reset (even a passed one), ends the search.
 */
function spentResets(entries: Report[], now: number) {
  const resets = new Map<string, number>();
  const settled = new Set<string>();
  for (const at of [...new Set(entries.map(fetchedAt))].sort((a, b) => b - a)) {
    const ended = new Set<string>();
    for (const entry of entries) {
      if (fetchedAt(entry) !== at) continue;
      for (const window of entry.report.windows ?? []) {
        if (window.usedPct === null || settled.has(window.id)) continue;
        const reset =
          window.resetsAt === null ? NaN : Date.parse(window.resetsAt);
        if (window.usedPct >= 100 && Number.isNaN(reset)) continue;
        ended.add(window.id);
        if (window.usedPct >= 100 && reset > now)
          resets.set(
            window.id,
            Math.max(resets.get(window.id) ?? reset, reset),
          );
      }
    }
    for (const id of ended) settled.add(id);
  }
  return resets;
}

/**
 * The account's windows as its newest report that has any shows them, completed window by window
 * from its other reports (`mergeWindows`): a newer value wins, so an early reset shows, and a newer
 * report that leaves a window out or names it without a value does not hide an older confirmed one.
 * A spent window lifts when `spentResets` says, so a newer report that names no reset for it does
 * not drop the one an older report confirmed.
 */
function accountWindows(
  account: Account,
  reports: z.infer<typeof reportsSchema>,
  now = Date.now(),
) {
  const withWindows = matchingReports(account, reports).filter(
    (entry) => !deniesUsage(entry) && (entry.report.windows?.length ?? 0) > 0,
  );
  const newest = Math.max(...withWindows.map(fetchedAt));
  const resets = spentResets(withWindows, now);
  return mergeWindows(
    withWindows.filter((entry) => fetchedAt(entry) === newest),
    withWindows.filter((entry) => fetchedAt(entry) !== newest),
  ).map((window) => {
    const reset = resets.get(window.id);
    return reset !== undefined &&
      window.usedPct !== null &&
      window.usedPct >= 100
      ? { ...window, resetsAt: new Date(reset).toISOString() }
      : window;
  });
}

/** A used-up window whose reset is still ahead, or unknown. */
function spentWindow(window: UsageWindow, now: number) {
  return (
    window.usedPct !== null &&
    window.usedPct >= 100 &&
    (window.resetsAt === null ||
      !Number.isFinite(Date.parse(window.resetsAt)) ||
      Date.parse(window.resetsAt) > now)
  );
}

/**
 * When a fully used limit lifts: the latest reset among exhausted windows, or null if none is
 * exhausted. With `family`, that model's limits count as well as the account's own.
 */
export function exhaustedUntil(
  account: Account,
  reports: z.infer<typeof reportsSchema>,
  now = Date.now(),
  family?: string | null,
) {
  const resets = accountWindows(account, reports, now)
    .filter(
      (window) =>
        limitsSession(window.id, family) &&
        window.usedPct !== null &&
        window.usedPct >= 100,
    )
    .map((window) =>
      window.resetsAt === null ? NaN : Date.parse(window.resetsAt),
    )
    .filter((at) => at > now);
  return resets.length ? Math.max(...resets) : null;
}

/** Spent limits keyed by name, with when each lifts (null when a spent window names no reset). */
function spentBy(
  windows: UsageWindow[],
  now: number,
  name: (window: UsageWindow) => string | null,
) {
  const spent = new Map<string, number | null>();
  for (const window of windows) {
    const key = name(window);
    if (!key || window.usedPct === null || window.usedPct < 100) continue;
    const at = window.resetsAt === null ? null : Date.parse(window.resetsAt);
    // A reset that already passed most likely lifted the limit; it is not shown as spent.
    if (at !== null && !(at > now)) continue;
    const previous = spent.get(key);
    spent.set(
      key,
      previous === undefined
        ? at
        : previous === null || at === null
          ? null
          : Math.max(previous, at),
    );
  }
  return [...spent];
}

/** Model limits that are spent while the account itself may still have room, with when each lifts. */
export function exhaustedModels(
  account: Account,
  reports: z.infer<typeof reportsSchema>,
  now = Date.now(),
) {
  return spentBy(accountWindows(account, reports, now), now, (window) =>
    windowFamily(window.id),
  ).map(([family, resetsAt]) => ({ family, resetsAt }));
}

/** Spent limits of surfaces other than Claude Code: shown to the user, never used for routing. */
export function exhaustedSurfaces(
  account: Account,
  reports: z.infer<typeof reportsSchema>,
  now = Date.now(),
) {
  return spentBy(accountWindows(account, reports, now), now, otherSurface).map(
    ([name, resetsAt]) => ({ name, resetsAt }),
  );
}

/**
 * The used share of the account's five-hour and weekly windows: undefined for a window the
 * account does not report, null for one reported without a value.
 */
export function accountShares(
  account: Account,
  reports: z.infer<typeof reportsSchema>,
) {
  const windows = accountWindows(account, reports);
  const share = (id: string) => {
    const window = windows.find((entry) => entry.id === id);
    return window === undefined ? undefined : window.usedPct;
  };
  return { fiveHour: share("five_hour"), weekly: share("weekly") };
}

/** The spent limits that keep one account from a session, as its usage reports confirm them. */
export interface SpentAccount {
  /** When the account serves the session again: the latest reset among the limits that block it. */
  resetAt: number;
  /** A limit of the session's own model is spent. */
  model: boolean;
  /** A five-hour limit of the account's own is spent. */
  fiveHour: boolean;
  /** A weekly limit of the account's own is spent. */
  weekly: boolean;
}

/**
 * What blocks each account when usage confirms every one of them spent, or null as soon as one is
 * not. A partial report can prove exhaustion even when it cannot produce a routing score.
 * With `family`, a spent limit of that model counts as exhaustion too.
 */
export function spentAccounts(
  accounts: Account[],
  reports: z.infer<typeof reportsSchema>,
  now = Date.now(),
  family?: string | null,
): SpentAccount[] | null {
  if (!accounts.length) return null;
  const spent: SpentAccount[] = [];
  for (const account of accounts) {
    const current = matchingReports(account, reports).filter(
      (entry) =>
        fetchedAt(entry) <= now && now - fetchedAt(entry) <= policy.maxAge,
    );
    const latestAt = Math.max(...current.map(fetchedAt));
    const answers = current.filter(
      (entry) => !deniesUsage(entry) && entry.report.status === "available",
    );
    const latest = answers.filter((entry) => fetchedAt(entry) === latestAt);
    if (!latest.some((entry) => (entry.report.windows?.length ?? 0) > 0))
      return null;
    const exhausted = mergeWindows(
      latest,
      answers.filter((entry) => fetchedAt(entry) !== latestAt),
    ).filter(
      (window) => limitsSession(window.id, family) && window.usedPct === 100,
    );
    if (!exhausted.length) return null;
    const resets = exhausted.map((window) => Date.parse(window.resetsAt ?? ""));
    if (resets.some((at) => !Number.isFinite(at) || at <= now)) return null;
    const limits = exhausted.map((window) => windowLimit(window.id)!);
    const own = (period: LimitPeriod) =>
      limits.some((limit) => limit.family === null && limit.period === period);
    spent.push({
      resetAt: Math.max(...resets),
      model: limits.some((limit) => limit.family !== null),
      fiveHour: own("five_hour"),
      weekly: own("weekly"),
    });
  }
  return spent;
}

/**
 * When the first of the accounts serves a session again, if usage confirms them all spent: each
 * account returns when the last of the limits that block it lifts.
 */
export function exhaustedAccountsResetAt(
  accounts: Account[],
  reports: z.infer<typeof reportsSchema>,
  now = Date.now(),
  family?: string | null,
) {
  const spent = spentAccounts(accounts, reports, now, family);
  return spent && Math.min(...spent.map((account) => account.resetAt));
}

/**
 * Accounts worth opening through the official CLI's own check when usage gives no score:
 * an expired login, a usage lookup throttled by Claude, or an incomplete report. A report is
 * incomplete when it misses the weekly window, or when a limit the session runs into (the
 * account's own, or with `family` that model's) has no usable value: none, an unknown or passed
 * reset, or use without a reset. It still needs a limit of the account's own that confirms room,
 * and no limit the session runs into may be confirmed spent. A report without a five-hour window
 * is complete (the account has no such limit) and is scored by `mapReports` instead.
 */
export function bootstrapAccounts(
  accounts: Account[],
  reports: z.infer<typeof reportsSchema>,
  now = Date.now(),
  isBlocked: (accountId: string) => boolean = () => false,
  family?: string | null,
) {
  const expired = new Set(expiredAccounts(accounts, reports, now));
  const seen = new Set<string>();
  const throttled = new Set<Account>();
  const room = (window: UsageWindow) =>
    window.usedPct !== null &&
    window.usedPct < 100 &&
    (window.resetsAt === null
      ? window.usedPct === 0
      : Date.parse(window.resetsAt) > now);
  const startable = accounts.filter((account) => {
    const identity =
      account.identity ?? account.email?.toLowerCase() ?? account.home;
    if (seen.has(identity)) return false;
    const matching = matchingReports(account, reports);
    const latest = matching
      .filter(
        (entry) =>
          Number.isFinite(Date.parse(entry.fetchedAt)) &&
          Date.parse(entry.fetchedAt) <= now,
      )
      .sort(
        (a, b) =>
          Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt) ||
          Number(deniesUsage(b)) - Number(deniesUsage(a)),
      )[0];
    const answered =
      latest?.report.status === "available" && !deniesUsage(latest);
    const answers = matching.filter(
      (entry) =>
        entry !== latest &&
        entry.report.status === "available" &&
        !deniesUsage(entry) &&
        fetchedAt(entry) <= now,
    );
    // What the newest answer shows, completed from current answers only: a stale report must not
    // make an incomplete one look complete. Any older answer still counts for a spent limit.
    const windows = answered
      ? mergeWindows(
          [latest],
          answers.filter((entry) => now - fetchedAt(entry) <= policy.maxAge),
        ).filter((window) => limitsSession(window.id, family))
      : [];
    const known = answered
      ? mergeWindows([latest], answers).filter((window) =>
          limitsSession(window.id, family),
        )
      : [];
    const partial =
      answered &&
      now - Date.parse(latest.fetchedAt) <= policy.maxAge &&
      (!windows.some((window) => window.id === "weekly") ||
        windows.some((window) => !room(window))) &&
      windows.some(
        (window) => windowLimit(window.id)?.family === null && room(window),
      ) &&
      !known.some((window) => spentWindow(window, now)) &&
      !matching.some(
        (entry) =>
          Date.parse(entry.fetchedAt) >= Date.parse(latest.fetchedAt) &&
          Date.parse(entry.fetchedAt) <= now &&
          (entry.report.windows ?? []).some(
            (window) =>
              limitsSession(window.id, family) && spentWindow(window, now),
          ),
      );
    // The usage endpoint's throttling is not a quota or authentication rejection.
    // Let the official CLI check it, without inventing a usage score or bypassing known limits.
    const rateLimited =
      latest?.report.status === "error" &&
      /^Rate limited by Claude\. Try again (?:later|in \d+[mh])\.$/.test(
        latest.report.error ?? "",
      ) &&
      now - Date.parse(latest.fetchedAt) <= policy.maxAge &&
      !matching.some(
        (entry) =>
          Date.parse(entry.fetchedAt) <= now &&
          now - Date.parse(entry.fetchedAt) <= policy.maxAge &&
          deniesUsage(entry) &&
          entry.report.problem?.kind !== "expired",
      ) &&
      !matching.some((entry) =>
        (entry.report.windows ?? []).some(
          (window) =>
            limitsSession(window.id, family) && spentWindow(window, now),
        ),
      );
    if (!expired.has(account) && !partial && !rateLimited) return false;
    if (rateLimited) throttled.add(account);
    seen.add(identity);
    return true;
  });
  // A session sent to an expired login fails, so that is only worth trying with nothing better.
  const open = (account: Account) =>
    !expired.has(account) && !isBlocked(account.id);
  const verified = startable.filter(
    (account) => open(account) && !throttled.has(account),
  );
  if (verified.length) return verified;
  const unverified = startable.filter(open);
  return unverified.length
    ? unverified
    : startable.filter((account) => !throttled.has(account));
}

/**
 * Whether reports from before a login change can still decide while the forced lookup it needs
 * runs: every report must stay current for the scheduler (`policy.maxAge`) with a minute to spare.
 */
function stillCurrent(reports: z.infer<typeof reportsSchema>, now: number) {
  return (
    reports.length > 0 &&
    reports.every((report) => {
      const at = Date.parse(report.fetchedAt);
      return (
        Number.isFinite(at) && at <= now && now - at <= policy.maxAge - 60_000
      );
    })
  );
}

export class UsageReader {
  private readonly lifetime = new AbortController();
  private cached: {
    at: number;
    reports: z.infer<typeof reportsSchema>;
    /** Read before the latest login change: it stands in only while the forced lookup runs. */
    superseded?: boolean;
  } | null = null;
  private pending: {
    generation: number;
    task: Promise<z.infer<typeof reportsSchema>>;
  } | null = null;
  private generation = 0;
  private forceRefresh = false;
  private failed: { at: number; error: unknown } | null = null;

  constructor(
    private readonly run = readHostUsage,
    private readonly now = Date.now,
  ) {}

  invalidate() {
    this.generation++;
    this.cached = null;
    this.failed = null;
    this.forceRefresh = true;
  }

  /**
   * A login changed elsewhere (Settings Sync renewed or restored a token): the next lookup must
   * reach the vendor again, but nobody waits for it while the reports from just before the change
   * are still current. A limit, authentication or relogin result still calls `invalidate`.
   */
  revalidate() {
    this.generation++;
    this.failed = null;
    this.forceRefresh = true;
    if (this.cached) this.cached = { ...this.cached, superseded: true };
  }

  dispose() {
    this.lifetime.abort();
    this.generation++;
    this.cached = null;
    this.failed = null;
  }

  async read(
    command: Command,
    signal: AbortSignal,
  ): Promise<z.infer<typeof reportsSchema>> {
    signal = AbortSignal.any([signal, this.lifetime.signal]);
    signal.throwIfAborted();
    const cached = this.cached;
    if (cached && !cached.superseded && this.now() - cached.at < 60_000)
      return cached.reports;
    // Session opens run one at a time, so each would otherwise wait out its own failing
    // lookup behind the previous one and run past the host's hook time limit.
    const elapsed = this.failed ? this.now() - this.failed.at : -1;
    if (this.failed && elapsed >= 0 && elapsed < 15_000)
      throw this.failed.error;
    const generation = this.generation;
    if (!this.pending || this.pending.generation !== generation) {
      const request = {
        generation,
        task: Promise.resolve([] as z.infer<typeof reportsSchema>),
      };
      request.task = (async () => {
        try {
          const reports = parseReports(
            JSON.parse(
              await this.run(
                command,
                [
                  "usage",
                  "--json",
                  "--home",
                  paseoHome,
                  ...(this.forceRefresh ? ["--refresh"] : []),
                ],
                this.lifetime.signal,
              ),
            ),
          );
          if (generation === this.generation) {
            this.cached = { at: this.now(), reports };
            this.failed = null;
            this.forceRefresh = false;
          }
          return reports;
        } catch (error) {
          if (generation === this.generation && !this.lifetime.signal.aborted)
            this.failed = { at: this.now(), error };
          throw error;
        }
      })().finally(() => {
        if (this.pending === request) this.pending = null;
      });
      this.pending = request;
    }
    // After a login change the reports from just before it decide while the forced lookup runs.
    if (cached?.superseded && stillCurrent(cached.reports, this.now())) {
      this.pending.task.catch(() => undefined);
      return cached.reports;
    }
    const reports = await sharedResult(this.pending.task, signal);
    signal.throwIfAborted();
    return generation === this.generation
      ? reports
      : this.read(command, signal);
  }
}
