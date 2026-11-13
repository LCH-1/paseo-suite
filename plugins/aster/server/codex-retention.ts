import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Codex keeps every conversation as a rollout file under CODEX_HOME's sessions and
// archived_sessions and never removes one (Codex 0.167 has no retention setting; its memories'
// `max_rollout_age_days` only limits what memory extraction reads). Aster removes old ones only
// when the user opts in, and through the official app-server `thread/delete`: that also drops the
// thread from Codex's state database and its spawned sub-agent threads, keeps forks readable,
// and refuses a thread another Codex process holds ("already has an active writer").

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
      persistence?: { sessionId?: unknown } | null;
      runtimeInfo?: { sessionId?: unknown } | null;
    } | null;
    if (!record || record.archivedAt) continue;
    for (const id of [
      record.persistence?.sessionId,
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
  reason?: string;
}

/**
 * Removes the threads whose every rollout file is older than `days`, except those of open Paseo
 * conversations, and reports what disappeared. `remove` asks Codex to delete the given threads;
 * nothing is started when no thread is old enough.
 */
export async function pruneCodexHistory(input: {
  codexHome: string;
  paseoHome: string;
  days: number;
  now: number;
  remove: (threadIds: string[]) => Promise<{ reason?: string }>;
}): Promise<RetentionResult> {
  const before = await codexRollouts(input.codexHome);
  const open = await openPaseoThreads(input.paseoHome);
  const cutoff = input.now - input.days * DAY;
  const old = [...before].filter(([, files]) =>
    files.every((file) => file.modified < cutoff),
  );
  const candidates = old.filter(([id]) => !open.has(id)).map(([id]) => id);
  const kept = old.length - candidates.length;
  if (!candidates.length) return { removed: 0, bytes: 0, skipped: 0, kept };
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
    kept,
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
  ]
    .filter((part) => part !== null)
    .join(", ");
}
