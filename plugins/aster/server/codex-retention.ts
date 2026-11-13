import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline, type Readable, type Transform } from "node:stream";
import * as zlib from "node:zlib";

// Codex keeps every conversation as a rollout file under CODEX_HOME's sessions and
// archived_sessions and never removes one (Codex 0.167 has no retention setting; its memories'
// `max_rollout_age_days` only limits what memory extraction reads). Aster removes old ones only
// when the user opts in, and through the official app-server `thread/delete`: that also drops the
// thread from Codex's state database and its spawned sub-agent threads, keeps forks readable,
// and refuses a thread another Codex process holds ("already has an active writer"). A sub-agent
// thread stays as long as the thread that spawned it does, and a thread that spawned one that
// stays stays too, or deleting it would take that one along. Only a rollout's `session_meta` line
// tells which thread spawned it; where no first line of a thread can be read that is unknown, so
// such a thread stays when it is old, and holds back the day's run when it stays anyway.

const ROLLOUT =
  /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;
const DAY = 86_400_000;

export interface RolloutFile {
  path: string;
  size: number;
  modified: number;
}

/** Rollout files under sessions and archived_sessions, by thread ID. Links are not followed. */
export async function codexRollouts(codexHome: string) {
  const threads = new Map<string, RolloutFile[]>();
  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        // sessions/<year>/<month>/<day>/rollout-*.jsonl
        if (depth < 4) await walk(path, depth + 1);
        continue;
      }
      const match = entry.isFile() ? ROLLOUT.exec(entry.name) : null;
      if (!match) continue;
      const stat = await lstat(path).catch(() => null);
      if (!stat?.isFile()) continue;
      const id = match[1].toLowerCase();
      threads.set(id, [
        ...(threads.get(id) ?? []),
        { path, size: stat.size, modified: stat.mtimeMs },
      ]);
    }
  };
  await walk(join(codexHome, "sessions"), 0);
  await walk(join(codexHome, "archived_sessions"), 0);
  return threads;
}

/** How much of a rollout is read for its first line (`session_meta`, a few KB). */
const META_LIMIT = 1_048_576;

const zstdDecompress = () =>
  (zlib as { createZstdDecompress?: () => Transform }).createZstdDecompress;
const isZst = (path: string) => path.toLowerCase().endsWith(".zst");

/** The first line of a rollout, decompressing `.zst` where this Node can; null when unreadable. */
async function firstLine(path: string): Promise<string | null> {
  const compressed = isZst(path);
  const decompress = zstdDecompress();
  if (compressed && !decompress) return null;
  const source = createReadStream(path, { highWaterMark: 65_536 });
  const stream: Readable = compressed
    ? pipeline(source, decompress!(), () => undefined)
    : source;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const end = chunk.indexOf(10);
      if (end >= 0) {
        chunks.push(chunk.subarray(0, end));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(chunk);
      size += chunk.length;
      if (size > META_LIMIT) return null;
    }
    return size ? Buffer.concat(chunks).toString("utf8") : null;
  } catch {
    return null;
  } finally {
    stream.destroy();
    source.destroy();
  }
}

/**
 * The thread that spawned this one, from its rollout's `session_meta` line
 * (`source.subagent.thread_spawn.parent_thread_id`), or null for any other thread. Undefined when
 * no rollout of the thread starts with a `session_meta` line that can be read (too long, broken,
 * compressed beyond this Node, or gone), so which thread spawned it is unknown.
 */
export async function rolloutParent(
  files: RolloutFile[],
): Promise<string | null | undefined> {
  let known = false;
  for (const file of files) {
    const line = await firstLine(file.path);
    if (!line) continue;
    let meta;
    try {
      meta = JSON.parse(line) as {
        type?: unknown;
        payload?: {
          source?: {
            subagent?: { thread_spawn?: { parent_thread_id?: unknown } };
          };
        };
      } | null;
    } catch {
      continue;
    }
    if (meta?.type !== "session_meta") continue;
    known = true;
    const parent =
      meta.payload?.source?.subagent?.thread_spawn?.parent_thread_id;
    if (typeof parent === "string") return parent.toLowerCase();
  }
  return known ? null : undefined;
}

/**
 * The Codex threads of conversations Paseo still lists (not archived). Their history stays
 * whatever its age, so an open tab never loses it. A record that cannot be read stops the run.
 */
export async function openPaseoThreads(paseoHome: string) {
  const ids = new Set<string>();
  const directory = join(paseoHome, "agents");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ids;
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(directory, entry.name));
  for (const project of entries.filter((entry) => entry.isDirectory()))
    for (const entry of await readdir(join(directory, project.name), {
      withFileTypes: true,
    }))
      if (entry.isFile() && entry.name.endsWith(".json"))
        files.push(join(directory, project.name, entry.name));
  for (const file of files) {
    const record = JSON.parse(await readFile(file, "utf8")) as {
      archivedAt?: string | null;
      persistence?: {
        sessionId?: unknown;
        nativeHandle?: unknown;
        metadata?: { threadId?: unknown } | null;
      } | null;
      runtimeInfo?: { sessionId?: unknown } | null;
    } | null;
    if (!record || record.archivedAt) continue;
    // Paseo opens a Codex thread by its native handle first, then the session ID.
    for (const id of [
      record.persistence?.sessionId,
      record.persistence?.nativeHandle,
      record.persistence?.metadata?.threadId,
      record.runtimeInfo?.sessionId,
    ])
      if (typeof id === "string") ids.add(id.toLowerCase());
  }
  return ids;
}

