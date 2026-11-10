import type { CredentialProviders } from "./credential-types";

/** The part of a daemon's agent snapshot that tells whether it is using its login right now. */
export interface AgentActivity {
  provider: string;
  status: string;
  activeTurn?: unknown;
}
export interface AgentReader {
  agents: {
    list(options: {
      includeBackground?: boolean;
      filter?: { statuses?: ("initializing" | "running")[] };
      page?: { limit: number };
      timeout?: number;
    }): Promise<{ entries: { agent: AgentActivity }[] }>;
  };
  config: { get(): Promise<{ config: { providers?: CredentialProviders } }> };
}

/** A provider built on another one runs that one's CLI. */
export function providerFamily(id: string, providers: CredentialProviders) {
  const seen = new Set<string>();
  while (!seen.has(id)) {
    seen.add(id);
    const parent = providers[id]?.extends;
    if (typeof parent !== "string" || !parent) return id;
    id = parent;
  }
  return id;
}

/**
 * Claude agents mid-turn on this host. Accounts are not told apart: an agent's account is picked
 * when its session opens, and an account router may give any Claude agent any account, so each
 * one counts against every account this host uses. A session still starting counts as well,
 * because its first turn follows at once.
 */
export function runningClaudeAgents(agents: readonly AgentActivity[], providers: CredentialProviders) {
  return agents.filter(
    (agent) =>
      (agent.status === "running" || agent.status === "initializing" || !!agent.activeTurn) &&
      providerFamily(agent.provider, providers) === "claude",
  ).length;
}

const activityTimeoutMs = 5_000;
/**
 * Read only when a renewal is near. Says nothing when the daemon does not answer in time, so a
 * slow list never holds up the status that token delivery itself depends on.
 */
export async function readClaudeActivity(paseo: AgentReader): Promise<{ claudeRunning?: number }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), activityTimeoutMs);
  });
  const live = (includeBackground: boolean) =>
    paseo.agents.list({
      ...(includeBackground ? { includeBackground } : {}),
      filter: { statuses: ["initializing", "running"] },
      page: { limit: 200 },
      timeout: activityTimeoutMs,
    });
  try {
    const answer = await Promise.race([
      // Background helpers spend the same login, but a daemon too old to list them still lists the rest.
      Promise.all([live(true).catch(() => live(false)), paseo.config.get()]),
      late,
    ]);
    if (!answer) return {};
    const [{ entries }, { config }] = answer;
    return { claudeRunning: runningClaudeAgents(entries.map((entry) => entry.agent), config.providers ?? {}) };
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}
