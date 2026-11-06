import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { execFile } from "node:child_process";
import { defineRpc } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { parseBundle } from "./credential-runtime.js";
import { credentialStore } from "./credential-store";
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
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const refreshTokenOf = (record: SharedCredential | null | undefined) => {
  const oauth = record?.credential.claudeAiOauth as { refreshToken?: unknown } | undefined;
  return typeof oauth?.refreshToken === "string" && oauth.refreshToken ? oauth.refreshToken : null;
};
export const chainOf = (record: SharedCredential | null | undefined) => {
  const token = refreshTokenOf(record);
  return token ? digest("chain:" + token).slice(0, 32) : null;
};
/** Refresh tokens rotate: a second copy dies on the first renewal and takes that host's login with it. */
export function withoutRefreshToken(record: SharedCredential): SharedCredential {
  const { refreshToken: _refreshToken, ...oauth } = (record.credential.claudeAiOauth ?? {}) as Record<string, unknown>;
  return { ...record, credential: { ...record.credential, claudeAiOauth: oauth } };
}
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
) {
  const [file, ...args] = command;
  return new Promise<void>((resolve) => {
    run(
      file,
      [...args, "auth", "status"],
      {
        env: env as NodeJS.ProcessEnv,
        timeout: 40000,
        windowsHide: true,
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(file),
      },
      () => resolve(),
    );
  });
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
    const recipient = createPublicKey(publicKey),
      bits = recipient.asymmetricKeyDetails?.modulusLength;
    if (recipient.asymmetricKeyType !== "rsa" || !bits || bits < 2048 || bits > 4096)
      throw Error("Aster: 지원하지 않는 수신 암호화 키입니다.");
    const newestRecords = identities.map((id) => newest(state, id));
    const records = newestRecords.map((r) => (r ? withoutRefreshToken(r) : r));
    if (
      !records.length ||
      records.some((r) => !r || r.vendor !== "claude" || (r.expiresAt ?? 0) <= this.now() + 60000)
    )
      throw Error("Aster: 갱신된 Claude 인증을 확인할 수 없습니다.");
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
  open(
    value: CredentialEnvelope,
    state: CredentialState,
    options: { allowNew?: boolean } = {},
  ): SharedCredential[] {
    const key = privateDecrypt(
        { key: this.keys.privateKey, oaepHash: "sha256" },
        Buffer.from(value.key, "base64"),
      ),
      decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
    decipher.setAAD(Buffer.from(digest(this.publicKey)));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    const records = parseBundle(
      JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(value.payload, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      ),
    ).records;
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
  let renewApi: PaseoConfigReader | undefined;
  const nextRenewal = new Map<string, number>();
  const renew = () =>
    serial(async () => {
      if (!renewApi) return;
      const providers = (await renewApi.config.get()).config.providers ?? {};
      const state = await store.read(providers);
      for (const own of state.accounts) {
        if (!refreshTokenOf(own.record) || (own.record?.expiresAt ?? 0) > Date.now() + renewWithinMs) continue;
        if (Date.now() < (nextRenewal.get(own.directory) ?? 0)) continue;
        nextRenewal.set(own.directory, Date.now() + renewRetryMs);
        const entry = providers[own.providerIds[0]] as { command?: string[]; env?: Record<string, string> } | undefined;
        const root = providers.claude as { command?: string[]; env?: Record<string, string> } | undefined;
        await renewWithCli(entry?.command ?? root?.command ?? ["claude"], {
          ...process.env,
          ...root?.env,
          ...entry?.env,
          CLAUDE_CONFIG_DIR: own.directory,
          CLAUDE_SECURESTORAGE_CONFIG_DIR: own.directory,
        });
        assertActive();
        await onChanged();
      }
    }).catch(() => {});
  const renewFirst = setTimeout(() => void renew(), renewStartDelayMs);
  const renewTimer = setInterval(() => void renew(), 60_000);
  renewFirst.unref?.();
  renewTimer.unref?.();
  const registrations: unknown[] = [
    server.handle(rpc("aster.credentials.status", z.object({})), async (_, { paseo }) =>
      serial(async () => {
        renewApi = paseo;
        return (
        share.status(await store.read((await paseo.config.get()).config.providers ?? {}))
        );
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
      clearTimeout(renewFirst);
      clearInterval(renewTimer);
    },
    ...registrations.filter((remove): remove is () => void => typeof remove === "function"),
  ];
}