export interface RetentionResult {
  /** Threads whose rollout files are gone after the run, sub-agent threads included. */
  removed: number;
  bytes: number;
  /** Old threads Codex did not delete: in use by another Codex process, or refused. */
  skipped: number;
  /** Old threads kept because a conversation Paseo lists uses them. */
  kept: number;
  /** Old sub-agent threads kept with the thread that spawned them, which stays. */
  children: number;
  /** Old threads kept because a sub-agent thread they spawned stays. */
  parents: number;
  /** Old threads kept because no first line of theirs tells which thread spawned them. */
  unreadable: number;
  reason?: string;
}

/**
 * Removes the threads whose every rollout file is older than `days`, except those of open Paseo
 * conversations, the sub-agent threads of any thread that stays, the threads that spawned one
 * that stays and old threads whose parent cannot be read, and reports what disappeared. `remove`
 * asks Codex to delete the given threads; nothing is started when no thread is old enough. The
 * run stops before deleting anything when a thread that stays has no readable first line (the
 * thread that spawned it, which must stay too, is unknown) or, when this Node cannot decompress
 * `zstd` (`zstd: false` for tests), as soon as any rollout is compressed.
 */
export async function pruneCodexHistory(input: {
  codexHome: string;
  paseoHome: string;
  days: number;
  now: number;
  remove: (threadIds: string[]) => Promise<{ reason?: string }>;
  zstd?: boolean;
}): Promise<RetentionResult> {
  const before = await codexRollouts(input.codexHome);
  const open = await openPaseoThreads(input.paseoHome);
  const cutoff = input.now - input.days * DAY;
  const aged = new Set(
    [...before]
      .filter(([, files]) => files.every((file) => file.modified < cutoff))
      .map(([id]) => id),
  );
  const kept = [...aged].filter((id) => open.has(id)).length;
  const none = { removed: 0, bytes: 0, skipped: 0 };
  if ([...aged].every((id) => open.has(id)))
    return { ...none, kept, children: 0, parents: 0, unreadable: 0 };
  if (!(input.zstd ?? zstdDecompress() !== undefined)) {
    const packed = [...before.values()].filter((files) =>
      files.some((file) => isZst(file.path)),
    ).length;
    if (packed)
      throw new Error(
        `이 Node 는 zstd 를 풀지 못해 압축된 rollout 대화 ${packed}개의 하위 작업 관계를 읽을 수 없음`,
      );
  }
  // A sub-agent thread goes with the thread that spawned it (Codex deletes them together). So the
  // sub-agent threads of a thread that stays (recent, or open in Paseo) stay however old they
  // are, and so do the threads that spawned one that stays, up to the first.
  const parentOf = new Map<string, string>();
  const spawned = new Map<string, string[]>();
  const unknown = new Set<string>();
  for (const [id, files] of before) {
    const parent = await rolloutParent(files);
    if (parent === undefined) unknown.add(id);
    if (!parent || parent === id) continue;
    parentOf.set(id, parent);
    spawned.set(parent, [...(spawned.get(parent) ?? []), id]);
  }
  const stays = new Set([
    ...open,
    ...[...before.keys()].filter((id) => !aged.has(id)),
  ]);
  const children = new Set<string>(),
    parents = new Set<string>(),
    unread = new Set<string>(),
    queue = [...stays];
  const keep = (id: string, why: Set<string>) => {
    if (stays.has(id) || !aged.has(id)) return;
    stays.add(id);
    why.add(id);
    queue.push(id);
  };
  const spread = () => {
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      const parent = parentOf.get(id);
      if (parent) keep(parent, parents);
      for (const child of spawned.get(id) ?? []) keep(child, children);
    }
  };
  spread();
  // Any old thread may have spawned a thread that stays without a readable first line.
  const blind = [...stays].filter((id) => unknown.has(id));
  // An old one may be the sub-agent of a thread that stays: it stays, with what it spawned.
  for (const id of aged) if (unknown.has(id)) keep(id, unread);
  spread();
  const candidates = [...aged].filter((id) => !stays.has(id));
  const held = {
    kept,
    children: children.size,
    parents: parents.size,
    unreadable: unread.size,
  };
  if (!candidates.length) return { ...none, ...held };
  if (blind.length)
    throw new Error(
      `남는 대화 ${blind.length}개의 rollout 첫 줄을 읽지 못해 그 대화를 띄운 대화를 알 수 없음(${blind[0]} 등)`,
    );
  const { reason } = await input.remove(candidates);
  const after = await codexRollouts(input.codexHome);
  let removed = 0,
    bytes = 0;
  for (const [id, files] of before)
    if (!after.has(id)) {
      removed++;
      bytes += files.reduce((sum, file) => sum + file.size, 0);
    }
  return {
    removed,
    bytes,
    skipped: candidates.filter((id) => after.has(id)).length,
    ...held,
    ...(reason ? { reason } : {}),
  };
}

/** One line for the plugin log: the retention, what went, and what stayed and why. */
export function retentionSummary(days: number, result: RetentionResult) {
  const megabytes = (result.bytes / 1_048_576).toFixed(1);
  return [
    `[aster] Codex 대화 기록 보존 ${days}일: ${result.removed}개 대화 ${megabytes}MB 삭제`,
    result.skipped
      ? `${result.skipped}개 건너뜀(사용 중·삭제 거부${result.reason ? `: ${result.reason}` : ""})`
      : null,
    result.kept ? `Paseo 열린 대화 ${result.kept}개 보존` : null,
    result.children ? `남는 대화의 하위 작업 ${result.children}개 보존` : null,
    result.parents
      ? `남는 하위 작업을 띄운 대화 ${result.parents}개 보존`
      : null,
    result.unreadable
      ? `첫 줄을 읽지 못한 오래된 대화 ${result.unreadable}개 보존`
      : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
}
