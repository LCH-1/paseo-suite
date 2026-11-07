import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RelayPeer } from "../../client/credential-relay";
import { chainOf, refreshTokenOf } from "./credential-tokens";
import type { SharedCredential } from "./credential-types";
import { ownerOnlyDirectory, ownerOnlyFile, writeOwnerOnly, type Restrict } from "./secure-file";

// A refresh token dies for everyone the moment any copy of it is used, and a CLI uses whatever it
// finds in its profile. So profiles hold access tokens only, every host keeps the refresh token
// here where no CLI looks, and exactly one host at a time renews it and hands the result around.

/** Marks a token that came out of a renewal rather than being picked up from a profile. */
export type VaultRecord = SharedCredential & { vaultOrigin?: "renewal" };

const vaultFile = (home: string) => path.join(home, "settings-sync", "claude-vault.json");
const renewRoot = (home: string) => path.join(home, "settings-sync", "vault-renew");
const renewDirectory = (home: string, identity: string) => path.join(renewRoot(home), identity.slice(0, 16));
const allowList = (home: string) => path.join(home, "settings-sync", "vault-accounts.json");

const usable = (value: unknown): value is SharedCredential => {
  const record = value as SharedCredential | null;
  return (
    !!record &&
    record.vendor === "claude" &&
    typeof record.identity === "string" &&
    typeof record.expiresAt === "number" &&
    refreshTokenOf(record) !== null
  );
};

