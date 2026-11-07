import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { defineRpc } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { parseBundle } from "./credential-runtime.js";
import { credentialStore } from "./credential-store";
import { DaemonRelay, peerConnections, readPeers, removedPeers, savePeers } from "./daemon-relay";
import { chainOf, digest, refreshTokenOf, withoutRefreshToken } from "./credential-tokens";
import {
  absorbDecision,
  dropFromVault,
  putVault,
  readVault,
  recoverRenewal,
  renewBeforeExpiryMs,
  renewVaultRecord,
  supersedes,
  vaultAllows,
  vaultStatus,
} from "./token-vault";
import { connectPeer } from "./peer-connection";
import type {
  CredentialEnvelope,
  CredentialShareStatus,
  SharedCredential,
  CredentialProviders,
  CredentialState,
} from "./credential-types";

const identity = z.string().regex(/^[a-f0-9]{64}$/);
const envelope = z
  .object({
    key: z.string().max(2048),
    iv: z.string().max(64),
    tag: z.string().max(64),
    payload: z.string().max(3000000),
  })
  .strict();
export { chainOf, withoutRefreshToken };
const newest = (state: CredentialState, identity: string) =>
  state.accounts
    .filter((a) => a.identity === identity && a.record)
    .map((a) => a.record!)
    .sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0) || b.updatedAt - a.updatedAt)[0];
