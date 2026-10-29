import { z } from "zod";
import { MAX_BYTES } from "../shared/model";
import { freshGitHubGet } from "./fresh-github-get";

export const GIST_DESCRIPTION = "Paseo Nest · encrypted settings · v1";
export const GIST_FILENAME = "paseo-nest.encrypted.json";
export const REVISION_FILENAME = "paseo-nest.revision.json";
const revisionSchema = z.object({ version: z.literal(1), parents: z.array(z.string().regex(/^[a-f0-9]+:[a-zA-Z0-9]+$/)).max(100).refine((parents) => new Set(parents).size === parents.length) });
const metadata = z.object({ id: z.string().regex(/^[a-f0-9]+$/), public: z.boolean(), description: z.string().nullable(),
  created_at: z.string(), owner: z.object({ login: z.string() }), files: z.record(z.string(), z.object({ filename: z.string() })) });
export class GitHubError extends Error {
  constructor(public status: number) { super(status >= 500 ? `GitHub가 일시적으로 응답하지 않습니다 (${status}). 연결을 유지하고 자동으로 다시 시도합니다.` : `GitHub 요청 실패 (${status}). GitHub 로그인과 Gist 권한을 확인하세요.`); }
}
export class GitHubConflictError extends Error {
  constructor() { super("여러 기기에서 같은 백업을 동시에 변경했습니다. ‘이 PC 사용’ 또는 ‘클라우드 사용’으로 사용할 환경을 선택하세요. 이전 백업은 모두 보존했습니다."); }
}
type GistMetadata = z.infer<typeof metadata>;
type Remote = { sha: string | null; raw: string | null; conflicts?: string[] };

export class GitHubVault {
  private login: string | null = null;
  constructor(private token: string, private request = fetch, private fresh = request === fetch ? freshGitHubGet : undefined) {}

  private async get(url: string | URL, init: RequestInit) {
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(init.headers);
      if (attempt) headers.set("Connection", "close");
      const response = await this.request(url, { ...init, headers, signal: AbortSignal.timeout(25_000) });
      if (![502, 503, 504].includes(response.status) || attempt >= 2) return response;
      await response.body?.cancel();
      if (attempt === 0 && this.fresh) {
        try {
          const isolated = await this.fresh(url, init);
          if (![502, 503, 504].includes(isolated.status)) return isolated;
          await isolated.body?.cancel();
        } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }

  private async api(path: string, method = "GET", body?: unknown) {
    const init = {
      method, redirect: "error", signal: AbortSignal.timeout(25_000),
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    } satisfies RequestInit;
    const response = method === "GET" ? await this.get(`https://api.github.com${path}`, init) : await this.request(`https://api.github.com${path}`, init);
    if (!response.ok) throw new GitHubError(response.status);
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_BYTES * 2) throw new Error("GitHub 응답 크기 제한을 초과했습니다.");
    return JSON.parse(text);
  }

  async verify() {
    this.login = z.object({ login: z.string() }).parse(await this.api("/user")).login;
    return this.login;
  }

  private async discover() {
    const login = this.login ?? await this.verify();
    const candidates: GistMetadata[] = [];
    let latest: Awaited<ReturnType<GitHubVault["detail"]>> | null = null;
    let anchors: Set<string> | null = null;
    for (let page = 1; ; page++) {
      const entries = z.array(metadata).parse(await this.api(`/gists?per_page=100&page=${page}`));
      candidates.push(...entries.filter((entry) => entry.owner.login.toLowerCase() === login.toLowerCase() && (entry.description === GIST_DESCRIPTION || entry.description?.startsWith(`${GIST_DESCRIPTION} · `)) && GIST_FILENAME in entry.files));
      candidates.sort((a, b) => b.created_at.localeCompare(a.created_at) || (b.description ?? "").localeCompare(a.description ?? "") || b.id.localeCompare(a.id));
      if (!latest && candidates.length) {
        const modern = candidates.find((entry) => entry.created_at === candidates[0].created_at && REVISION_FILENAME in entry.files);
        latest = await this.detail(modern ?? candidates[0]);
        anchors = latest.parents ? new Set(latest.parents.map((parent) => parent.split(":")[0])) : null;
      }
      if (latest && anchors === null) break;
      if (anchors?.size && [...anchors].every((id) => candidates.some((entry) => entry.id === id))) {
        const parents = anchors;
        const boundary = candidates.filter((entry) => parents.has(entry.id)).map((entry) => entry.created_at).sort()[0];
        if (entries.length < 100 || entries[entries.length - 1].created_at < boundary) break;
      }
      if (entries.length < 100) break;
      if (page >= 100) throw new Error("Gist가 너무 많아 동기화 백업을 안전하게 찾을 수 없습니다.");
    }
    if (!latest) return null;
    const boundary = anchors?.size ? candidates.filter((entry) => anchors.has(entry.id)).map((entry) => entry.created_at).sort()[0] : null;
    const recent = boundary ? candidates.filter((entry) => entry.created_at >= boundary) : candidates;
    const records = [latest];
    if (latest.parents) {
      for (const entry of recent) {
        if (entry.id === latest.sha.split(":")[0]) continue;
        records.push(await this.detail(entry));
      }
    }
    const legacy = records.find((entry) => !entry.parents);
    const relevant = records.filter((entry) => entry.parents || entry === legacy);
    const parents = new Set(relevant.flatMap((entry) => entry.parents ?? []));
    const heads = relevant.filter((entry) => !parents.has(entry.sha)).map((entry) => entry.sha);
    const current = relevant.find((entry) => heads.includes(entry.sha));
    if (!current) throw new Error("백업 revision 연결이 올바르지 않습니다.");
    return { latest: current, heads };
  }

