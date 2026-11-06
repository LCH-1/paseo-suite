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
}
export interface CredentialShareStatus {
  version: 1;
  publicKey: string;
  accounts: SharedAccountStatus[];
  /** This host registers same-owner accounts it has not seen yet. */
  provision?: boolean;
  /** This host can renew a login with the official CLI when the relay asks. */
  refresh?: boolean;
  /** Accounts signed out here; a relay must never bring them back. */
  declined?: string[];
}
export interface CredentialEnvelope {
  key: string;
  iv: string;
  tag: string;
  payload: string;
}