/** The CLI renews a login it reads; its own lock keeps this from racing a running session. */
export function renewWithCli(
  command: readonly string[],
  env: Record<string, string | undefined>,
  run: typeof execFile = execFile,
  platform: NodeJS.Platform = process.platform,
) {
  const [file, ...args] = command;
  const parameters = [...args, "auth", "status"];
  // A .cmd shim or a name npm resolves needs a shell, which joins arguments without quoting them.
  const shell = platform === "win32" && (/\.(cmd|bat)$/i.test(file) || !path.win32.isAbsolute(file));
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  return new Promise<string | null>((resolve) => {
    try {
      run(
        shell ? [file, ...parameters].map(quote).join(" ") : file,
        shell ? [] : parameters,
        { env: env as NodeJS.ProcessEnv, timeout: 40000, windowsHide: true, shell },
        (error) => resolve(error ? String(error.code ?? "failed") : null),
      );
    } catch (error) {
      resolve(String((error as NodeJS.ErrnoException).code ?? "failed"));
    }
  });
}
type ProviderEntry = { command?: string[]; env?: Record<string, string> } | undefined;
const profileVariables = [
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
];
/** Same spelling the sessions use: on Windows the credential entry name is hashed from it. */
export function renewalEnvironment(base: Record<string, string | undefined>, root: ProviderEntry, entry: ProviderEntry) {
  const env = { ...base };
  for (const name of profileVariables) delete env[name];
  return { ...env, ...root?.env, ...entry?.env };
}
/** Runs the CLI against its own folder only, on the same file store on every platform. */
export function vaultRenewalEnvironment(base: Record<string, string | undefined>, configDirectory: string) {
  const env = { ...base };
  for (const name of [...profileVariables, "CLAUDE_CODE_FORCE_WINDOWS_CREDMAN"]) delete env[name];
  return { ...env, CLAUDE_CONFIG_DIR: configDirectory };
}
/** After a restart no client has called in yet, and a login must not wait for one. */
export async function renewalProviders(home: string, api?: PaseoConfigReader): Promise<CredentialProviders> {
  if (api) return (await api.config.get()).config.providers ?? {};
  const config = JSON.parse(await readFile(path.join(home, "config.json"), "utf8")) as {
    agents?: { providers?: CredentialProviders };
  };
  return config.agents?.providers ?? {};
}
/** Local first: a login with this much time left is never replaced by another host's copy. */
const usableMarginMs = 10 * 60_000;
const renewWithinMs = 5 * 60_000;
const renewRetryMs = 10 * 60_000;
// Gives the relay time to clear duplicated refresh tokens before anything renews one.
const renewStartDelayMs = 3 * 60_000;
type PaseoConfigReader = { config: { get(): Promise<{ config: { providers?: CredentialProviders } }> } };
export class CredentialSharing {
  readonly keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
  readonly publicKey = this.keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  constructor(private now = Date.now) {}
  status(state: CredentialState): CredentialShareStatus {
    return {
      version: 1,
      publicKey: this.publicKey,
      provision: true,
      borrow: true,
      platform: process.platform,
      declined: state.declined ?? [],
      accounts: [...new Set(state.accounts.map((a) => a.identity))].map((identity) => {
        const source = newest(state, identity);
        const aliases = state.accounts.filter((a) => a.identity === identity);
        return {
          identity,
          expiresAt: aliases.some((a) => a.record?.expiresAt == null)
            ? null
            : Math.min(...aliases.map((a) => a.record!.expiresAt!)),
          availableExpiresAt: source?.expiresAt ?? null,
          revision: source ? digest(JSON.stringify(source.credential)) : null,
          chains: [...new Set(aliases.flatMap((a) => chainOf(a.record) ?? []))],
        };
      }),
    };
  }
  export(state: CredentialState, publicKey: string, identities: string[]): CredentialEnvelope {
    const newestRecords = identities.map((id) => newest(state, id));
    const records = newestRecords.map((r) => (r ? withoutRefreshToken(r) : r));
    if (
      !records.length ||
      records.some((r) => !r || r.vendor !== "claude" || (r.expiresAt ?? 0) <= this.now() + 60000)
    )
      throw Error("Aster: 갱신된 Claude 인증을 확인할 수 없습니다.");
    return this.seal(records as SharedCredential[], publicKey);
  }
  /** The vault copy, refresh token included; only for another host's vault, never for a profile. */
  exportVaultRecord(record: SharedCredential, publicKey: string) {
    return this.seal([record], publicKey);
  }
  private seal(records: SharedCredential[], publicKey: string): CredentialEnvelope {
    const recipient = createPublicKey(publicKey),
      bits = recipient.asymmetricKeyDetails?.modulusLength;
    if (recipient.asymmetricKeyType !== "rsa" || !bits || bits < 2048 || bits > 4096)
      throw Error("Aster: 지원하지 않는 수신 암호화 키입니다.");
    const key = randomBytes(32),
      iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(digest(publicKey)));
    const payload = Buffer.concat([
      cipher.update(JSON.stringify({ version: 1, records }), "utf8"),
      cipher.final(),
    ]);
    return {
      key: publicEncrypt({ key: recipient, oaepHash: "sha256" }, key).toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      payload: payload.toString("base64"),
    };
  }
  keepUsableUntil() {
    return this.now() + usableMarginMs;
  }
  /** Expired or not: the refresh token in it is what matters. */
  openVaultRecord(value: CredentialEnvelope): SharedCredential {
    const records = this.unseal(value);
    if (records.length !== 1 || records[0].vendor !== "claude" || !refreshTokenOf(records[0]) || typeof records[0].expiresAt !== "number")
      throw Error("Aster: 보관할 Claude 토큰을 확인할 수 없습니다.");
    return records[0];
  }
  private unseal(value: CredentialEnvelope) {
    const key = privateDecrypt(
        { key: this.keys.privateKey, oaepHash: "sha256" },
        Buffer.from(value.key, "base64"),
      ),
      decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
    decipher.setAAD(Buffer.from(digest(this.publicKey)));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return parseBundle(
      JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(value.payload, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      ),
    ).records;
  }
  open(
    value: CredentialEnvelope,
    state: CredentialState,
    options: { allowNew?: boolean } = {},
  ): SharedCredential[] {
    const records = this.unseal(value);
    if (
      !records.length ||
      records.length > 2 ||
      records.some(
        (r) =>
          r.vendor !== "claude" ||
          (r.expiresAt ?? 0) <= this.now() + 60000 ||
          (!options.allowNew && !state.accounts.some((a) => a.identity === r.identity)),
      )
    )
      throw Error("Aster: 이 서버에 등록된 같은 Claude 계정만 갱신할 수 있습니다.");
    return records;
  }
}
export function registerCredentialSharing(
  server: PluginServerContext,
  home: string,
  onChanged: () => void | Promise<void>,
  enabled: () => Promise<boolean> = async () => true,
) {
  const share = new CredentialSharing(),
    store = credentialStore(home);
  let active = true;
  const assertActive = () => {
    if (!active) throw Error("Aster: 해제된 인증 전달 요청입니다.");
  };
  let operation: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = operation.then(async () => {
      assertActive();
      if (!await enabled()) throw Error("Settings Sync: 인증 전달이 비활성화되어 있습니다.");
      assertActive();
      return run();
    });
    operation = next.catch(() => {});
    return next;
  }
  const rpc = <T extends z.ZodType>(name: string, input: T) =>
    defineRpc({ name: name.replace("aster.credentials.", "sync.credentials.") + ".request", input, output: z.unknown() });
  // The official CLI renews a login when it reads one, so an unused account stays alive
  // the way any single-machine login does. Each refresh token lives on one host only.
  let renewApi: (PaseoConfigReader & { config: { patch(input: unknown): Promise<unknown> } }) | undefined;
  const nextRenewal = new Map<string, number>();
  const defaultProfile = path.join(homedir(), ".claude");
  const isDefaultProfile = (directory: string) =>
    process.platform === "win32"
      ? path.resolve(directory).toLowerCase() === path.resolve(defaultProfile).toLowerCase()
      : path.resolve(directory) === path.resolve(defaultProfile);
  const patcher = (paseo: { config: { patch(input: unknown): Promise<unknown> } }, providers: CredentialProviders) => {
    let expected = providers;
    return async (next: CredentialProviders) => {
      assertActive();
      const changes = Object.fromEntries(
        Object.entries(next).filter(([id, value]) => JSON.stringify(value) !== JSON.stringify(expected[id])),
      );
      if (Object.keys(changes).length) await paseo.config.patch({ providers: changes });
      expected = next;
    };
  };
  /** Takes the refresh token out of a profile, so the CLI there can never use it on its own. */
  const stripProfile = async (
    paseo: { config: { patch(input: unknown): Promise<unknown> } },
    providers: CredentialProviders,
    own: CredentialState["accounts"][number],
  ) => {
    const chain = chainOf(own.record);
    const stripped = withoutRefreshToken(own.record!);
    await store.write(
      providers,
      [{ ...stripped, updatedAt: stripped.updatedAt + 1 }],
      patcher(paseo, providers),
      async () => {},
      0,
      (candidate) => chainOf(candidate.record) === chain,
    );
  };
  /**
   * Moves logins into the vault. False only when renewing in the profile still applies: a login
   * outside the vault's care. Waiting for a client counts as handled, because a token found in a
   * profile right after a restart may already be dead, and must not reach the CLI first.
   */
  const absorb = async (own: CredentialState["accounts"][number], providers: CredentialProviders) => {
    if (isDefaultProfile(own.directory)) return false;
    if (!(await readPeers(home, () => {})).length || !(await vaultAllows(home, own.identity))) return false;
    if (!renewApi) return true;
    const held = (await readVault(home)).find((record) => record.identity === own.identity);
    const decision = absorbDecision(own.record!, held);
    if (decision === "absorb") await putVault(home, own.record!);
    await stripProfile(renewApi, providers, own);
    console.log(`[settings-sync] ${own.identity.slice(0, 6)} 로그인을 토큰 보관소로 ${decision === "absorb" ? "옮김" : "정리"}`);
    await onChanged();
    return true;
  };
  const renew = () =>
    serial(async () => {
      const providers = await renewalProviders(home, renewApi);
      const state = await store.read(providers);
      if (state.declined?.length) await dropFromVault(home, state.declined);
      for (const record of await readVault(home, () => {})) await recoverRenewal(home, record);
      for (const record of await readVault(home, () => {})) {
        const own = state.accounts.find((account) => account.identity === record.identity);
        // Renewing revokes the previous access token at once, so a newer one never waits.
        if (renewApi && own && !refreshTokenOf(own.record) && (record.expiresAt ?? 0) > (own.record?.expiresAt ?? 0)) {
          await store.write(providers, [withoutRefreshToken(record)], patcher(renewApi, providers));
          await onChanged();
        }
      }
      for (const own of state.accounts) {
        if (!refreshTokenOf(own.record)) continue;
        if (await absorb(own, providers)) continue;
        if ((own.record?.expiresAt ?? 0) > Date.now() + renewWithinMs) continue;
        if (Date.now() < (nextRenewal.get(own.directory) ?? 0)) continue;
        nextRenewal.set(own.directory, Date.now() + renewRetryMs);
        const entry = providers[own.providerIds[0]] as ProviderEntry;
        const root = providers.claude as ProviderEntry;
        const failure = await renewWithCli(
          entry?.command ?? root?.command ?? ["claude"],
          renewalEnvironment(process.env, root, entry),
        );
        assertActive();
        const after = (await store.read(providers)).accounts.find((a) => a.directory === own.directory);
        if (failure || (after?.record?.expiresAt ?? 0) <= (own.record?.expiresAt ?? 0))
          console.warn(`[settings-sync] Claude 인증을 갱신하지 못했습니다 (${failure ?? "만료 시각 그대로"}). 10분 뒤 다시 시도합니다.`);
        await onChanged();
      }
    }).catch((error) => {
      if (active)
        console.warn("[settings-sync] Claude 인증 갱신 확인에 실패했습니다.", error instanceof Error ? error.name : "");
    });
  let renewTimer: ReturnType<typeof setInterval> | undefined;
  const renewFirst = setTimeout(() => {
    void renew();
    renewTimer = setInterval(() => void renew(), 60_000);
    renewTimer.unref?.();
  }, renewStartDelayMs);
  renewFirst.unref?.();
  // Delivery must not depend on an open app window, only on a daemon being alive.
  const daemonRelay = new DaemonRelay({ home, enabled, connect: connectPeer });
  daemonRelay.start();
  const registrations: unknown[] = [
    server.handle(rpc("aster.credentials.status", z.object({})), async (_, { paseo }) =>
      serial(async () => {
        renewApi = paseo;
        return {
          ...share.status(await store.read((await paseo.config.get()).config.providers ?? {})),
          daemonRelay: await daemonRelay.snapshot(),
          vault: vaultStatus(await readVault(home)),
        };
      }),
    ),
    server.handle(
      rpc("aster.credentials.peers", z.object({ peers: peerConnections, removed: removedPeers.optional() }).strict()),
      async (input) => serial(async () => ({ peers: await savePeers(home, input.peers, { removed: input.removed }) })),
    ),
    server.handle(
      rpc("aster.credentials.vault.export", z.object({ publicKey: z.string().max(8192), identity }).strict()),
      async (input) =>
        serial(async () => {
          const record = (await readVault(home)).find((entry) => entry.identity === input.identity);
          if (!record) throw Error("Settings Sync: 보관된 토큰이 없습니다.");
          return share.exportVaultRecord(record, input.publicKey);
        }),
    ),
    server.handle(rpc("aster.credentials.vault.receive", envelope), async (input, { paseo }) =>
      serial(async () => {
        renewApi = paseo as typeof renewApi;
        const record = share.openVaultRecord(input);
        const providers = (await paseo.config.get()).config.providers ?? {};
        const state = await store.read(providers);
        // A host signed out of this account does not keep its token.
        if (state.declined?.includes(record.identity)) return { changed: false };
        const changed = await putVault(home, record);
        // The access token this host holds stopped working when this one was issued.
        const own = state.accounts.find((account) => account.identity === record.identity);
        if (changed && own && !refreshTokenOf(own.record)) {
          await store
            .write(providers, [withoutRefreshToken(record)], patcher(paseo as NonNullable<typeof renewApi>, providers))
            .then(() => onChanged())
            .catch((error) => console.warn("[settings-sync] 새 토큰을 프로필에 쓰지 못했습니다. 다음 확인에서 다시 시도합니다.", error instanceof Error ? error.name : ""));
        }
        return { changed };
      }),
    ),
    server.handle(
      rpc("aster.credentials.vault.renew", z.object({ identity, force: z.boolean().optional() }).strict()),
      async (input, { paseo }) =>
        serial(async () => {
          renewApi = paseo as typeof renewApi;
          const record = (await readVault(home)).find((entry) => entry.identity === input.identity);
          if (!record) throw Error("Settings Sync: 보관된 토큰이 없습니다.");
          // The second of two leaders asking lands here: the first one has just renewed it.
          if (!input.force && (record.expiresAt ?? 0) > Date.now() + renewBeforeExpiryMs + 60_000) return { status: "not-due" };
          const providers = (await paseo.config.get()).config.providers ?? {};
          const root = providers.claude as ProviderEntry;
          const result = await renewVaultRecord(home, record, (configDirectory) =>
            renewWithCli(root?.command ?? ["claude"], vaultRenewalEnvironment(process.env, configDirectory)),
          );
          assertActive();
          if (result.outcome === "renewed" || result.outcome === "recovered") {
            const state = await store.read(providers);
            if (state.accounts.some((account) => account.identity === input.identity)) {
              await store.write(providers, [withoutRefreshToken(result.record)], patcher(paseo, providers));
              await onChanged();
            }
          } else {
            console.warn(`[settings-sync] ${input.identity.slice(0, 6)} 토큰 갱신 결과: ${result.outcome} ${result.failure ?? ""}`.trim());
          }
          return { status: result.outcome === "recovered" ? "renewed" : result.outcome, failure: result.failure ?? null };
        }),
    ),
    server.handle(
      rpc("aster.credentials.vault.drop", z.object({ identity }).strict()),
      async (input) =>
        serial(async () => {
          await dropFromVault(home, [input.identity]);
          return { dropped: true };
        }),
    ),
    server.handle(
      rpc("aster.credentials.vault.restore", z.object({ identity }).strict()),
      async (input, { paseo }) =>
        serial(async () => {
          // The way back: puts the login into this host's profile, where its CLI renews it again.
          const record = (await readVault(home)).find((entry) => entry.identity === input.identity);
          if (!record) throw Error("Settings Sync: 보관된 토큰이 없습니다.");
          const providers = (await paseo.config.get()).config.providers ?? {};
          const changed = await store.write(
            providers,
            [{ ...record, updatedAt: Date.now() }],
            patcher(paseo, providers),
            async () => {},
            0,
            (candidate) => candidate.identity === input.identity,
          );
          await dropFromVault(home, [input.identity]);
          await onChanged();
          return { changed: changed.length };
        }),
    ),
    server.handle(
      rpc(
        "aster.credentials.export",
        z
          .object({ publicKey: z.string().max(8192), identities: z.array(identity).min(1).max(2) })
          .strict(),
      ),
      async (input, { paseo }) =>
        serial(async () =>
          share.export(
            await store.read((await paseo.config.get()).config.providers ?? {}),
            input.publicKey,
            input.identities,
          ),
        ),
    ),
    server.handle(
      rpc(
        "aster.credentials.release",
        z.object({ identity, chain: z.string().regex(/^[a-f0-9]{32}$/) }).strict(),
      ),
      async (input, { paseo }) =>
        serial(async () => {
          const providers = (await paseo.config.get()).config.providers ?? {},
            state = await store.read(providers),
            owned = state.accounts.filter(
              (a) => a.identity === input.identity && chainOf(a.record) === input.chain,
            );
          if (!owned.length) return { released: 0 };
          const stripped = withoutRefreshToken(owned[0].record!);
          let expected = providers;
          await store.write(
            providers,
            [{ ...stripped, updatedAt: stripped.updatedAt + 1 }],
            async (next) => {
              assertActive();
              const changes = Object.fromEntries(
                Object.entries(next).filter(([id, value]) => JSON.stringify(value) !== JSON.stringify(expected[id])),
              );
              if (Object.keys(changes).length) await paseo.config.patch({ providers: changes });
              expected = next;
            },
            async () => {},
            0,
            (own) => chainOf(own.record) === input.chain,
          );
          await onChanged();
          return { released: owned.length };
        }),
    ),
    server.handle(rpc("aster.credentials.receive", envelope), async (input, { paseo }) =>
      serial(async () => {
        const providers = (await paseo.config.get()).config.providers ?? {},
          state = await store.read(providers),
          opened = share.open(input, state, { allowNew: true }),
          records = opened.filter((r) => state.accounts.some((a) => a.identity === r.identity)),
          unseen = opened.filter((r) => !records.includes(r));
        let current = providers;
        const persist = async (next: typeof providers) => {
          assertActive();
          const changes = Object.fromEntries(
            Object.entries(next).filter(
              ([id, value]) => JSON.stringify(value) !== JSON.stringify(current[id]),
            ),
          );
          const removed = Object.keys(current).filter((id) => !(id in next));
          await paseo.config.patch({ providers: changes, ...(removed.length ? { removeProviders: removed } : {}) });
          current = next;
        };
        let provisioned = 0;
        for (const record of unseen)
          if (await store.provision(current, record, persist)) provisioned++;
        if (provisioned) await onChanged();
        if (!records.length) return { changed: provisioned };
        let expected = providers;
        const ownedIds = state.accounts
          .filter((a) => records.some((r) => r.identity === a.identity))
          .flatMap((a) => a.providerIds);
        const changed = await store
          .write(
            providers,
            records,
            async (next) => {
              assertActive();
              const changes = Object.fromEntries(
                Object.entries(next).filter(
                  ([id, value]) => JSON.stringify(value) !== JSON.stringify(expected[id]),
                ),
              );
              const fresh = (await paseo.config.get()).config.providers ?? {};
              assertActive();
              if (
                Object.keys(changes).some(
                  (id) => JSON.stringify(fresh[id]) !== JSON.stringify(expected[id]),
                )
              )
                throw Error("Aster: 계정 설정이 변경되었습니다. 다음 검사에서 다시 확인합니다.");
              await paseo.config.patch({ providers: changes });
              expected = next;
            },
            async () => {
              assertActive();
              const fresh = (await paseo.config.get()).config.providers ?? {};
              assertActive();
              if (
                ownedIds.some((id) => JSON.stringify(fresh[id]) !== JSON.stringify(providers[id]))
              )
                throw Error("Aster: 계정 설정이 변경되어 인증 전달을 보류합니다.");
            },
            share.keepUsableUntil(),
          )
          .catch(async (error) => {
            if ((error as { credentialCommitted?: boolean })?.credentialCommitted) await onChanged();
            throw error;
          });
        if (changed.length) await onChanged();
        return { changed: changed.length + provisioned };
      }),
    ),
  ];
  return [
    () => {
      active = false;
      daemonRelay.dispose();
      clearTimeout(renewFirst);
      clearInterval(renewTimer);
    },
    ...registrations.filter((remove): remove is () => void => typeof remove === "function"),
  ];
}
