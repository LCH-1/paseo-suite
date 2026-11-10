import { EventEmitter } from "node:events";
import type { WindowsCredentialReaderProcess } from "../../server/windows-credential-reader";

type HelperRequest = { id: number; operation: string; target: string };
type Respond = (request: HelperRequest, entries: Map<string, string>) => string | null;

const encoded = (value: string) => ({ value: Buffer.from(value, "utf8").toString("base64"), updatedAt: 1_700_000_000_000, persistence: 3 });
/** What the real helper prints for a request, one line each. */
export const helperReply: Respond = ({ id, target }, entries) =>
  JSON.stringify({ id, ok: true, result: entries.has(target) ? encoded(entries.get(target)!) : null }) + "\n";

export class FakeHelperProcess extends EventEmitter implements WindowsCredentialReaderProcess {
  readonly requests: HelperRequest[] = [];
  readonly stdout = new EventEmitter();
  readonly stderr = { resume() {} };
  readonly stdin = Object.assign(new EventEmitter(), {
    write: (line: string) => {
      const request = JSON.parse(line) as HelperRequest;
      this.requests.push(request);
      const reply = this.respond(request, this.entries);
      if (reply !== null) setImmediate(() => this.killed || this.stdout.emit("data", Buffer.from(reply)));
    },
  });
  killed = false;
  constructor(private entries: Map<string, string>, private respond: Respond) {
    super();
  }
  kill() {
    if (this.killed) return false;
    this.killed = true;
    setImmediate(() => this.emit("close"));
    return true;
  }
}

/**
 * A synthetic Windows credential store: the resident helper and the one-shot process read the same
 * entries, and every process either of them would start is counted.
 */
export function syntheticCredentialHost(respond: Respond = helperReply) {
  const entries = new Map<string, string>();
  const helpers: FakeHelperProcess[] = [];
  const oneShots: { operation: string; target: string }[] = [];
  return {
    entries,
    helpers,
    oneShots,
    spawn: () => {
      const helper = new FakeHelperProcess(entries, respond);
      helpers.push(helper);
      return helper;
    },
    run: async (_executable: string, _args: string[], input: string) => {
      const request = JSON.parse(input) as { operation: string; target: string; value?: string };
      oneShots.push({ operation: request.operation, target: request.target });
      if (request.operation === "read") return entries.has(request.target) ? JSON.stringify(encoded(entries.get(request.target)!)) : "null";
      if (request.operation === "delete") entries.delete(request.target);
      else entries.set(request.target, Buffer.from(request.value!, "base64").toString("utf8"));
      return "";
    },
  };
}
