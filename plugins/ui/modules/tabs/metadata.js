(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PaseoGlobalTabsMetadata = factory();
})(globalThis, function () {
  "use strict";
  const keyOf = (entry) => JSON.stringify([entry.serverId, entry.agentId]);
  function createLoader({ model, sessions, getPaseoClient, normalizeAgentSnapshot }) {
    let stopped = false;
    let queued = false;
    let running = 0;
    let revision = 0;
    const listeners = new Set();
    const attempts = new Map();
    const releases = [];
    function notify() {
      revision++;
      listeners.forEach((listener) => listener());
    }
    function sessionFor(entry) { return sessions.getState().sessions[entry.serverId]; }
    function cached(entry) {
      const session = sessionFor(entry);
      return session?.agents.get(entry.agentId) ?? session?.agentDetails.get(entry.agentId);
    }
    function sameConnection(entry, attempt) {
      const session = sessionFor(entry);
      return session?.client === attempt.client && session?.clientGeneration === attempt.generation;
    }
    function state(entry) {
      const agent = cached(entry);
      if (agent) return { tag: "ready", title: agent.title };
      const attempt = attempts.get(keyOf(entry));
      if (attempt && sameConnection(entry, attempt)) return attempt;
      return { tag: "waiting" };
    }
    function schedule() {
      if (stopped || queued) return;
      queued = true;
      Promise.resolve().then(() => { queued = false; pump(); });
    }
    async function fetch(entry, attempt) {
      try {
        const result = await getPaseoClient(entry.serverId).agents.ref(entry.agentId).refresh();
        if (stopped || !sameConnection(entry, attempt)) return;
        if (!result) {
          attempt.tag = "missing";
          return;
        }
        if (result.agent.id !== entry.agentId) {
          attempt.tag = "mismatch";
          return;
        }
        const agent = { ...normalizeAgentSnapshot(result.agent, entry.serverId), projectPlacement: result.project };
        if (!cached(entry)) {
          sessions.getState().setAgentDetails(entry.serverId, (previous) => {
            if (previous.has(agent.id)) return previous;
            const next = new Map(previous);
            next.set(agent.id, agent);
            return next;
          });
        }
        model.reconcile(sessions.getState().sessions);
        model.rememberTitle(entry.serverId, entry.agentId, cached(entry)?.title ?? agent.title);
        attempt.tag = "ready";
      } catch (error) {
        if (!stopped && sameConnection(entry, attempt)) {
          attempt.tag = "error";
          console.warn("[global-workspace-tabs] Agent metadata lookup failed", entry.serverId, entry.agentId, error);
        }
      } finally {
        running--;
        if (!stopped) { notify(); schedule(); }
      }
    }
    function pump() {
      if (stopped || typeof getPaseoClient !== "function") return;
      model.reconcile(sessions.getState().sessions);
      for (const entry of model.entries()) {
        const agent = cached(entry);
        if (agent) {
          model.rememberTitle(entry.serverId, entry.agentId, agent.title);
          continue;
        }
        const session = sessionFor(entry);
        if (!session?.client || session.client.isConnected === false) continue;
        const existing = attempts.get(keyOf(entry));
        if (existing && sameConnection(entry, existing)) continue;
        if (running >= 4) break;
        const attempt = { tag: "loading", client: session.client, generation: session.clientGeneration };
        attempts.set(keyOf(entry), attempt);
        running++;
        notify();
        void fetch(entry, attempt);
      }
    }
    releases.push(model.subscribe(schedule), sessions.subscribe(schedule));
    schedule();
    return {
      state,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      revision: () => revision,
      dispose() {
        stopped = true;
        releases.forEach((release) => release());
        listeners.clear();
        attempts.clear();
      },
    };
  }
  return { createLoader };
});
