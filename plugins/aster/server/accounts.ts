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
import { isCurrentUsage, policy, type AccountUsage } from "./scheduler.ts";
import { hostUsageReader } from "./host-usage";

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
  usedPct: z.number().min(0).max(100).nullable(),
  resetsAt: z.string().nullable(),
});
export const reportsSchema = z.array(
  z.object({
    id: z.string(),
    sourceId: z.string(),
    account: z.object({ label: z.string().optional() }),
    fetchedAt: z.string(),
    successfulAt: z.string().optional(),
    report: z.object({
      status: z.string(),
      planLabel: z.string().optional(),
      windows: z.array(windowSchema).optional(),
      problem: z
        .object({ kind: z.string(), expiresAt: z.string().optional() })
        .optional(),
    }),
  }),
);
export const settingsSchema = z.object({
  command: commandSchema.default(defaultCommand),
  capacities: z.record(z.string(), z.number().positive()).default({}),
  profileUsageFallback: z.boolean().optional(),
});

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
  const registry = registrySchema.parse(
    JSON.parse(
      await readFile(
        join(paseoHome, "paseo-accounts", "accounts.json"),
        "utf8",
      ),
    ),
  );
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
        const short = report.report.windows?.find(
          (window) => window.id === "five_hour",
        );
        const weekly = report.report.windows?.find(
          (window) => window.id === "weekly",
        );
        if (
          !short ||
          !weekly ||
          short.usedPct === null ||
          weekly.usedPct === null
        )
          return [];
        const planCapacity = /Max\s+20x/i.test(report.report.planLabel ?? "")
          ? 20
          : /Max\s+5x/i.test(report.report.planLabel ?? "")
            ? 5
            : 1;
        const usage = {
          id: account.id,
          capacity: capacities[account.id] ?? planCapacity,
          fetchedAt: Date.parse(report.fetchedAt),
          fiveHour: {
            used: short.usedPct,
            resetsAt:
              short.resetsAt === null ? null : Date.parse(short.resetsAt),
          },
          weekly: {
            used: weekly.usedPct,
            resetsAt:
              weekly.resetsAt === null ? null : Date.parse(weekly.resetsAt),
          },
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

/** Partial quota responses are not scores; the official CLI must check the missing limit. */
export function bootstrapAccounts(
  accounts: Account[],
  reports: z.infer<typeof reportsSchema>,
  now = Date.now(),
) {
  const expired = new Set(expiredAccounts(accounts, reports, now));
  const seen = new Set<string>();
  return accounts.filter((account) => {
    const identity = account.identity ?? account.email?.toLowerCase() ?? account.home;
    if (seen.has(identity)) return false;
    const matching = matchingReports(account, reports);
    const latest = matching
      .filter((entry) => Number.isFinite(Date.parse(entry.fetchedAt)) && Date.parse(entry.fetchedAt) <= now)
      .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt) || Number(deniesUsage(b)) - Number(deniesUsage(a)))[0];
    const windows = latest?.report.windows ?? [];
    const limits = [
      { id: "five_hour", reserve: policy.fiveHourReserve },
      { id: "weekly", reserve: policy.weeklyReserve },
    ];
    const known = limits.flatMap((limit) => {
      const window = windows.find((entry) => entry.id === limit.id);
      return window ? [{ window, reserve: limit.reserve }] : [];
    });
    const partial = latest?.report.status === "available" && !deniesUsage(latest)
      && now - Date.parse(latest.fetchedAt) <= policy.maxAge
      && known.length > 0 && known.length < limits.length
      && known.every(({ window, reserve }) => window.usedPct !== null
        && window.usedPct >= 0 && window.usedPct < 100 - reserve
        && (window.resetsAt === null ? window.usedPct === 0 : Date.parse(window.resetsAt) > now))
      && !matching.some((entry) => Date.parse(entry.fetchedAt) >= Date.parse(latest.fetchedAt)
        && Date.parse(entry.fetchedAt) <= now
        && limits.some((limit) => (entry.report.windows ?? []).some((window) =>
          window.id === limit.id && window.usedPct !== null && window.usedPct >= 100 - limit.reserve)));
    if (!expired.has(account) && !partial) return false;
    seen.add(identity);
    return true;
  });
}

export class UsageReader {
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

  constructor(
    private readonly run = readHostUsage,
    private readonly now = Date.now,
  ) {}

  invalidate() {
    this.generation++;
    this.cached = null;
    this.forceRefresh = true;
  }

  async read(
    command: Command,
    signal: AbortSignal,
  ): Promise<z.infer<typeof reportsSchema>> {
    signal.throwIfAborted();
    if (this.cached && this.now() - this.cached.at < 60_000)
      return this.cached.reports;
    const generation = this.generation;
    if (!this.pending || this.pending.generation !== generation) {
      const request = {
        generation,
        task: Promise.resolve([] as z.infer<typeof reportsSchema>),
      };
      request.task = (async () => {
        const reports = reportsSchema.parse(
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
              signal,
            ),
          ),
        );
        if (generation === this.generation) {
          this.cached = { at: this.now(), reports };
          this.forceRefresh = false;
        }
        return reports;
      })().finally(() => {
        if (this.pending === request) this.pending = null;
      });
      this.pending = request;
    }
    const reports = await this.pending.task;
    signal.throwIfAborted();
    return generation === this.generation
      ? reports
      : this.read(command, signal);
  }
}
