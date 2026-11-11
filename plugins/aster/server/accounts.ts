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

/**
 * The model family of a `weekly_model_<id>` window: a bare family name, optionally after
 * `claude-` and before a version. Anything else is a limit Aster cannot tie to a model.
 */
export function windowFamily(id: string) {
  return (
    /^weekly_model_(?:claude[-_])?([a-z]+)(?:[-_]\d[\w.-]*)?$/i
      .exec(id)?.[1]
      .toLowerCase() ?? null
  );
}

/**
 * Whether a window limits a session on `family`: the account's own limits always do, a model's
 * weekly limit only for that model. Without a family the model limits are left out.
 */
function limitsSession(id: string, family?: string | null) {
  return (
    id === "five_hour" ||
    id === "weekly" ||
    (!!family && windowFamily(id) === family)
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

/** A family named twice keeps its unknown value, otherwise its more used one. */
function modelWindows(windows: UsageWindow[]) {
  const models: Record<string, WindowUsage | null> = {};
  for (const window of windows) {
    const family = windowFamily(window.id);
    if (!family) continue;
    const usage = windowUsage(window);
    const previous = Object.hasOwn(models, family) ? models[family] : undefined;
    models[family] =
      previous === undefined
        ? usage
        : previous === null || usage === null
          ? null
          : previous.used >= usage.used
            ? previous
            : usage;
  }
  return models;
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
    const usable = matching
      .flatMap((report) => {
        if (report.report.status !== "available" || deniesUsage(report))
          return [];
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
        const usage: AccountUsage = {
          id: account.id,
          capacity: capacities[account.id] ?? planCapacity,
          fetchedAt: Date.parse(report.fetchedAt),
          fiveHour: short ? windowUsage(short) : null,
          weekly: windowUsage(weekly)!,
          models: modelWindows(windows),
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
 * The windows of an account's newest report that has any: an older report from another
 * source must not keep a limit that has since been lifted, or reset early.
 */
function newestWindows(
  account: Account,
  reports: z.infer<typeof reportsSchema>,
) {
  const withWindows = matchingReports(account, reports).filter(
    (entry) => !deniesUsage(entry) && (entry.report.windows?.length ?? 0) > 0,
  );
  const at = (entry: (typeof withWindows)[number]) => {
    const fetched = Date.parse(entry.fetchedAt);
    return Number.isFinite(fetched) ? fetched : -Infinity;
  };
  const newest = Math.max(...withWindows.map(at));
  return withWindows
    .filter((entry) => at(entry) === newest)
    .flatMap((entry) => entry.report.windows ?? []);
}

/**
 * When a fully used limit lifts: the latest reset among exhausted windows, or null if none is
 * exhausted. With `family`, that model's weekly limit counts as well as the account's own.
 */
export function exhaustedUntil(
  account: Account,
  reports: z.infer<typeof reportsSchema>,
  now = Date.now(),
  family?: string | null,
) {
  const resets = newestWindows(account, reports)
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

/** Model limits that are spent while the account itself may still have room, with when each lifts. */
export function exhaustedModels(
  account: Account,
  reports: z.infer<typeof reportsSchema>,
  now = Date.now(),
) {
  const spent = new Map<string, number | null>();
  for (const window of newestWindows(account, reports)) {
    const family = windowFamily(window.id);
    if (!family || window.usedPct === null || window.usedPct < 100) continue;
    const at = window.resetsAt === null ? null : Date.parse(window.resetsAt);
    // A reset that already passed most likely lifted the limit; it is not shown as spent.
    if (at !== null && !(at > now)) continue;
    const previous = spent.get(family);
    spent.set(
      family,
      previous === undefined
        ? at
        : previous === null || at === null
          ? null
          : Math.max(previous, at),
    );
  }
  return [...spent].map(([family, resetsAt]) => ({ family, resetsAt }));
}

/**
 * A partial report can prove exhaustion even when it cannot produce a routing score.
 * With `family`, a spent weekly limit of that model counts as exhaustion too.
 */
export function exhaustedAccountsResetAt(
  accounts: Account[],
  reports: z.infer<typeof reportsSchema>,
  now = Date.now(),
  family?: string | null,
) {
  if (!accounts.length) return null;
  const resets: number[] = [];
  for (const account of accounts) {
    const current = matchingReports(account, reports).filter((entry) => {
      const at = Date.parse(entry.fetchedAt);
      return Number.isFinite(at) && at <= now && now - at <= policy.maxAge;
    });
    const latestAt = Math.max(
      ...current.map((entry) => Date.parse(entry.fetchedAt)),
    );
    const exhausted = current
      .filter(
        (entry) =>
          Date.parse(entry.fetchedAt) === latestAt && !deniesUsage(entry),
      )
      .flatMap((entry) =>
        entry.report.status === "available" ? (entry.report.windows ?? []) : [],
      )
      .filter(
        (window) => limitsSession(window.id, family) && window.usedPct === 100,
      );
    if (!exhausted.length) return null;
    const accountResets = exhausted.map((window) =>
      Date.parse(window.resetsAt ?? ""),
    );
    if (accountResets.some((at) => !Number.isFinite(at) || at <= now))
      return null;
    resets.push(Math.max(...accountResets));
  }
  return Math.min(...resets);
}

/**
 * Accounts worth opening through the official CLI's own check when usage gives no score:
 * an expired login, a usage lookup throttled by Claude, or a report missing its weekly window.
 * A report without a five-hour window is complete (the account has no such limit) and is
 * scored by `mapReports` instead. With `family`, that model's spent limit is honoured too.
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
    const windows = latest?.report.windows ?? [];
    const known = windows.filter((window) => limitsSession(window.id, family));
    const partial =
      latest?.report.status === "available" &&
      !deniesUsage(latest) &&
      now - Date.parse(latest.fetchedAt) <= policy.maxAge &&
      windows.some((window) => window.id === "five_hour") &&
      !windows.some((window) => window.id === "weekly") &&
      known.every(
        (window) =>
          window.usedPct !== null &&
          window.usedPct >= 0 &&
          window.usedPct < 100 &&
          (window.resetsAt === null
            ? window.usedPct === 0
            : Date.parse(window.resetsAt) > now),
      ) &&
      !matching.some(
        (entry) =>
          Date.parse(entry.fetchedAt) >= Date.parse(latest.fetchedAt) &&
          Date.parse(entry.fetchedAt) <= now &&
          (entry.report.windows ?? []).some(
            (window) =>
              limitsSession(window.id, family) &&
              window.usedPct !== null &&
              window.usedPct >= 100,
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
            limitsSession(window.id, family) &&
            window.usedPct !== null &&
            window.usedPct >= 100 &&
            (window.resetsAt === null ||
              !Number.isFinite(Date.parse(window.resetsAt)) ||
              Date.parse(window.resetsAt) > now),
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

export class UsageReader {
  private readonly lifetime = new AbortController();
  private cached: {
    at: number;
    reports: z.infer<typeof reportsSchema>;
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
    if (this.cached && this.now() - this.cached.at < 60_000)
      return this.cached.reports;
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
    const reports = await sharedResult(this.pending.task, signal);
    signal.throwIfAborted();
    return generation === this.generation
      ? reports
      : this.read(command, signal);
  }
}