export async function readVault(home: string, log: (message: string) => void = console.log): Promise<SharedCredential[]> {
  let raw: string;
  try {
    raw = await readFile(vaultFile(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const records: unknown = JSON.parse(raw);
    if (Array.isArray(records)) return records.filter(usable);
  } catch {
    /* Reported below. */
  }
  // Another host still has it; the next sync fills this one back in.
  log("[settings-sync] 토큰 보관 파일이 손상되어 무시합니다.");
  return [];
}

/**
 * Every renewal issues a token that expires later, so a later expiry is the living one, and a host
 * that slept through renewals cannot put back a token that already died. A tie says less: relayed
 * access tokens copy their expiry onto a profile whose own refresh token they leave in place, so
 * a dead token can match a living one exactly. Only a renewal's own output is certain then.
 */
export function supersedes(a: VaultRecord, b: VaultRecord | undefined) {
  if (!b) return true;
  if ((a.expiresAt ?? 0) !== (b.expiresAt ?? 0)) return (a.expiresAt ?? 0) > (b.expiresAt ?? 0);
  if ((a.vaultOrigin === "renewal") !== (b.vaultOrigin === "renewal")) return a.vaultOrigin === "renewal";
  return (chainOf(a) ?? "") > (chainOf(b) ?? "");
}

async function saveVault(home: string, records: SharedCredential[], platform: NodeJS.Platform, restrict?: Restrict) {
  await writeOwnerOnly(vaultFile(home), JSON.stringify(records), ownerOnlyFile(platform, restrict));
}

export async function putVault(
  home: string,
  record: VaultRecord,
  options: { platform?: NodeJS.Platform; restrict?: Restrict; replacing?: string | null } = {},
) {
  const records = await readVault(home);
  const held = records.find((entry) => entry.identity === record.identity);
  if (!usable(record)) return false;
  // The successor of the held token is the only living one now, whatever the clocks say.
  const successor = options.replacing && held && chainOf(held) === options.replacing;
  if (!successor && !supersedes(record, held)) return false;
  await saveVault(
    home,
    [...records.filter((entry) => entry.identity !== record.identity), record],
    options.platform ?? process.platform,
    options.restrict,
  );
  return true;
}

/** An account signed out on this host stops being kept here. */
export async function dropFromVault(
  home: string,
  identities: readonly string[],
  options: { platform?: NodeJS.Platform; restrict?: Restrict } = {},
) {
  const records = await readVault(home);
  const kept = records.filter((entry) => !identities.includes(entry.identity));
  if (kept.length !== records.length) await saveVault(home, kept, options.platform ?? process.platform, options.restrict);
}

export interface VaultEntryStatus {
  identity: string;
  expiresAt: number;
  chain: string;
  renewal?: boolean;
}
/** Digests and times only: this travels over status calls. */
export const vaultStatus = (records: readonly VaultRecord[]): VaultEntryStatus[] =>
  records.map((record) => ({
    identity: record.identity,
    expiresAt: record.expiresAt!,
    chain: chainOf(record)!,
    renewal: record.vaultOrigin === "renewal",
  }));

/** Accounts move over one at a time when this list exists; without it, all of them do. */
export async function vaultAllows(home: string, identity: string) {
  let raw: string;
  try {
    raw = await readFile(allowList(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
  try {
    const list: unknown = JSON.parse(raw);
    return list === "all" || (Array.isArray(list) && list.includes(identity));
  } catch {
    return false;
  }
}

/** What to do with a refresh token found in a CLI profile. */
export function absorbDecision(own: SharedCredential, held: VaultRecord | undefined): "absorb" | "drop" | "skip" {
  if (!held) return typeof own.expiresAt === "number" ? "absorb" : "skip";
  if (chainOf(held) === chainOf(own)) return "drop";
  // Only a login newer than the vault is new. Otherwise it already died, a tie included, since
  // relayed tokens give dead refresh tokens the same expiry, and must not reach a CLI's next refresh.
  return typeof own.expiresAt === "number" && own.expiresAt > (held.expiresAt ?? 0) ? "absorb" : "drop";
}

export type RenewalOutcome = "renewed" | "recovered" | "unchanged" | "rejected";
const credentialsFile = (directory: string) => path.join(directory, ".credentials.json");
async function readCredentials(directory: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(credentialsFile(directory), "utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
function renewedRecord(record: SharedCredential, credential: Record<string, unknown> | null, now: number) {
  const oauth = credential?.claudeAiOauth as Record<string, unknown> | undefined;
  if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) return null;
  if (typeof oauth.refreshToken !== "string" || !oauth.refreshToken) return null;
  if (typeof oauth.expiresAt !== "number") return null;
  return { ...record, credential: credential!, expiresAt: oauth.expiresAt, updatedAt: now, vaultOrigin: "renewal" as const };
}

/**
 * A renewal interrupted after the CLI rotated the token leaves the only living copy in the renewal
 * folder, so that folder is always checked first and cleared only once the result is in the vault.
 */
export async function recoverRenewal(
  home: string,
  record: SharedCredential,
  options: { platform?: NodeJS.Platform; restrict?: Restrict; now?: number } = {},
) {
  const directory = renewDirectory(home, record.identity);
  const found = renewedRecord(record, await readCredentials(directory), options.now ?? Date.now());
  const rotated = found && chainOf(found) !== chainOf(record) && (found.expiresAt ?? 0) > (record.expiresAt ?? 0);
  if (rotated) await putVault(home, found, { ...options, replacing: chainOf(record) });
  await rm(directory, { recursive: true, force: true });
  return rotated ? found : null;
}

/** The official CLI does the renewing, in a folder of its own, and the outcome is read from its file. */
export async function renewVaultRecord(
  home: string,
  record: SharedCredential,
  run: (configDirectory: string) => Promise<string | null>,
  options: { platform?: NodeJS.Platform; restrict?: Restrict; restrictDirectory?: Restrict; now?: number } = {},
): Promise<{ outcome: RenewalOutcome; record: SharedCredential; failure?: string | null }> {
  const now = options.now ?? Date.now();
  const platform = options.platform ?? process.platform;
  const recovered = await recoverRenewal(home, record, options);
  if (recovered) return { outcome: "recovered", record: recovered };
  const directory = renewDirectory(home, record.identity);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await ownerOnlyDirectory(platform, options.restrictDirectory)?.(directory);
  const oauth = record.credential.claudeAiOauth as Record<string, unknown>;
  // Close to expiry on paper, which is what makes the CLI renew when it reads the file.
  await writeFile(
    credentialsFile(directory),
    JSON.stringify({
      ...record.credential,
      claudeAiOauth: { ...oauth, expiresAt: Math.min(record.expiresAt ?? now, now + 60_000) },
    }),
    { mode: 0o600 },
  );
  const failure = await run(directory);
  const after = await readCredentials(directory);
  const renewed = renewedRecord(record, after, now);
  if (!renewed) {
    await rm(directory, { recursive: true, force: true });
    // The CLI clears the file when the server refuses the token, whatever its exit status says.
    const refused = !(after?.claudeAiOauth as { refreshToken?: unknown } | undefined)?.refreshToken;
    return { outcome: refused && after ? "rejected" : "unchanged", record, failure };
  }
  const oldAccess = oauth.accessToken;
  if ((renewed.credential.claudeAiOauth as Record<string, unknown>).accessToken === oldAccess) {
    await rm(directory, { recursive: true, force: true });
    return { outcome: "unchanged", record, failure };
  }
  await putVault(home, renewed, { ...options, replacing: chainOf(record) });
  await rm(directory, { recursive: true, force: true });
  return { outcome: "renewed", record: renewed, failure };
}

export interface VaultPeerStatus {
  serverId: string;
  publicKey: string;
  vault: VaultEntryStatus[];
  accounts: string[];
  declined: string[];
  renewing?: string | null;
}
/** Same order as supersedes, so a host never refuses what it was chosen to receive. */
const beats = (entry: VaultEntryStatus, best: VaultEntryStatus) => {
  if (entry.expiresAt !== best.expiresAt) return entry.expiresAt > best.expiresAt;
  if (Boolean(entry.renewal) !== Boolean(best.renewal)) return Boolean(entry.renewal);
  return entry.chain > best.chain;
};
const newestOf = (peers: readonly VaultPeerStatus[], identity: string) => {
  let best: (VaultEntryStatus & { serverId: string }) | null = null;
  for (const peer of peers) {
    const entry = peer.vault.find((item) => item.identity === identity);
    if (!entry) continue;
    if (!best || beats(entry, best)) best = { ...entry, serverId: peer.serverId };
  }
  return best;
};
const identitiesOf = (peers: readonly VaultPeerStatus[]) => [...new Set(peers.flatMap((peer) => peer.vault.map((entry) => entry.identity)))];

export function planTransfers(peers: readonly VaultPeerStatus[]) {
  return identitiesOf(peers).flatMap((identity) => {
    const best = newestOf(peers, identity)!;
    return peers.flatMap((peer) => {
      if (peer.serverId === best.serverId || peer.declined.includes(identity)) return [];
      const entry = peer.vault.find((item) => item.identity === identity);
      if (entry && entry.chain === best.chain && entry.expiresAt === best.expiresAt) return [];
      return [{ identity, from: best.serverId, to: peer.serverId }];
    });
  });
}

export const renewBeforeExpiryMs = 15 * 60_000;
const aloneGraceMs = 10 * 60_000;
/**
 * Two daemons briefly leading pick the same host, whose queue then turns the second request into
 * a no-op. Waiting while alone matters only for an expired token: another host may have renewed
 * while this one was off, and a token used after that can cost everyone the login.
 */
export function planRenewals(
  peers: readonly VaultPeerStatus[],
  order: readonly string[],
  now: number,
  aloneMs: number | null,
  failed: (identity: string, chain: string, serverId: string) => boolean = () => false,
) {
  return identitiesOf(peers).flatMap((identity) => {
    const best = newestOf(peers, identity)!;
    if (best.expiresAt > now + renewBeforeExpiryMs) return [];
    if (aloneMs !== null && aloneMs < aloneGraceMs && best.expiresAt <= now) return [];
    if (peers.some((peer) => peer.renewing === identity)) return [];
    const holders = peers.filter(
      (peer) =>
        peer.accounts.includes(identity) &&
        !peer.declined.includes(identity) &&
        peer.vault.some((entry) => entry.identity === identity && entry.chain === best.chain),
    );
    if (!holders.length) return [];
    // A host that could not run the CLI should not leave every other host's token to expire.
    const chosen = holders
      .filter((peer) => !failed(identity, best.chain, peer.serverId))
      .sort((a, b) => order.indexOf(a.serverId) - order.indexOf(b.serverId))[0];
    return [{ identity, chain: best.chain, serverId: chosen?.serverId ?? null }];
  });
}

function within<T>(work: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Peer did not answer")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
const call = (peer: RelayPeer, method: string, input: unknown, ms = 15_000) =>
  within(peer.client.invokePluginRpc("settings-sync", `sync.credentials.${method}.request`, input), ms);

export interface VaultSyncState {
  retryAt: Map<string, number>;
  failed: Map<string, Set<string>>;
  aloneSince: number | null;
}
const renewRetryMs = 10 * 60_000;
const rejectedRetryMs = 60 * 60_000;

async function loadStatuses(ready: readonly RelayPeer[]) {
  const answers = await Promise.all(
    ready.map(async (peer) => {
      const status = (await call(peer, "status", {}).catch(() => null)) as {
        publicKey?: string;
        vault?: VaultEntryStatus[];
        accounts?: { identity: string }[];
        declined?: string[];
        renewing?: string | null;
      } | null;
      if (!status?.publicKey || !Array.isArray(status.vault)) return [];
      return [
        {
          serverId: peer.serverId,
          publicKey: status.publicKey,
          vault: status.vault,
          accounts: (status.accounts ?? []).map((account) => account.identity),
          declined: status.declined ?? [],
          renewing: status.renewing ?? null,
        } satisfies VaultPeerStatus,
      ];
    }),
  );
  return answers.flat();
}

async function transfer(ready: readonly RelayPeer[], peers: readonly VaultPeerStatus[], log: (message: string) => void) {
  const byId = new Map(ready.map((peer) => [peer.serverId, peer]));
  // All at once: the hosts still waiting hold an access token that no longer works.
  const results = await Promise.all(
    planTransfers(peers).map(async (item) => {
      const target = peers.find((peer) => peer.serverId === item.to)!;
      try {
        const envelope = await call(byId.get(item.from)!, "vault.export", { publicKey: target.publicKey, identity: item.identity });
        const result = (await call(byId.get(item.to)!, "vault.receive", envelope, 60_000)) as { changed?: boolean };
        return result?.changed ? 1 : 0;
      } catch (error) {
        log(`[settings-sync] 토큰 복제 실패 ${item.to.slice(0, 12)}: ${error instanceof Error ? error.name : "unknown"}`);
        return 0;
      }
    }),
  );
  return results.reduce<number>((sum, value) => sum + value, 0);
}

/** One daemon's pass: bring every host up to the newest token, renew what is due, and hand it round. */
export async function syncVaults(
  ready: readonly RelayPeer[],
  context: { order: readonly string[]; known: number; now: number; state: VaultSyncState; log?: (message: string) => void },
) {
  const log = context.log ?? console.log;
  const { state, now } = context;
  let peers = await loadStatuses(ready);
  if (!peers.length) return { moved: 0, renewed: 0 };
  let moved = await transfer(ready, peers, log);
  if (moved) peers = await loadStatuses(ready);
  const alone = context.known > 1 && ready.length <= 1;
  state.aloneSince = alone ? (state.aloneSince ?? now) : null;
  let renewed = 0;
  const isFailed = (identity: string, chain: string, serverId: string) =>
    state.failed.get(`${identity}:${chain}`)?.has(serverId) === true;
  for (const item of planRenewals(peers, context.order, now, state.aloneSince === null ? null : now - state.aloneSince, isFailed)) {
    // By token, not account: a new login must not sit out the wait of the one it replaced.
    const key = `${item.identity}:${item.chain}`;
    if (now < (state.retryAt.get(key) ?? 0)) continue;
    if (!item.serverId) {
      state.failed.delete(key);
      state.retryAt.set(key, now + renewRetryMs);
      continue;
    }
    const markFailed = () => state.failed.set(key, new Set([...(state.failed.get(key) ?? []), item.serverId!]));
    const peer = ready.find((entry) => entry.serverId === item.serverId)!;
    try {
      const result = (await call(peer, "vault.renew", { identity: item.identity }, 180_000)) as { status?: string; failure?: string | null };
      if (result?.status === "renewed" || result?.status === "recovered") {
        renewed++;
        state.retryAt.delete(key);
        state.failed.delete(key);
        log(`[settings-sync] ${item.identity.slice(0, 6)} 토큰 갱신 완료 (${item.serverId.slice(0, 12)})`);
      } else if (result?.status === "rejected") {
        state.retryAt.set(key, now + rejectedRetryMs);
        log(`[settings-sync] ${item.identity.slice(0, 6)} 토큰이 거부되었습니다. 다시 로그인이 필요합니다.`);
      } else if (result?.status !== "not-due") {
        markFailed();
        log(`[settings-sync] ${item.identity.slice(0, 6)} 토큰 갱신 실패 (${item.serverId.slice(0, 12)}): ${result?.status ?? "unknown"} ${result?.failure ?? ""}`.trim());
      }
    } catch (error) {
      markFailed();
      log(`[settings-sync] ${item.identity.slice(0, 6)} 토큰 갱신 요청 실패 (${item.serverId.slice(0, 12)}): ${error instanceof Error ? error.name : "unknown"}`);
    }
  }
  if (renewed) moved += await transfer(ready, await loadStatuses(ready), log);
  return { moved, renewed };
}
