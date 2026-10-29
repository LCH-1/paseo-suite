import { settings, settingsMethods, settingsSchema } from "../shared/settings";
import type { AgentTabTitleRegistration, TitleSyncClient } from "./sdk-extension";
import { resolveSidebarTitle } from "./title-resolver";
import { ProjectTitleCache } from "./project-title-cache";

export interface TitleSyncState {
  readonly supported: boolean;
  readonly status: "loading" | "ready" | "error";
  readonly enabled: boolean;
  readonly saving: boolean;
  readonly error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "설정을 불러오지 못했습니다.";
}

export class TitleSyncController {
  private state: TitleSyncState;
  private readonly listeners = new Set<() => void>();
  private revision: string | null = null;
  private registration: AgentTabTitleRegistration | null = null;
  private observation: ReturnType<TitleSyncClient["paseo"]["observeEvents"]> | null = null;
  private unsubscribe: (() => void) | null = null;
  private observationError: string | null = null;
  private stopped = false;
  private started = false;
  private refreshTask: Promise<void> | null = null;
  private refreshAgain = false;
  private readonly projectTitles: ProjectTitleCache;

  constructor(private readonly client: TitleSyncClient) {
    this.projectTitles = new ProjectTitleCache(client.paseo.workspaces, () => this.registration?.invalidate());
    this.state = {
      supported: typeof client.addAgentTabTitleResolver === "function",
      status: "loading", enabled: false, saving: false, error: null,
    };
  }

  getSnapshot = (): TitleSyncState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.reload();
  }

  private ensureObservation(): void {
    if (this.observation || this.stopped) return;
    try {
      const observation = this.client.paseo.observeEvents(["status.plugin_settings_changed"]);
      this.observation = observation;
      const restored = () => {
        if (this.stopped || this.observation !== observation) return;
        const previous = this.observationError;
        this.observationError = null;
        if (previous && this.state.error === previous) this.publish({ error: null });
      };
      const failed = (error: unknown) => {
        if (this.stopped || this.observation !== observation) return;
        this.observation = null;
        this.unsubscribe?.();
        this.unsubscribe = null;
        void observation.release().catch(() => {});
        this.observationError = errorMessage(error);
        this.publish({ error: this.observationError });
      };
      const unsubscribe = observation.subscribe({
        snapshot: () => {
          if (this.stopped || this.observation !== observation) return;
          restored();
          void this.reload();
        },
        update: (message) => {
          if (this.stopped || this.observation !== observation) return;
          if (message.type === "status" && message.payload.status === "plugin_settings_changed"
            && message.payload.settingsId === settings.id) void this.reload();
        },
        error: failed,
      });
      if (this.observation === observation) this.unsubscribe = unsubscribe;
      else unsubscribe();
      void observation.ready.then(restored, failed);
    } catch (error) {
      const observation = this.observation;
      this.observation = null;
      this.unsubscribe?.();
      this.unsubscribe = null;
      void observation?.release().catch(() => {});
      this.observationError = errorMessage(error);
      this.publish({ error: this.observationError });
    }
  }

  reload = (): Promise<void> => {
    if (this.stopped) return Promise.resolve();
    if (this.started) this.ensureObservation();
    this.refreshAgain = true;
    if (this.refreshTask) return this.refreshTask;
    this.refreshTask = this.readPending().finally(() => {
      this.refreshTask = null;
      if (this.refreshAgain && !this.stopped) return this.reload();
    });
    return this.refreshTask;
  };

  private async readPending(): Promise<void> {
    while (this.refreshAgain && !this.stopped) {
      this.refreshAgain = false;
      try {
        const result = await this.client.rpc(settingsMethods.read, {});
        if (this.stopped) return;
        if (result.status !== "ready") throw new Error(result.error);
        const parsed = settingsSchema.parse(result.values);
        this.revision = result.revision;
        this.applyEnabled(parsed.enabled);
        this.publish({ status: "ready", enabled: parsed.enabled, error: this.observationError });
      } catch (error) {
        if (!this.stopped) this.publish({ status: "error", error: errorMessage(error) });
      }
    }
  }

  setEnabled = async (enabled: boolean): Promise<void> => {
    if (this.stopped || !this.state.supported || this.state.saving || this.state.status !== "ready"
      || this.revision === null || enabled === this.state.enabled) return;
    this.publish({ saving: true, error: null });
    try {
      const result = await this.client.rpc(settingsMethods.write, {
        revision: this.revision, values: { schemaVersion: 1, enabled },
      });
      if (this.stopped) return;
      if (result.status !== "saved") throw new Error(result.error);
      // Re-read after the write so an older in-flight read cannot reinstate stale settings.
      await this.reload();
    } catch (error) {
      if (!this.stopped) {
        await this.reload();
        this.publish({ error: errorMessage(error) });
      }
    } finally {
      if (!this.stopped) this.publish({ saving: false });
    }
  };

  stop = (): void => {
    if (this.stopped) return;
    this.stopped = true;
    this.registration?.remove();
    this.registration = null;
    this.projectTitles.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
    void this.observation?.release().catch(() => {});
    this.observation = null;
    this.listeners.clear();
  };

  private applyEnabled(enabled: boolean): void {
    if (!this.state.supported) return;
    if (!enabled) {
      this.registration?.remove();
      this.registration = null;
      this.projectTitles.stop();
      return;
    }
    if (!this.registration) {
      this.registration = this.client.addAgentTabTitleResolver!({
        id: "sidebar-title", resolve: (context) => resolveSidebarTitle(context, this.projectTitles.get(context.workspaceId)),
      });
    } else this.registration.invalidate();
    this.projectTitles.start();
  }

  private publish(next: Partial<TitleSyncState>): void {
    if (this.stopped) return;
    this.state = { ...this.state, ...next };
    this.listeners.forEach((listener) => listener());
  }
}
