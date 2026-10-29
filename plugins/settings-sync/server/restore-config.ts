import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { stableString } from "../shared/automation";

type PaseoApi = PluginHandlerContext["paseo"];
type Config = Awaited<ReturnType<PaseoApi["config"]["get"]>>["config"];
type Patch = Parameters<PaseoApi["config"]["patch"]>[0];
type ObjectValue = Record<string, any>;
const equal = (a: unknown, b: unknown) => stableString(a) === stableString(b);
const object = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);
const copy = <T>(value: T): T => structuredClone(value);

function merge(before: any, patch: any): any {
  if (!object(patch)) return copy(patch);
  const result = object(before) ? copy(before) : {};
  for (const [key, value] of Object.entries(patch)) result[key] = merge(result[key], value);
  return result;
}

// Match the daemon's deep merge, whole plugin-map replacement and provider-removal side effects.
function apply(config: Config, patch: Patch): Config {
  const { removeProviders = [], ...values } = patch;
  const next = merge(config, values);
  if (patch.plugins !== undefined) next.plugins = copy(patch.plugins);
  for (const id of removeProviders) delete next.providers[id];
  if (removeProviders.length && next.metadataGeneration?.providers) next.metadataGeneration.providers = next.metadataGeneration.providers.filter((entry: { provider: string }) => !removeProviders.includes(entry.provider));
  return next;
}

// Change only values still owned by this restore. Plugin sources are indivisible: never
// disable or replace a different source selected by the user during verification.
function reconcile(before: any, desired: any, live: any, conflicts: Set<string>, path: string[] = []): any {
  if (equal(before, desired)) return copy(live);
  if (equal(live, before)) return copy(desired);
  if (equal(live, desired)) return copy(live);
  if (object(before) && object(desired) && object(live) && !(path[0] === "plugins" && path.length === 2)) {
    const result = copy(live);
    for (const key of new Set([...Object.keys(before), ...Object.keys(desired)])) {
      const value = reconcile(before[key], desired[key], live[key], conflicts, [...path, key]);
      if (value === undefined) delete result[key]; else result[key] = value;
    }
    return result;
  }
  conflicts.add(path.join("."));
  return copy(live);
}

// A rejected RPC may have failed before or after applying its patch. Values which
// are still at the pre-call state must not be treated as successfully written.
function appliedIntent(before: any, intended: any, live: any): any {
  if (equal(before, intended)) return copy(intended);
  if (equal(live, before)) return copy(before);
  if (object(before) && object(intended) && object(live)) {
    const result = copy(intended);
    for (const key of new Set([...Object.keys(before), ...Object.keys(intended)])) {
      const value = appliedIntent(before[key], intended[key], live[key]);
      if (value === undefined) delete result[key]; else result[key] = value;
    }
    return result;
  }
  return copy(intended);
}

function difference(before: ObjectValue, after: ObjectValue): ObjectValue {
  const patch: ObjectValue = {};
  for (const [key, value] of Object.entries(after)) {
    if (equal(before[key], value)) continue;
    patch[key] = key === "plugins" ? copy(value) : object(before[key]) && object(value) ? difference(before[key], value) : copy(value);
  }
  return patch;
}

export class RestoreConfig {
  private expected: Config;
  constructor(private paseo: PaseoApi, private original: Config) { this.expected = copy(original); }

  async patch(patch: Patch) {
    const { config: live } = await this.paseo.config.get();
    if (!equal(live, this.expected)) throw new Error("복원 중 호스트 설정이 변경되었습니다. 다시 미리보기를 여세요.");
    const before = this.expected;
    this.expected = apply(before, patch);
    try {
      const { config } = await this.paseo.config.patch(patch);
      if (!equal(config, this.expected)) throw new Error("복원 적용 중 호스트 설정이 변경되었습니다.");
    } catch (error) {
      try { this.expected = appliedIntent(before, this.expected, (await this.paseo.config.get()).config); } catch { /* Keep the intended values when the daemon is unavailable. */ }
      throw error;
    }
  }

  async quiesce(ids: Set<string>) {
    const { config: live } = await this.paseo.config.get();
    const plugins = copy(live.plugins ?? {});
    const owned = [...ids].filter((id) => plugins[id]?.enabled !== false && plugins[id] && equal(plugins[id], this.expected.plugins?.[id]));
    if (!owned.length) return;
    const before = copy(this.expected);
    this.expected.plugins = { ...this.expected.plugins };
    for (const id of owned) this.expected.plugins[id] = plugins[id] = { ...plugins[id], enabled: false };
    try { await this.paseo.config.patch({ plugins }); }
    catch (error) {
      try { this.expected = appliedIntent(before, this.expected, (await this.paseo.config.get()).config); } catch { /* Retain the intent for conditional recovery. */ }
      throw error;
    }
  }

  async rollback() {
    const conflicts = new Set<string>();
    const { config: live } = await this.paseo.config.get();
    let desired = reconcile(this.expected, this.original, live, conflicts) as Config;
    for (const key of ["terminalProfiles", "agentProfiles"] as const) if (this.original[key] === undefined && this.expected[key] !== undefined && desired[key] === undefined) desired[key] = [];
    if (this.original.plugins === undefined && this.expected.plugins !== undefined && desired.plugins === undefined) desired.plugins = {};
    // Providers are deep-merged by the daemon, so remove a changed record before
    // restoring it; otherwise fields introduced by the failed restore survive.
    const removed = Object.keys(live.providers).filter((id) => !equal(live.providers[id], desired.providers[id]));
    let before = live;
    if (removed.length) {
      const patch = { removeProviders: removed };
      await this.paseo.config.patch(patch);
      before = apply(live, patch);
    }
    const current = (await this.paseo.config.get()).config;
    // A user can edit again while provider removal awaits. Rebase the remaining
    // recovery, including metadata references, onto that newer configuration.
    desired = reconcile(before, desired, current, conflicts);
    const patch = difference(current, desired) as Patch;
    if (Object.keys(patch).length) await this.paseo.config.patch(patch);
    if (conflicts.size) throw new Error("복원 중 외부에서 수정된 설정은 보존했습니다. 최신 설정으로 다시 미리보기를 여세요.");
  }
}
