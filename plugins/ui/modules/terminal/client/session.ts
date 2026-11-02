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

const timelinePages = new WeakMap<PaseoApi, Map<string, TimelinePage>>();
const TIMELINE_CACHE_LIMIT = 8;

function cachedTimeline(paseo: PaseoApi, agentId: string | null) {
  if (!agentId) return null;
  const pages = timelinePages.get(paseo);
  if (!pages) return null;
  const page = pages.get(agentId);
  if (!page) return null;
  pages.delete(agentId);
  pages.set(agentId, page);
  return page;
}

function retainTimeline(paseo: PaseoApi, agentId: string, page: TimelinePage) {
  let pages = timelinePages.get(paseo);
  if (!pages) { pages = new Map(); timelinePages.set(paseo, pages); }
  pages.delete(agentId);
  // Cached history must not overwrite a fresher directory status on re-entry.
  pages.set(agentId, { ...page, agent: null });
  if (pages.size > TIMELINE_CACHE_LIMIT) {
    const oldest = pages.keys().next();
    if (!oldest.done) pages.delete(oldest.value);
  }
}

interface TimelineState {
  paseo: PaseoApi;
  agentId: string | null;
  page: TimelinePage | null;
  error: string;
  loading: boolean;
}

function initialTimeline(paseo: PaseoApi, agentId: string | null, enabled = true): TimelineState {
  const page = cachedTimeline(paseo, agentId);
  return { paseo, agentId, page, error: "", loading: Boolean(enabled && agentId && !page) };
}

export function useTimeline(paseo: PaseoApi, agentId: string | null, enabled = true) {
  const [state, setState] = useState(() => initialTimeline(paseo, agentId, enabled));
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setState(current => {
      if (current.paseo !== paseo || current.agentId !== agentId || !current.page)
        return initialTimeline(paseo, agentId, enabled);
      return { ...current, page: { ...current.page, agent: null }, error: enabled ? "" : current.error, loading: false };
    });
    if (!agentId || !enabled) return;
    const selectedAgentId = agentId;
    const agent = paseo.agents.ref(selectedAgentId);
    let disposed = false;
    let generation = 0;
    let subscriptionFailed = false;
    let fetching = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      if (disposed || subscriptionFailed) return;
      if (fetching) { pending = true; return; }
      fetching = true;
      const started = generation;
      try {
        const next = await agent.timeline.refetch({ direction: "tail", limit: 160 });
        if (!disposed && !subscriptionFailed) {
          if (started !== generation) { pending = true; return; }
          if (next.error) throw new Error(next.error);
          retainTimeline(paseo, selectedAgentId, next);
          setState({ paseo, agentId: selectedAgentId, page: next, error: "", loading: false });
        }
      } catch (error) {
        if (!disposed && !subscriptionFailed && started === generation)
          setState(current => ({ ...current, error: message(error), loading: false }));
      }
      finally {
        fetching = false;
        if (!disposed && !subscriptionFailed) {
          if (pending) { pending = false; schedule(); }
        }
      }
    }
    function schedule() {
      if (disposed || subscriptionFailed || timer) return;
      timer = setTimeout(() => { timer = undefined; void refresh(); }, 350);
    }
    const subscription = agent.timeline.subscribe(({ event }) => {
      if (disposed) return;
      if (event.type === "error") {
        subscriptionFailed = true;
        if (timer) { clearTimeout(timer); timer = undefined; }
        setState(current => ({ ...current, error: event.error, loading: false }));
        return;
      }
      if (event.type === "replacement") {
        subscriptionFailed = false;
        generation++;
        timelinePages.get(paseo)?.delete(selectedAgentId);
        setState({ paseo, agentId: selectedAgentId, page: null, error: "", loading: true });
      } else if (event.type === "subscription_restored") {
        subscriptionFailed = false;
        generation++;
      }
      schedule();
    });
    void subscription.ready.then(() => { if (!subscriptionFailed) return refresh(); }).catch((error) => {
      if (!disposed) {
        subscriptionFailed = true;
        setState(current => ({ ...current, error: message(error), loading: false }));
      }
    });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      subscription();
    };
  }, [paseo, agentId, enabled, revision]);
  const current = state.paseo === paseo && state.agentId === agentId ? state : initialTimeline(paseo, agentId, enabled);
  return { page: current.page, error: current.error, loading: current.loading, retry: () => setRevision((value) => value + 1) };
}
