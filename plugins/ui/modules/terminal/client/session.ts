import type { PaseoAgent, PaseoApi } from "./paseo";
import { useCallback, useEffect, useRef, useState } from "react";

export function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function useDirectory(paseo: PaseoApi) {
  const [agents, setAgents] = useState<PaseoAgent[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const changes = useRef<Map<string, PaseoAgent | null> | null>(null);
  const retries = useRef(0);
  const releasing = useRef<Promise<void> | null>(null);
  const upsert = useCallback((agent: PaseoAgent) => {
    changes.current?.set(agent.id, agent.archivedAt ? null : agent);
    setAgents((current) => agent.archivedAt
      ? current.filter((item) => item.id !== agent.id)
      : current.some((item) => item.id === agent.id)
        ? current.map((item) => item.id === agent.id ? agent : item)
        : [...current, agent]);
  }, []);
  const reload = useCallback(() => {
    retries.current = 0;
    setRevision((value) => value + 1);
  }, []);
  useEffect(() => {
    let disposed = false;
    let version = 0;
    let subscription: NonNullable<Awaited<ReturnType<PaseoApi["agents"]["list"]>>["subscription"]> | undefined;
    let unsubscribeSnapshot: (() => void) | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const bootstrapChanges = new Map<string, PaseoAgent | null>();
    changes.current = bootstrapChanges;
    setLoading(true);

    function failed(error: unknown) {
      if (disposed) return;
      setError(message(error));
      setLoading(false);
      if (retryTimer || retries.current >= 3) return;
      const delay = [500, 1500, 4000][retries.current++];
      retryTimer = setTimeout(() => setRevision((value) => value + 1), delay);
    }

    async function readSnapshot(first: Awaited<ReturnType<PaseoApi["agents"]["list"]>>, updates: Map<string, PaseoAgent | null>) {
      const currentVersion = ++version;
      changes.current = updates;
      try {
        const found = new Map<string, PaseoAgent>();
        const cursors = new Set<string>();
        let page = first;
        while (!disposed && currentVersion === version) {
          for (const { agent } of page.entries) if (!agent.archivedAt) found.set(agent.id, agent);
          const cursor = page.pageInfo.nextCursor;
          if (!cursor) break;
          if (cursors.has(cursor)) throw new Error("세션 목록의 다음 페이지 정보가 올바르지 않습니다.");
          cursors.add(cursor);
          page = await paseo.agents.list({ scope: "active", page: { limit: 100, cursor } });
        }
        if (disposed || currentVersion !== version) return;
        for (const [id, agent] of updates) {
          if (agent) found.set(id, agent);
          else found.delete(id);
        }
        changes.current = null;
        retries.current = 0;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
        setAgents([...found.values()]); setError(""); setLoading(false);
      } catch (error) {
        if (currentVersion === version) failed(error);
      }
    }
    const unsubscribe = paseo.agents.subscribe((update) => {
      if (disposed) return;
      if (update.kind === "upsert") upsert(update.agent);
      else {
        changes.current?.set(update.agentId, null);
        setAgents((current) => current.filter((item) => item.id !== update.agentId));
      }
    });
    const previousRelease = releasing.current;
    const opening = (async () => {
      try {
        await previousRelease;
        if (disposed) return;
        const first = await paseo.agents.list({ scope: "active", subscribe: {}, page: { limit: 100 } });
        if (disposed) { await first.subscription.release(); return; }
        subscription = first.subscription;
        let firstSnapshot = true;
        unsubscribeSnapshot = subscription.subscribe({
          snapshot(snapshot) {
            if (disposed) return;
            const updates = firstSnapshot ? bootstrapChanges : new Map<string, PaseoAgent | null>();
            firstSnapshot = false;
            void readSnapshot(snapshot, updates);
          },
          // The SDK forwards owned updates to agents.subscribe before this observer.
          update() {},
          error(error) { if (!disposed) { version++; failed(error); } },
        });
      } catch (error) { failed(error); }
    })();
    return () => {
      disposed = true;
      version++;
      changes.current = null;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
      unsubscribeSnapshot?.();
      const release = opening.then(() => subscription?.release()).then(() => {}).catch(() => {});
      releasing.current = release;
      void release.finally(() => { if (releasing.current === release) releasing.current = null; });
    };
  }, [paseo, revision, upsert]);
  return { agents, error, loading, refresh: reload, upsert };
}

export type TimelinePage = Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["refetch"]>>;

export function useTimeline(paseo: PaseoApi, agentId: string | null) {
  const [page, setPage] = useState<TimelinePage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setPage(null); setError("");
    if (!agentId) { setLoading(false); return; }
    const agent = paseo.agents.ref(agentId);
    let disposed = false;
    let fetching = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      if (disposed) return;
      if (fetching) { pending = true; return; }
      fetching = true;
      try {
        const next = await agent.timeline.refetch({ direction: "tail", limit: 160 });
        if (!disposed) {
          if (next.error) throw new Error(next.error);
          setPage(next); setError("");
        }
      } catch (error) { if (!disposed) setError(message(error)); }
      finally {
        fetching = false;
        if (!disposed) {
          setLoading(false);
          if (pending) { pending = false; schedule(); }
        }
      }
    }
    function schedule() {
      if (disposed || timer) return;
      timer = setTimeout(() => { timer = undefined; void refresh(); }, 350);
    }
    setLoading(true);
    const subscription = agent.timeline.subscribe(({ event }) => {
      if (event.type === "error") { if (!disposed) setError(event.error); }
      else schedule();
    });
    void subscription.ready.then(() => refresh()).catch((error) => {
      if (!disposed) { setError(message(error)); setLoading(false); }
    });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      subscription();
    };
  }, [paseo, agentId, revision]);
  return { page, error, loading, retry: () => setRevision((value) => value + 1) };
}