  private async detail(latest: GistMetadata) {
    if (latest.public) throw new Error("공개 상태로 바뀐 동기화 Gist는 사용할 수 없습니다.");
    const gist = z.object({ public: z.literal(false), owner: z.object({ login: z.string() }), history: z.array(z.object({ version: z.string() })).min(1),
      files: z.record(z.string(), z.object({ content: z.string().optional(), size: z.number(), truncated: z.boolean().optional(), raw_url: z.string().optional() })) }).parse(await this.api(`/gists/${latest.id}`));
    if (gist.owner.login.toLowerCase() !== this.login!.toLowerCase()) throw new Error("다른 계정의 Gist는 사용할 수 없습니다.");
    const file = gist.files[GIST_FILENAME];
    if (!file || file.size > MAX_BYTES * 1.5) throw new Error("백업 파일이 없거나 크기 제한을 초과했습니다.");
    const raw = await this.content(latest.id, file, MAX_BYTES * 1.5);
    const revision = gist.files[REVISION_FILENAME];
    const parents = revision ? revisionSchema.parse(JSON.parse(await this.content(latest.id, revision, 16_384))).parents : null;
    return { sha: `${latest.id}:${gist.history[0].version}`, raw, parents };
  }

  private async content(id: string, file: { size: number; content?: string; truncated?: boolean; raw_url?: string }, limit: number) {
    if (file.size > limit) throw new Error("백업 파일 크기 제한을 초과했습니다.");
    let content = file.content;
    if (file.truncated || content === undefined) {
      if (!file.raw_url) throw new Error("백업 파일 다운로드 경로가 없습니다.");
      const url = new URL(file.raw_url); const parts = url.pathname.split("/");
      if (url.protocol !== "https:" || url.hostname !== "gist.githubusercontent.com" || url.port || url.username || url.password || parts[1].toLowerCase() !== this.login!.toLowerCase() || parts[2] !== id) throw new Error("허용하지 않는 Gist 다운로드 경로입니다.");
      const response = await this.get(url, { redirect: "error" });
      if (!response.ok) throw new GitHubError(response.status);
      content = await response.text();
    }
    if (Buffer.byteLength(content) > limit) throw new Error("백업 파일 크기 제한을 초과했습니다.");
    return content;
  }

  async read(): Promise<Remote> {
    const found = await this.discover();
    if (!found) return { sha: null, raw: null };
    return { sha: found.latest.sha, raw: found.latest.raw, ...(found.heads.length > 1 ? { conflicts: found.heads } : {}) };
  }

  async write(raw: string, sha: string | null, resolveConflicts = false) {
    if (Buffer.byteLength(raw) > MAX_BYTES * 1.5) throw new Error("백업 크기 제한을 초과했습니다.");
    const previous = await this.read();
    if (previous.sha !== sha) throw new Error("다른 기기에서 백업이 변경되었습니다. 최신 백업을 확인하고 다시 시도하세요.");
    if (previous.conflicts && !resolveConflicts) throw new GitHubConflictError();
    const parents = previous.conflicts ?? (previous.sha ? [previous.sha] : []);
    const revision = JSON.stringify(revisionSchema.parse({ version: 1, parents }));
    // Gist PATCH에는 원자적 SHA 조건이 없어 백업마다 새 Gist를 만들고 이전 내용을 보존한다.
    const gist = z.object({ id: z.string(), public: z.literal(false), owner: z.object({ login: z.string() }), history: z.array(z.object({ version: z.string() })).min(1) }).parse(await this.api("/gists", "POST", {
      description: `${GIST_DESCRIPTION} · ${new Date().toISOString()}`, public: false, files: { [GIST_FILENAME]: { content: raw }, [REVISION_FILENAME]: { content: revision } },
    }));
    if (gist.owner.login.toLowerCase() !== this.login!.toLowerCase()) throw new Error("백업 계정이 일치하지 않습니다.");
    if ((await this.read()).conflicts) throw new GitHubConflictError();
    return `${gist.id}:${gist.history[0].version}`;
  }
}
