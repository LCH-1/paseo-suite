import { mkdir, rm } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { MutableDaemonConfigPatchSchema } from "@getpaseo/protocol/messages";
import { z } from "zod";
import { pickConfig, settingsId, snapshotSchema, type ClientState, type Snapshot } from "../shared/model";
import { portableState } from "../shared/portable";
import { normalizeScopes, selectClient, selectConfig, stableString, type AutoScopesInput } from "../shared/automation";
import { atomicWrite, checkedRelative, digest, packPlugin, readOptional, readPluginSettings, unpackPlugin } from "./files";
import { portablePlugin } from "./plugin-compat";
import { verifyPlugins } from "./plugin-runtime";
import { ProviderCredentialSync } from "./provider-credentials";
import { materializeProviders, type MaterializeOptions } from "./provider-paths";
import { ensureProviderExecutable } from "./provider-install";
import { asProviders, vendorCommands } from "../shared/provider-paths";
import { preparePluginState, nativeStateKey } from "./plugin-state";
import { normalizeSuitePlugins, suiteInstallation } from "./suite-compat";
import { legacyTransfer } from "./legacy-transfer";
import { RestoreConfig } from "./restore-config";

type PaseoApi = PluginHandlerContext["paseo"];
export class ProviderCaptureError extends Error {
  constructor(message = "프로바이더 인증 저장소를 읽을 수 없습니다. 해당 PC의 인증 저장소 상태를 확인하세요.") { super(message); }
}
function mergeProviderSettings(local: unknown, incoming: unknown): unknown {
  if (local && incoming && typeof local === "object" && typeof incoming === "object" && !Array.isArray(local) && !Array.isArray(incoming)) {
    const result: Record<string, unknown> = { ...local };
    for (const [key, value] of Object.entries(incoming)) result[key] = mergeProviderSettings(result[key], value);
    return result;
  }
  return incoming;
}
const configuredPlugin = z.object({ source: z.literal("directory"), path: z.string(), enabled: z.boolean().optional() });
export function paseoHome() {
  const raw = process.env.PASEO_HOME ?? "~/.paseo";
  return path.resolve(raw === "~" ? homedir() : raw.startsWith("~/") ? path.join(homedir(), raw.slice(2)) : raw);
}

export class Environment {
  constructor(public home = paseoHome(), private checkPlugins = verifyPlugins, private providerCredentials = new ProviderCredentialSync({ home, userHome: home === paseoHome() ? homedir() : path.join(home, "user") }), private paths: MaterializeOptions = {}) {}

  async capture(paseo: PaseoApi, client: ClientState, options?: AutoScopesInput): Promise<Snapshot> {
    const scopes = normalizeScopes(options ?? { config: true, plugins: true });
    const { config } = await paseo.config.get();
    const accounts = scopes.providers ? await this.providerCredentials.capture(config.providers).catch(() => { throw new ProviderCaptureError(); }) : null;
    const unsupported = accounts?.status.find((entry) => entry.status === "unsupported");
    if (unsupported) throw new ProviderCaptureError(`${unsupported.vendor} 인증 저장 방식을 이 버전에서 이식할 수 없습니다. 해당 CLI의 파일 저장 방식이나 API 키 환경변수를 사용하세요.`);
    if (accounts) {
      const providers = asProviders(accounts.providers);
      for (const entry of accounts.status.filter((item) => item.status === "available" || item.status === "environment")) {
        const base = providers[entry.vendor];
        if (base && base.command === undefined && base.extends === undefined && vendorCommands[entry.vendor]) base.command = [vendorCommands[entry.vendor]];
      }
    }
    const plugins = [];
    const suite = await suiteInstallation(this.home);
    for (const [id, source] of Object.entries(scopes.plugins ? config.plugins ?? {} : {})) {
      if (suite && id === "claude-windows-usage") continue;
      const entry = configuredPlugin.parse(source);
      const plugin = await packPlugin(this.home, id, entry.path, entry.enabled !== false);
      if (plugin) plugins.push(plugin);
    }
    const capturedClient = portableState(selectClient(client, scopes));
    const transferredPlugins = await legacyTransfer(this.home, plugins);
    return snapshotSchema.parse({ version: capturedClient.hostSettings || capturedClient.preferenceCoverage ? 3 : accounts?.credentials.records.length ? 2 : 1, createdAt: new Date().toISOString(), device: hostname(), client: capturedClient, config: selectConfig(pickConfig({ ...config, ...(accounts ? { providers: accounts.providers } : {}) }), scopes), plugins: transferredPlugins, scopes, ...(accounts ? { credentials: accounts.credentials } : {}) });
  }

