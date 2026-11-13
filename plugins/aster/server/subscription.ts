import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Account } from "./accounts";
import { accountKey } from "./routing-cache";
import {
  coreProfileReader,
  matchesAccount,
  type ReadProfiles,
} from "./core-profiles";
import { credentialStore } from "../../settings-sync/server/relay/credential-store";
import type {
  CredentialProviders,
  CredentialState,
} from "../../settings-sync/server/relay/credential-types";
import { sharedResult } from "./shared-result";

const profileSchema = z.object({
  account: z.object({
    uuid: z.string(),
    has_claude_pro: z.boolean().optional(),
    has_claude_max: z.boolean().optional(),
  }),
  organization: z.object({
    uuid: z.string(),
    organization_type: z.string().optional(),
    subscription_status: z.string().nullish(),
    claude_code_trial_ends_at: z.string().nullish(),
  }),
});
const stateSchema = z
  .object({
    version: z.literal(1),
    at: z.number().finite().nonnegative(),
    denied: z.boolean(),
  })
  .strict();
type AccessState = z.infer<typeof stateSchema>;
const interval = 60_000;
/**
 * How long an allowed answer may open sessions while a due check runs in the background. A denial
 * is always checked again before it refuses, so a renewed subscription is not turned away, and an
 * account never answered is waited for. Checks stay due every `interval`; only who waits changes.
 */
const reuseAllowed = 6 * 3_600_000;
/** An unchanged answer is written again this often, so a restart starts from a recent one. */
const persistUnchanged = 10 * 60_000;
/** Observations kept per account; the newest one alone decides. */
const keptObservations = 2;
const observation = /^\d{16}-[01]-[a-f0-9-]{36}\.json$/;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Flags describe present access; a scheduled cancellation can still have paid access. */
export function subscriptionAccess(
  value: unknown,
  identity: string,
  now: number,
): boolean | null {
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) return null;
  const { account, organization } = parsed.data;
  const actual = createHash("sha256")
    .update(JSON.stringify(["claude", account.uuid, organization.uuid]))
    .digest("hex");
  if (actual !== identity) return null;
  if (
    [
      "unpaid",
      "expired",
      "paused",
      "incomplete",
      "incomplete_expired",
    ].includes(organization.subscription_status ?? "")
  )
    return false;
  if (account.has_claude_max === true || account.has_claude_pro === true)
    return true;
  if (Date.parse(organization.claude_code_trial_ends_at ?? "") > now)
    return true;
  if (
    ["canceled", "cancelled"].includes(organization.subscription_status ?? "")
  )
    return false;
  if (
    ["active", "trialing"].includes(organization.subscription_status ?? "") &&
    /team|business|enterprise/.test(organization.organization_type ?? "")
  )
    return true;
  // Team/Enterprise seats and unknown future profile shapes are not personal Free plans.
  if (
    account.has_claude_max === false &&
    account.has_claude_pro === false &&
    /^(?:claude_)?(?:free|pro|max|personal|individual)$/.test(
      organization.organization_type ?? "",
    )
  )
    return false;
  return null;
}

