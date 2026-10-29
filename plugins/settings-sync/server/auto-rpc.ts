import type { AutoStatus } from "../shared/automation";
import type { AutoSync } from "./automation";

type Result = Awaited<ReturnType<AutoSync["tick"]>>;
type Flight = { clientId: string; status: AutoStatus; task: Promise<Result> };

// Paseo 0.12 closes an invoke after 30s. The transaction continues under its
// existing serial queue; durable pending operations are delivered on the next poll.
export class AutoSyncRpc {
  private running: Flight | null = null;
  constructor(private readStatus: () => Promise<AutoStatus>, private waitMs = 20_000) {}

  private progress(status: AutoStatus): AutoStatus {
    return { ...status, state: "syncing", message: "자동 동기화를 처리하고 있습니다. 완료되면 다음 조회에 결과를 반영합니다." };
  }

  status() {
    return this.running ? Promise.resolve(this.progress(this.running.status)) : this.readStatus();
  }

  async tick(clientId: string, action: () => Promise<Result>, forced = false): Promise<Result> {
    const started = Date.now();
    let ownsFlight = false;
    if (forced && this.running) throw new Error("다른 동기화를 처리하고 있습니다. 완료 후 사용할 환경을 선택하세요.");
    if (!this.running) {
      const status = await this.readStatus();
      if (forced && this.running) throw new Error("다른 동기화를 처리하고 있습니다. 완료 후 사용할 환경을 선택하세요.");
      if (!this.running) {
        const flight: Flight = { clientId, status: structuredClone(status), task: Promise.resolve({ status, operation: null }) };
        flight.task = Promise.resolve().then(action).finally(() => { if (this.running === flight) this.running = null; });
        this.running = flight;
        ownsFlight = true;
      }
    }
    const flight = this.running;
    const pending = { status: this.progress(flight.status), operation: null };
    // A shared browser identity can have multiple windows with different captures.
    // Only the request that captured the action's input may consume its operation.
    if (!ownsFlight || flight.clientId !== clientId) return pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([flight.task, new Promise<Result>(resolve => { timer = setTimeout(() => resolve(pending), Math.max(0, this.waitMs - (Date.now() - started))); })]);
    } finally { clearTimeout(timer); }
  }
}
