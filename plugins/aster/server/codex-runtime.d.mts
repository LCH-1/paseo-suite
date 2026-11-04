import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { CodexWindow } from "./codex-policy";
export interface CodexTokens {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: string | null;
  expiresAt: number | null;
}
export function codexCommand(
  command: string[],
  args?: string[],
  platform?: NodeJS.Platform,
): [string, string[]];
export function codexTokens(
  home: string,
  expectedIdentity?: string,
): Promise<CodexTokens>;
export class CodexAccountClient {
  constructor(
    command: string[],
    home: string,
    options?: { env?: NodeJS.ProcessEnv; timeout?: number },
  );
  child: ChildProcessWithoutNullStreams;
  request(method: string, params?: unknown): Promise<unknown>;
  initialize(): Promise<void>;
  close(): void;
}
export function inspectCodexAccount(
  command: string[],
  home: string,
  expectedIdentity?: string,
  refresh?: boolean,
): Promise<{
  tokens: CodexTokens;
  plan: string;
  allowed: boolean | null;
  blocked: boolean;
  windows: CodexWindow[];
}>;
export function refreshCodexTokens(
  command: string[],
  home: string,
  expectedIdentity: string,
): Promise<CodexTokens>;