function subscriptionMessage(message: string) {
  if (/^(?:API Error:\s*)?402\b/i.test(message)) return true;
  if (
    /^(?:Error:\s*)?(?:Claude (?:Max or Pro|Pro or Max) is required to (?:connect to|use) Claude Code|Claude Code requires (?:an? )?(?:active |paid )?(?:Pro|Max|subscription)|(?:An? )?(?:active |paid )?(?:Claude )?subscription is required)/i.test(
      message,
    )
  )
    return true;
  if (
    !/^(?:(?:Error|API Error):\s*)?(?:40[023]\b|\{\s*"(?:type|error)"|billing_error\b|subscription_(?:required|inactive|expired)\b)/i.test(
      message,
    )
  )
    return false;
  return /\bbilling_error\b|\bsubscription_(?:required|inactive|expired)\b|subscription.{0,100}(?:inactive|expired|cancelled|canceled|not active|required)|(?:active|paid).{0,30}subscription.{0,30}required|credit balance is too low/i.test(
    message,
  );
}

export function needsSubscriptionRecovery(
  outcome: { kind: string; error?: { message: string; code?: string } },
  _timeline: readonly { type: string; text?: string }[] = [],
) {
  if (outcome.kind === "canceled") return false;
  if (
    outcome.kind === "failed" &&
    outcome.error &&
    (subscriptionMessage(outcome.error.message.trim()) ||
      /^(?:billing_error|subscription_required|subscription_inactive|subscription_expired)$/.test(
        outcome.error.code ?? "",
      ))
  )
    return true;
  // A successful model answer can quote an error or explain subscription requirements.
  // Only provider failures or official profiles may remove an account from routing.
  return false;
}

/** Device-local access observations contain only identity hashes, time and a boolean. */
export class SubscriptionGuard {
  private readonly lifetime = new AbortController();
  private states = new Map<string, AccessState>();
  private checked = new Map<string, number>();
  private loaded = new Set<string>();
  /** When the newest observation on disk was made, per account. */
  private persisted = new Map<string, number>();
  private pending = new Map<string, Promise<void>>();
  private readonly now;
  private readonly fetchApi;
  private readonly capture;
  private readonly readProfiles: ReadProfiles | undefined;
  constructor(
    private readonly directory: string,
    home: string,
    options: {
      now?: () => number;
      fetchApi?: typeof fetch;
      capture?: (providers: CredentialProviders) => Promise<CredentialState>;
      readProfiles?: ReadProfiles;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.fetchApi = options.fetchApi ?? fetch;
    this.capture = options.capture ?? credentialStore(home).read;
    this.readProfiles =
      options.readProfiles ??
      (options.capture || options.fetchApi
        ? undefined
        : coreProfileReader(home));
  }
  private async regular(file: string, directory = false) {
    const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (
      stat &&
      (stat.isSymbolicLink() ||
        (directory ? !stat.isDirectory() : !stat.isFile() || stat.size > 4096))
    )
      throw Error("Unsafe subscription cache");
    return stat;
  }
  private async load(key: string) {
    const dir = join(this.directory, key);
    if (
      !(await this.regular(this.directory, true)) ||
      !(await this.regular(dir, true))
    )
      return;
    // Immutable observations prevent an old plugin instance's late response overwriting newer denial.
    const files = (await readdir(dir))
      .filter((file) => observation.test(file))
      .sort()
      .reverse();
    if (!files.length) return;
    const file = join(dir, files[0]);
    if (!(await this.regular(file))) return;
    const state = stateSchema.parse(JSON.parse(await readFile(file, "utf8")));
    if (
      state.at > this.now() + interval ||
      !files[0].startsWith(
        `${String(state.at).padStart(16, "0")}-${Number(state.denied)}-`,
      )
    )
      throw Error("Invalid subscription observation");
    this.persisted.set(key, Math.max(this.persisted.get(key) ?? 0, state.at));
    const previous = this.states.get(key);
    if (
      !previous ||
      state.at > previous.at ||
      (state.at === previous.at && state.denied)
    )
      this.states.set(key, state);
  }
  private async remember(
    key: string,
    denied: boolean,
    at: number,
    current = () => true,
  ) {
    try {
      await this.load(key);
    } catch {
      console.warn(
        "[aster] 구독 상태 캐시를 읽지 못했습니다. 기존 차단 상태와 계정 인증은 유지합니다.",
      );
    }
    if (!current()) return;
    const previous = this.states.get(key);
    if (
      previous &&
      (previous.at > at || (previous.at === at && previous.denied && !denied))
    )
      return;
    const state: AccessState = { version: 1, at, denied };
    this.states.set(key, state);
    if (
      previous?.denied === denied &&
      at - (this.persisted.get(key) ?? -Infinity) < persistUnchanged
    )
      return;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.regular(this.directory, true);
      const dir = join(this.directory, key);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await this.regular(dir, true);
      const file = join(
          dir,
          `${String(at).padStart(16, "0")}-${Number(denied)}-${randomUUID()}.json`,
        ),
        temporary = file + ".tmp";
      try {
        await writeFile(temporary, JSON.stringify(state), {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
      this.persisted.set(key, Math.max(this.persisted.get(key) ?? 0, at));
      await this.prune(dir);
    } catch {
      console.warn(
        "[aster] 구독 상태 캐시 저장에 실패했습니다. 현재 인스턴스의 계정 제외는 유지합니다.",
      );
    }
  }
  /** Only the newest observation is read, so older ones go once newer ones exist. */
  private async prune(dir: string) {
    const files = (await readdir(dir))
      .filter((file) => observation.test(file))
      .sort()
      .reverse();
    for (const file of files.slice(keptObservations))
      await rm(join(dir, file), { force: true }).catch(() => undefined);
  }
  async deny(account: Account, current = () => true) {
    if (this.lifetime.signal.aborted) return;
    const key = accountKey(account),
      at = this.now();
    const active = () => !this.lifetime.signal.aborted && current();
    await this.remember(key, true, at, active);
    if (active()) this.checked.set(key, at);
  }
  dispose() {
    this.lifetime.abort();
  }
  /**
   * The accounts whose subscription is not known to have ended. With `reuse`, an account last
   * answered as allowed (within `reuseAllowed`) is not waited for: its due check runs in the
   * background and a denial it finds applies from the next call on. `onWait` learns whether this
   * call waited for a check and how many ran in the background.
   */
  async filter(
    accounts: Account[],
    providers: () => Promise<CredentialProviders>,
    signal: AbortSignal,
    options: {
      reuse?: boolean;
      onWait?: (plan: { waited: number; background: number }) => void;
    } = {},
  ) {
    signal = AbortSignal.any([signal, this.lifetime.signal]);
    signal.throwIfAborted();
    const unique = [
      ...new Map(
        accounts.map((account) => [accountKey(account), account]),
      ).entries(),
    ];
    for (const [key] of unique)
      if (!this.loaded.has(key)) {
        try {
          await this.load(key);
        } catch {
          console.warn(
            "[aster] 구독 상태 캐시를 읽지 못해 공식 프로필에서 다시 확인합니다.",
          );
        }
        this.loaded.add(key);
      }
    signal.throwIfAborted();
    const due = unique.filter(
      ([key]) =>
        this.pending.has(key) ||
        !this.checked.has(key) ||
        this.now() - this.checked.get(key)! >= interval ||
        this.now() < this.checked.get(key)!,
    );
    let snapshot: Promise<CredentialState> | undefined;
    const capture = () => (snapshot ??= providers().then(this.capture));
    const requested = accounts
      .filter((account) => due.some(([key]) => accountKey(account) === key))
      .map((account) => account.id);
    let core: ReturnType<ReadProfiles> | undefined;
    const operationSignal = this.lifetime.signal;
    const coreSnapshot = () =>
      (core ??= this.readProfiles!(requested, operationSignal));
    const now = this.now();
    const settled = (key: string) => {
      const state = this.states.get(key);
      const at = Math.max(state?.at ?? -Infinity, this.checked.get(key) ?? 0);
      return (
        options.reuse === true &&
        !!state &&
        !state.denied &&
        now >= at &&
        now - at < reuseAllowed
      );
    };
    const background = new Set(
      due.filter(([key]) => settled(key)).map(([key]) => key),
    );
    const checks = due.map(([key, account]) => {
      if (this.pending.has(key)) return this.pending.get(key)!;
      const at = this.now();
      const task = (async () => {
        try {
          if (this.readProfiles) {
            const profiles = await coreSnapshot();
            operationSignal.throwIfAborted();
            if (profiles !== null) {
              const ids = accounts
                .filter((candidate) => accountKey(candidate) === key)
                .map((candidate) => candidate.id);
              const entries = profiles.filter((entry) =>
                ids.includes(entry.providerId),
              );
              const current = entries.find(
                (entry) =>
                  entry.status === "ready" &&
                  "profile" in entry &&
                  matchesAccount(account, entry.profile),
              );
              if (current && "profile" in current) {
                const allowed = subscriptionAccess(
                  current.profile,
                  current.identity,
                  this.now(),
                );
                if (allowed !== null) await this.remember(key, !allowed, at);
              } else if (entries.some((entry) => entry.status === 402))
                await this.remember(key, true, at);
              return;
            }
          }
          const state = await capture();
          operationSignal.throwIfAborted();
          const ids = accounts
            .filter((candidate) => accountKey(candidate) === key)
            .map((candidate) => candidate.id);
          const record = state.accounts
            .filter((own) => own.providerIds.some((id) => ids.includes(id)))
            .map((own) => own.record)
            .filter((record) => record && record.expiresAt! > this.now())
            .sort((a, b) => b!.expiresAt! - a!.expiresAt!)[0];
          const oauth = record?.credential.claudeAiOauth;
          if (
            !record ||
            !object(oauth) ||
            typeof oauth.accessToken !== "string"
          )
            return;
          const response = await this.fetchApi(
            "https://api.anthropic.com/api/oauth/profile",
            {
              redirect: "error",
              headers: {
                Authorization: `Bearer ${oauth.accessToken}`,
                Accept: "application/json",
                "anthropic-beta": "oauth-2025-04-20",
              },
              signal: AbortSignal.any([
                operationSignal,
                AbortSignal.timeout(5000),
              ]),
            },
          );
          operationSignal.throwIfAborted();
          if (response.status === 402) {
            await this.remember(key, true, at);
            return;
          }
          if (!response.ok) return;
          const allowed = subscriptionAccess(
            await response.json(),
            record.identity,
            this.now(),
          );
          operationSignal.throwIfAborted();
          if (allowed !== null) await this.remember(key, !allowed, at);
        } catch (error) {
          operationSignal.throwIfAborted(); /* A network/auth error never clears a known denial or affects another account. */
          // Background checks fail with nobody waiting, so the reason is not lost.
          console.warn(
            `[aster] Claude 구독 확인 실패, 직전 판정 유지 (${account.id}): ${String(error).slice(0, 120)}`,
          );
        }
      })().finally(() => {
        if (!operationSignal.aborted) this.checked.set(key, this.now());
        if (this.pending.get(key) === task) this.pending.delete(key);
      });
      this.pending.set(key, task);
      return task;
    });
    // A background check settles after this call returns; disposal ends it without a waiter.
    for (const check of checks) check.catch(() => undefined);
    const waited = checks.filter((_, index) => !background.has(due[index][0]));
    options.onWait?.({ waited: waited.length, background: background.size });
    await sharedResult(Promise.all(waited), signal);
    signal.throwIfAborted();
    return accounts.filter(
      (account) => !this.states.get(accountKey(account))?.denied,
    );
  }
}
