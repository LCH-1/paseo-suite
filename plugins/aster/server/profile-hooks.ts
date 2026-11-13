import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Paseo starts each Claude account with CLAUDE_CONFIG_DIR set to that account's profile, so the
// CLI never reads ~/.claude/settings.json there. HND installs its hooks only into that user file;
// a session Aster moves to another account therefore lost HND's policy context and work-session
// identity (seen 2026-11-12). The profiles also share ~/.claude/projects, and the CLI in a
// profile without `cleanupPeriodDays` cleaned that shared history after its default 30 days
// while the user's file asked for longer (seen 2026-11-13). Only HND's own hook groups and the
// user's history retention are mirrored into the profiles.

interface HookGroup {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
}
type Settings = Record<string, unknown> & {
  hooks?: Record<string, HookGroup[]>;
};

const HND_COMMAND =
  /@lch-1[\\/]+hnd[\\/]+bin[\\/]+hnd\.mjs|\bhnd(?:\.cmd|\.exe)?"?\s+(?:"?--state-home"?\s+\S+\s+)?"?hook"?\s+"?claude\b/i;

export function isHndGroup(group: unknown): boolean {
  const hooks = (group as HookGroup | null)?.hooks;
  return (
    Array.isArray(hooks) &&
    hooks.length > 0 &&
    hooks.every(
      (hook) =>
        typeof hook?.command === "string" && HND_COMMAND.test(hook.command),
    )
  );
}

/** The profile's settings with its HND hook groups replaced by the user's; nothing else changes. */
export function mergeHndHooks(target: Settings, source: Settings): Settings {
  const current =
    target.hooks && typeof target.hooks === "object" ? target.hooks : {};
  const wanted =
    source.hooks && typeof source.hooks === "object" ? source.hooks : {};
  const hooks: Record<string, HookGroup[]> = {};
  for (const event of new Set([
    ...Object.keys(current),
    ...Object.keys(wanted),
  ])) {
    const kept = (Array.isArray(current[event]) ? current[event] : []).filter(
      (group) => !isHndGroup(group),
    );
    const added = (Array.isArray(wanted[event]) ? wanted[event] : []).filter(
      isHndGroup,
    );
    if (kept.length || added.length) hooks[event] = [...kept, ...added];
  }
  const next: Settings = { ...target };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

/**
 * The profile's settings with the user's HND hooks and, when the user set one, the user's history
 * retention (`cleanupPeriodDays`). A profile keeps its own value while the user has none, or one
 * the CLI rejects (it takes whole days from 1; 0 no longer means "keep"), which would only put a
 * settings error into every profile.
 */
export function mergeProfileSettings(
  target: Settings,
  source: Settings,
): Settings {
  const next = mergeHndHooks(target, source);
  const days = source.cleanupPeriodDays;
  if (Number.isInteger(days) && (days as number) >= 1)
    next.cleanupPeriodDays = days;
  return next;
}

async function readJson(file: string): Promise<Settings | null | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

/**
 * Mirrors the user's HND hooks and history retention into every account profile. A missing or
 * unreadable user file changes nothing (HND may be mid-update); an unreadable profile file is
 * left alone. Returns the profiles that were rewritten.
 */
export async function syncProfileSettings(
  userHome: string,
  homes: string[],
): Promise<string[]> {
  const userClaude = resolve(join(userHome, ".claude"));
  const source = await readJson(join(userClaude, "settings.json"));
  if (!source) return [];
  const changed: string[] = [];
  for (const home of new Set(homes.map((value) => resolve(value)))) {
    if (home.toLowerCase() === userClaude.toLowerCase()) continue;
    const file = join(home, "settings.json");
    const current = await readJson(file);
    if (current === null) continue;
    const next = mergeProfileSettings(current ?? {}, source);
    if (JSON.stringify(next) === JSON.stringify(current ?? {})) continue;
    const temporary = `${file}.aster-${process.pid}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2) + "\n");
      await rename(temporary, file);
      changed.push(home);
    } catch {
      // A profile that vanished or is locked is retried on the next pass.
      await rm(temporary, { force: true });
    }
  }
  return changed;
}
