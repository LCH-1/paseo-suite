export interface SharedCredential {
  id: string;
  vendor: "claude";
  providerIds: string[];
  identity: string;
  expiresAt: number | null;
  updatedAt: number;
  credential: Record<string, unknown>;
  metadata: Record<string, unknown>;
}
export interface CredentialOwnership {
  identity: string;
  providerIds: string[];
  record: SharedCredential | null;
  metadata: Record<string, unknown>;
  directory: string;
}
export type CredentialProviders = Record<
  string,
  { enabled?: boolean; env?: Record<string, string>; [key: string]: unknown }
>;
export interface CredentialState {
  providers: CredentialProviders;
  accounts: CredentialOwnership[];
  declined?: string[];
}
export interface SharedAccountStatus {
  identity: string;
  expiresAt: number | null;
  availableExpiresAt?: number | null;
  revision: string | null;
  /** Digests of the refresh tokens held here; the same digest on two hosts is a conflict. */
  chains?: string[];
}
export interface CredentialShareStatus {
  version: 1;
  publicKey: string;
  accounts: SharedAccountStatus[];
  /** This host registers same-owner accounts it has not seen yet. */
  provision?: boolean;
  /** Delivers access tokens only and keeps each refresh token on one host. */
  borrow?: boolean;
  platform?: string;
  /** Accounts signed out here; a relay must never bring them back. */
  declined?: string[];
}
export interface CredentialEnvelope {
  key: string;
  iv: string;
  tag: string;
  payload: string;
}