  async fingerprint(paseo: PaseoApi, snapshot: Snapshot) {
    const { config } = await paseo.config.get();
    const settings = await Promise.all(snapshot.plugins.map(async (plugin) => [plugin.id, await readPluginSettings(this.home, plugin.id)]));
    const includeFiles = snapshot.scopes?.plugins ?? (snapshot.plugins.length > 0);
    const files = includeFiles ? await Promise.all(Object.entries(config.plugins ?? {}).map(async ([id, source]) => {
      try {
        const plugin = await packPlugin(this.home, id, source.path, source.enabled !== false);
        return [id, plugin?.files ?? null];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [id, null];
        throw error;
      }
    })) : [];
    const accounts = snapshot.credentials ? await this.providerCredentials.capture(config.providers) : null;
    return digest(stableString({ config, settings, files, ...(accounts ? { credentials: accounts.credentials } : {}) }));
  }

  async restore(paseo: PaseoApi, snapshot: Snapshot, expected: string, options: { plugins: boolean; config: boolean; providers?: boolean; merge?: boolean; preserveLocalClaude?: boolean }) {
    if (await this.fingerprint(paseo, snapshot) !== expected) throw new Error("미리보기 이후 이 호스트 설정이 변경되었습니다. 다시 미리보기를 여세요.");
    if (new Set(snapshot.plugins.map((p) => p.id)).size !== snapshot.plugins.length) throw new Error("중복 플러그인 ID가 있습니다.");
    const { config: original } = await paseo.config.get();
    const merge = options.merge !== false;
    const providers = options.providers ?? options.config;
    const configScopes = normalizeScopes({ config: options.config, plugins: options.plugins, providers });
    const protectedPlugins: typeof original.plugins = {};
    if (options.plugins) {
      for (const [id, source] of Object.entries(original.plugins ?? {})) {
        const raw = await readOptional(path.join(source.path, "paseo-plugin.json"));
        if (raw && JSON.parse(raw).id === "settings-sync") {
          protectedPlugins[id] = source;
          if (snapshot.plugins.some((plugin) => plugin.id === id)) throw new Error("실행 중인 Settings Sync 플러그인은 덮어쓸 수 없습니다.");
        }
      }
    }
    const paths = { ...this.paths, resolveExecutable: this.paths.resolveExecutable ?? ((name: string) => ensureProviderExecutable(name, { ...this.paths, paseoHome: this.home })) };
    const incomingProviders = providers && snapshot.config.providers ? await materializeProviders(merge ? mergeProviderSettings(original.providers, snapshot.config.providers) : snapshot.config.providers, original.providers, paths) : null;
    const patch = MutableDaemonConfigPatchSchema.parse({ ...selectConfig(pickConfig(snapshot.config), configScopes), ...(incomingProviders ? { providers: incomingProviders } : {}) });
    let authentication: Awaited<ReturnType<ProviderCredentialSync["restore"]>> | null = null;
    const operation = path.join(this.home, "settings-sync", "restore", randomUUID());
    await mkdir(operation, { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(operation, "previous-config.json"), JSON.stringify(original));
    const suite = await suiteInstallation(this.home);
    if (suite?.nativeUsagePending && original.plugins?.["claude-windows-usage"]) protectedPlugins["claude-windows-usage"] = original.plugins["claude-windows-usage"];
    const selected = options.plugins ? (await normalizeSuitePlugins(this.home, snapshot.plugins)).map(portablePlugin) : [];
    const staged: Record<string, { source: "directory"; path: string; enabled?: boolean }> = {};
    const previousSettings: { file: string; raw: string | null }[] = [];
    const settingsWrites: { file: string; raw: string | null }[] = [];
    const changedPlugins = new Set<string>();
    for (const plugin of selected) {
      const previous = original.plugins?.[plugin.id];
      let local;
      if (previous) {
        try { local = await packPlugin(this.home, plugin.id, previous.path, previous.enabled !== false); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      const sameFiles = local && stableString(local.files) === stableString(plugin.files);
      const directory = sameFiles ? previous!.path : await unpackPlugin(operation, plugin);
      const sameEnabled = (previous?.enabled !== false) === plugin.enabled;
      staged[plugin.id] = sameFiles && sameEnabled ? previous! : { source: "directory", path: directory, enabled: plugin.enabled };
      if (!sameFiles || !sameEnabled) changedPlugins.add(plugin.id);
      const localSettings = local?.settings ?? await readPluginSettings(this.home, plugin.id);
      const names = new Set([...Object.keys(plugin.settings), ...(!merge ? Object.keys(localSettings) : [])]);
      for (const name of names) {
        settingsId.parse(name);
        checkedRelative(`${name}.json`);
        if (stableString(localSettings[name]) === stableString(plugin.settings[name])) continue;
        const file = path.join(this.home, "plugin-settings", plugin.id, `${name}.json`);
        previousSettings.push({ file, raw: await readOptional(file) });
        settingsWrites.push({ file, raw: name in plugin.settings ? JSON.stringify(plugin.settings[name]) : null });
        changedPlugins.add(plugin.id);
      }
      const state = await preparePluginState(this.home, plugin);
      if (state) {
        previousSettings.push({ file: state.file, raw: state.previous });
        settingsWrites.push({ file: state.file, raw: state.raw });
        changedPlugins.add(plugin.id);
      }
    }
    await atomicWrite(path.join(operation, "previous-settings.json"), JSON.stringify(previousSettings));
    if (await this.fingerprint(paseo, snapshot) !== expected) throw new Error("복원 준비 중 설정이 변경되었습니다. 다시 미리보기를 여세요.");
    const withoutCredentials = { ...snapshot, credentials: undefined };
    const prepared = await this.fingerprint(paseo, withoutCredentials);
    const configuration = new RestoreConfig(paseo, original);
    const appliedSettings: { file: string; before: string | null; after: string | null }[] = [];
    const nextPlugins = { ...(merge ? original.plugins : protectedPlugins), ...staged };
    const nativeState = selected.find((plugin) => plugin.id === "terminal-tabs")?.settings[nativeStateKey];
    if (suite?.nativeUsagePending && nextPlugins["claude-windows-usage"] && nativeState) {
      const enabled = z.object({ enabled: z.boolean() }).parse(nativeState.values).enabled;
      nextPlugins["claude-windows-usage"] = { ...nextPlugins["claude-windows-usage"], enabled };
    }
    const pluginsChanged = options.plugins && stableString(nextPlugins) !== stableString(original.plugins ?? {});
    const stopped = Object.fromEntries(Object.entries(original.plugins ?? {}).flatMap(([id, source]) => source.enabled !== false && (changedPlugins.has(id) || options.plugins && !(id in nextPlugins)) ? [[id, { ...source, enabled: false }]] : []));
    try {
      if (providers && snapshot.credentials && patch.providers) {
        authentication = await this.providerCredentials.restore(patch.providers, snapshot.credentials, original.providers, { preserveLocalClaude: options.preserveLocalClaude });
        patch.providers = MutableDaemonConfigPatchSchema.parse({ providers: authentication.providers }).providers;
      }
      if (await this.fingerprint(paseo, withoutCredentials) !== prepared) throw new Error("인증 복원 준비 중 설정이 변경되었습니다. 다시 미리보기를 여세요.");
      const replaceProviders = providers && !merge ? Object.keys(original.providers).filter((id) => stableString(original.providers[id]) !== stableString(patch.providers?.[id])) : [];
      if (Object.keys(stopped).length) await configuration.patch({ plugins: { ...original.plugins, ...stopped } });
      for (const [index, write] of settingsWrites.entries()) {
        const before = previousSettings[index].raw;
        if (await readOptional(write.file) !== before) throw new Error("복원 중 플러그인 설정이 변경되었습니다. 다시 미리보기를 여세요.");
        appliedSettings.push({ file: write.file, before, after: write.raw });
        if (write.raw === null) await rm(write.file, { force: true });
        else await atomicWrite(write.file, write.raw);
      }
      if (replaceProviders.length) await configuration.patch({ removeProviders: replaceProviders });
      if (options.config || providers || pluginsChanged || Object.keys(stopped).length) await configuration.patch({ ...patch, ...(!options.config && replaceProviders.length && original.metadataGeneration !== undefined ? { metadataGeneration: original.metadataGeneration } : {}), ...(options.plugins && (pluginsChanged || Object.keys(stopped).length) ? { plugins: nextPlugins } : {}) });
      await this.checkPlugins(this.home, selected.filter((plugin) => plugin.enabled && changedPlugins.has(plugin.id)).map((plugin) => ({ id: plugin.id, path: staged[plugin.id].path })));
      await authentication?.commit();
    } catch (error) {
      const failures: unknown[] = [];
      if (appliedSettings.length) {
        try { await configuration.quiesce(changedPlugins); } catch (rollbackError) { failures.push(rollbackError); }
      }
      for (const write of appliedSettings.toReversed()) {
        try {
          const current = await readOptional(write.file);
          if (current === write.before) continue;
          if (current !== write.after) throw new Error("복원 중 외부에서 수정된 플러그인 설정은 보존했습니다.");
          if (write.before === null) await rm(write.file, { force: true });
          else await atomicWrite(write.file, write.before);
        } catch (rollbackError) { failures.push(rollbackError); }
      }
      try { await configuration.rollback(); } catch (rollbackError) { failures.push(rollbackError); }
      try { await authentication?.rollback(); } catch (rollbackError) { failures.push(rollbackError); }
      if (failures.length) throw new AggregateError([error, ...failures], `복원과 자동 복구에 실패했습니다. 이전 설정 위치: ${operation}`);
      throw error;
    }
    return operation;
  }
}
