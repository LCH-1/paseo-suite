import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);
export async function githubToken() {
  try {
    const result = await execute("gh", ["auth", "token", "--hostname", "github.com"], { windowsHide: true, timeout: 10_000, maxBuffer: 16_384 });
    return result.stdout.trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("GitHub CLI가 필요합니다. cli.github.com에서 설치한 후 다시 로그인하세요.");
    if ((error as { code: unknown }).code === 1) return null;
    throw new Error("GitHub 로그인 상태를 읽을 수 없습니다.");
  }
}

export async function githubLogin(token: string, request = fetch) {
  const response = await request("https://api.github.com/user", { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error("GitHub 인증이 만료되었습니다. 다시 로그인하세요.");
  return z.object({ login: z.string() }).parse(await response.json()).login;
}

type Flow = { token?: string; login?: string; code?: string; error?: string; child?: ChildProcessWithoutNullStreams; expires: number; timer?: ReturnType<typeof setTimeout> };
export class GitHubLogin {
  private flows = new Map<string, Flow>();
  constructor(private token = githubToken, private identity = githubLogin, private launch = () => spawn("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key"], { windowsHide: true, stdio: "pipe" })) {}

  private result(id: string, flow: Flow) {
    return { flowId: id, ready: Boolean(flow.token), login: flow.login ?? null, code: flow.code ?? null,
      url: flow.code ? "https://github.com/login/device" : null, expiresIn: Math.max(0, Math.floor((flow.expires - Date.now()) / 1000)) };
  }

  async start(force = false) {
    this.cleanup();
    const id = randomUUID();
    const existing = force ? null : await this.token();
    if (existing) {
      try {
        const flow = { token: existing, login: await this.identity(existing), expires: Date.now() + 15 * 60_000 };
        this.flows.set(id, flow);
        return this.result(id, flow);
      } catch { /* 만료된 기존 인증은 새 브라우저 인증으로 이어진다. */ }
    }
    if ([...this.flows.values()].some((flow) => flow.child && !flow.token && !flow.error)) throw new Error("진행 중인 GitHub 로그인을 먼저 완료하거나 취소하세요.");
    const child = this.launch();
    const flow: Flow = { child, expires: Date.now() + 15 * 60_000 };
    this.flows.set(id, flow);
    return new Promise<ReturnType<GitHubLogin["result"]>>((resolve, reject) => {
      let output = "";
      let settled = false;
      const finish = (error?: string) => {
        if (settled) return;
        settled = true;
        if (error) reject(new Error(error)); else resolve(this.result(id, flow));
      };
      const collect = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-16_384);
        const code = output.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1];
        if (code) { flow.code = code; finish(); }
      };
      child.stdout.on("data", collect); child.stderr.on("data", collect);
      child.on("error", () => { flow.error = "GitHub CLI를 실행할 수 없습니다. 설치 상태를 확인하세요."; finish(flow.error); });
      child.on("close", (code) => {
        if (flow.timer) clearTimeout(flow.timer);
        if (code !== 0) { flow.error = "GitHub 로그인이 취소되었거나 만료되었습니다."; finish(flow.error); return; }
        void this.token().then(async (token) => {
          if (!token) throw new Error("GitHub 인증을 확인하지 못했습니다.");
          flow.login = await this.identity(token); flow.token = token; finish();
        }).catch(() => { flow.error = "GitHub 인증을 확인하지 못했습니다. 다시 로그인하세요."; finish(flow.error); });
      });
      flow.timer = setTimeout(() => { flow.error = "GitHub 로그인 시간이 만료되었습니다."; child.kill(); finish(flow.error); }, 15 * 60_000);
      flow.timer.unref(); child.stdin.end();
    });
  }

  poll(id: string) { const flow = this.get(id); return { ready: Boolean(flow.token), login: flow.login ?? null }; }
  credentials(id: string) {
    const flow = this.get(id);
    if (!flow.token || !flow.login) throw new Error("GitHub 로그인을 먼저 완료하세요.");
    return { token: flow.token, login: flow.login };
  }
  private get(id: string) {
    this.cleanup(); const flow = this.flows.get(id);
    if (!flow) throw new Error("GitHub 로그인을 다시 시작하세요.");
    if (flow.error) throw new Error(flow.error);
    return flow;
  }
  remove(id: string) {
    const flow = this.flows.get(id);
    if (flow?.timer) clearTimeout(flow.timer);
    if (flow?.child && flow.child.exitCode === null) flow.child.kill();
    this.flows.delete(id);
  }
  cleanup() { for (const [id, flow] of this.flows) if (Date.now() >= flow.expires) this.remove(id); }
  dispose() { for (const id of this.flows.keys()) this.remove(id); }
}
