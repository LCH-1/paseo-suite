import { createHash } from "node:crypto";
import type { SharedCredential } from "./credential-types";

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const refreshTokenOf = (record: SharedCredential | null | undefined) => {
  const oauth = record?.credential.claudeAiOauth as { refreshToken?: unknown } | undefined;
  return typeof oauth?.refreshToken === "string" && oauth.refreshToken ? oauth.refreshToken : null;
};
export const chainOf = (record: SharedCredential | null | undefined) => {
  const token = refreshTokenOf(record);
  return token ? digest("chain:" + token).slice(0, 32) : null;
};
/** The credential store refuses fields it does not know, and the vault's marker is one of them. */
export function storeRecord(record: SharedCredential & { vaultOrigin?: unknown }): SharedCredential {
  const { vaultOrigin: _vaultOrigin, ...plain } = record;
  return plain;
}
/** Refresh tokens rotate: a second copy dies on the first renewal and takes that host's login with it. */
export function withoutRefreshToken(record: SharedCredential): SharedCredential {
  const { refreshToken: _refreshToken, ...oauth } = (record.credential.claudeAiOauth ?? {}) as Record<string, unknown>;
  return { ...storeRecord(record), credential: { ...record.credential, claudeAiOauth: oauth } };
}
