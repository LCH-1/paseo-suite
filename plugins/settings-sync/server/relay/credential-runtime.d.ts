import type { SharedCredential, CredentialProviders } from "./credential-types";
export interface CredentialProfile {
  vendor: string;
  providerIds: string[];
  directory: string;
  configDirectory: string;
  env: Record<string, string>;
}
export class ProviderCredentialSync {
  constructor(options: {
    home: string;
    userHome?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    run?: (executable: string, args: string[], input: string) => Promise<string>;
    /** Answers Windows reads from one resident helper; a read it rejects runs as a one-shot process. */
    reader?: { read(target: string): Promise<string> };
    secure?: {
      read(service: string, name: string): Promise<{ value: string; updatedAt: number } | null>;
      write(service: string, name: string, value: string): Promise<void>;
      remove(service: string, name: string): Promise<void>;
    };
  });
  profiles(providers: CredentialProviders): CredentialProfile[];
  record(profile: CredentialProfile): Promise<{ record: SharedCredential | null; store: string }>;
  restore(
    providers: CredentialProviders,
    bundle: { version: 1; records: SharedCredential[] },
    currentProviders: CredentialProviders,
    options?: {
      beforeClaudeWrite?(incoming: SharedCredential): Promise<void>;
      beforeClaudeRegistryWrite?(incoming: SharedCredential, raw: string | null): Promise<void>;
    },
  ): Promise<{
    readonly committed: boolean;
    providers: CredentialProviders;
    commit(): Promise<void>;
    rollback(): Promise<void>;
  }>;
}
export function parseBundle(input: unknown): { version: 1; records: SharedCredential[] };
export const credentialRuntimeVersion: 3;
export function withCredentialLocks<T>(
  storage: ProviderCredentialSync,
  providers: CredentialProviders,
  directories: string[],
  run: () => Promise<T>,
): Promise<T>;
