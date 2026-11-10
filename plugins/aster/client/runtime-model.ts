interface Agent {
  provider: string;
  runtimeInfo?: { model?: string | null; extra?: Record<string, unknown> };
}
interface State {
  sessions: Record<string, { agents: Map<string, Agent> } | undefined>;
}
interface Store {
  getState(): State;
  setState(patch: Pick<State, "sessions">): void;
  subscribe(listener: () => void): () => void;
}
interface Registry {
  getSnapshot(): {
    id: string;
    serverId: string;
    lifetime: { signal: { aborted: boolean } };
  }[];
  subscribe(listener: () => void): () => void;
}

export function exactRuntimeModel(agent: Agent): string | null {
  if (agent.provider !== "claude" && !agent.provider.startsWith("claude-"))
    return null;
  const current = agent.runtimeInfo?.model;
  const raw = agent.runtimeInfo?.extra?.runtimeModel;
  if (typeof current !== "string" || typeof raw !== "string") return null;
  const match = raw
    .trim()
    .match(
      /^claude-(mythos|fable|opus|sonnet|haiku)-(\d+)-(\d+)(?:-\d{8})?(?:\[1m\])?$/i,
    );
  if (!match || current !== `claude-${match[1].toLowerCase()}-${match[2]}`)
    return null;
  return `claude-${match[1].toLowerCase()}-${match[2]}-${match[3]}`;
}

// COMPAT(claudeRuntimeModelTruncation): added in v0.3.16, remove after 2027-02-10
// once supported hosts include Core aed40a2f. Only repair a major-only display ID
// from the CLI's explicit runtime model; never infer it from the configured model.
export function installRuntimeModelPresentation(
  store: Store,
  registry: Registry,
) {
  let stopped = false;
  let applying = false;
  const apply = () => {
    if (stopped || applying) return;
    const hosts = new Set(
      registry
        .getSnapshot()
        .filter((p) => p.id === "aster" && !p.lifetime.signal.aborted)
        .map((p) => p.serverId),
    );
    const state = store.getState();
    let sessions = state.sessions;
    for (const host of hosts) {
      const session = state.sessions[host];
      if (!session) continue;
      let agents = session.agents;
      for (const [id, agent] of session.agents) {
        const model = exactRuntimeModel(agent);
        if (!model) continue;
        if (agents === session.agents) agents = new Map(agents);
        agents.set(id, {
          ...agent,
          runtimeInfo: { ...agent.runtimeInfo, model },
        });
      }
      if (agents === session.agents) continue;
      if (sessions === state.sessions) sessions = { ...sessions };
      sessions[host] = { ...session, agents };
    }
    if (sessions === state.sessions) return;
    applying = true;
    try {
      store.setState({ sessions });
    } finally {
      applying = false;
    }
  };
  const off = [store.subscribe(apply), registry.subscribe(apply)];
  try {
    apply();
  } catch (error) {
    off.forEach((stop) => stop());
    throw error;
  }
  // These are in-memory observations from the CLI, with no daemon/config writes.
  return () => {
    stopped = true;
    off.forEach((stop) => stop());
  };
}
