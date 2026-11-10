(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PaseoGlobalTabsMetadata = factory();
})(globalThis, function () {
  "use strict";
  const keyOf = (entry) => JSON.stringify([entry.serverId, entry.agentId]);
  function createLoader({
    model,
    sessions,
    getPaseoClient,
    normalizeAgentSnapshot,
  }) {
    let stopped = false;
    let queued = false;
    let running = 0;
    let revision = 0;
    const listeners = new Set();
    const attempts = new Map();
    const connections = new Map();
    const releases = [];
    let sessionMetadata = new Map();
    function onSessionsChanged() {
      const current = sessions.getState().sessions;
      const ids = Object.keys(current);
      const values = ids.map((id) => {
        const session = current[id];
        return [
          session.client,
          session.clientGeneration,
          session.client?.isConnected,
          session.agents,
          session.agentDetails,
          session.workspaces,
        ];
      });
      if (
        ids.length === sessionMetadata.size &&
        ids.every((id, index) => {
          const previous = sessionMetadata.get(id);
          return (
            previous &&
            values[index].every((value, field) => value === previous[field])
          );
        })
      )
        return;
      for (const [index, id] of ids.entries()) {
        const previous = sessionMetadata.get(id);
        if (
          !previous ||
          values[index]
            .slice(0, 3)
            .some((value, field) => value !== previous[field])
        )
          connections.set(id, Symbol());
      }
      for (const id of connections.keys())
        if (!Object.hasOwn(current, id)) connections.delete(id);
      sessionMetadata = new Map(ids.map((id, index) => [id, values[index]]));
      if (pruneAttempts()) notify();
      schedule();
    }
    function notify() {
      revision++;
      listeners.forEach((listener) => listener());
    }
    function sessionFor(entry) {
      return sessions.getState().sessions[entry.serverId];
    }
    function cached(entry) {
      const session = sessionFor(entry);
      return (
        session?.agents.get(entry.agentId) ??
        session?.agentDetails.get(entry.agentId)
      );
    }
    function sameConnection(entry, attempt) {
      const session = sessionFor(entry);
      return (
        session?.client === attempt.client &&
        session?.clientGeneration === attempt.generation &&
        session?.client?.isConnected !== false &&
        connections.get(entry.serverId) === attempt.connection
      );
    }
    function pruneAttempts(entries = model.entries()) {
      if (!attempts.size) return false;
      const retained = new Map(entries.map((entry) => [keyOf(entry), entry]));
      let changed = false;
      for (const [key, attempt] of attempts) {
        const entry = retained.get(key);
        if (!entry || cached(entry) || !sameConnection(entry, attempt)) {
          attempts.delete(key);
          changed = true;
        }
      }
      return changed;
    }
    function currentAttempt(entry, attempt) {
      return (
        attempts.get(keyOf(entry)) === attempt &&
        sameConnection(entry, attempt) &&
        model.entries().some((item) => keyOf(item) === keyOf(entry))
      );
    }
    function onModelChanged() {
      if (pruneAttempts()) notify();
      schedule();
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
      Promise.resolve().then(() => {
        queued = false;
        pump();
      });
    }
    async function fetch(entry, attempt) {
      try {
        const result = await getPaseoClient(entry.serverId)
          .agents.ref(entry.agentId)
          .refresh();
        if (stopped || !currentAttempt(entry, attempt)) return;
        if (!result) {
          attempt.tag = "missing";
          return;
        }
        if (result.agent.id !== entry.agentId) {
          attempt.tag = "mismatch";
          return;
        }
        const agent = {
          ...normalizeAgentSnapshot(result.agent, entry.serverId),
          projectPlacement: result.project,
        };
        if (!cached(entry)) {
          sessions.getState().setAgentDetails(entry.serverId, (previous) => {
            if (previous.has(agent.id)) return previous;
            const next = new Map(previous);
            next.set(agent.id, agent);
            return next;
          });
        }
        model.reconcile(sessions.getState().sessions);
        model.rememberTitle(
          entry.serverId,
          entry.agentId,
          cached(entry)?.title ?? agent.title,
        );
        attempt.tag = "ready";
      } catch (error) {
        if (!stopped && currentAttempt(entry, attempt)) {
          attempt.tag = "error";
          console.warn(
            "[global-workspace-tabs] Agent metadata lookup failed",
            entry.serverId,
            entry.agentId,
            error,
          );
        }
      } finally {
        running--;
        if (!stopped) {
          notify();
          schedule();
        }
      }
    }
    function pump() {
      if (stopped || typeof getPaseoClient !== "function") return;
      model.reconcile(sessions.getState().sessions);
      const entries = model.entries();
      if (pruneAttempts(entries)) notify();
      for (const entry of entries) {
        const agent = cached(entry);
        if (agent) {
          if (entry.title !== agent.title)
            model.rememberTitle(entry.serverId, entry.agentId, agent.title);
          continue;
        }
        const session = sessionFor(entry);
        if (!session?.client || session.client.isConnected === false) continue;
        const existing = attempts.get(keyOf(entry));
        if (existing && sameConnection(entry, existing)) continue;
        if (running >= 4) break;
        const attempt = {
          tag: "loading",
          client: session.client,
          generation: session.clientGeneration,
          connection: connections.get(entry.serverId),
        };
        attempts.set(keyOf(entry), attempt);
        running++;
        notify();
        void fetch(entry, attempt);
      }
    }
    releases.push(
      model.subscribe(onModelChanged),
      sessions.subscribe(onSessionsChanged),
    );
    onSessionsChanged();
    return {
      state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      revision: () => revision,
      dispose() {
        stopped = true;
        releases.forEach((release) => release());
        listeners.clear();
        attempts.clear();
        connections.clear();
        sessionMetadata.clear();
      },
    };
  }
  return { createLoader };
});
