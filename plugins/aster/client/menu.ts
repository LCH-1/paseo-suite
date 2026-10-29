type Row = { id: string; label?: string };
type Profile = { provider: string };

export const isManagedClaude = (provider: string) => provider === "claude" || provider.startsWith("claude-");

export function singleClaudeRows<T extends Row>(rows: T[]) {
  if (!rows.some((row) => row.id === "claude")) return rows;
  return rows.filter((row) => !row.id.startsWith("claude-"));
}

export function withoutClaudeProfiles<T extends Profile>(rows: T[]) {
  return rows.filter((row) => !isManagedClaude(row.provider));
}

export function installMenuPresentation(form: any, profiles: any, registry: any) {
  const originalForm = form.useAgentFormState;
  const originalProfiles = profiles.useAgentProfilePicker;
  const forms = new WeakMap<object, object>();
  const pickers = new WeakMap<object, object>();
  const active = (serverId: string) => registry.pluginRegistry.getSnapshot().some(
    (plugin: any) => plugin.serverId === serverId && plugin.id === "aster" && !plugin.lifetime.signal.aborted,
  );
  const wrappedForm = (options: any) => {
    const result = originalForm(options);
    if (options.isCreateFlow === false || !active(options.serverId)) return result;
    if (!forms.has(result)) {
      const rows = singleClaudeRows(result.modelSelectorProviders);
      const selectedProvider = rows.some((row) => row.id === "claude") && result.selectedProvider?.startsWith("claude-")
        ? "claude" : result.selectedProvider;
      forms.set(result, { ...result, selectedProvider, modelSelectorProviders: rows });
    }
    return forms.get(result);
  };
  const wrappedProfiles = (options: any) => {
    const result = originalProfiles(options);
    if (!result || !active(options.serverId)) return result;
    if (!pickers.has(result)) pickers.set(result, { ...result, rows: withoutClaudeProfiles(result.rows) });
    return pickers.get(result);
  };
  const restore = () => {
    const failures = [];
    for (const [target, name, wrapped, original] of [
      [form, "useAgentFormState", wrappedForm, originalForm],
      [profiles, "useAgentProfilePicker", wrappedProfiles, originalProfiles],
    ]) {
      try { if (target[name] === wrapped) target[name] = original; }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Aster: 메뉴 확장을 복원하지 못했습니다.");
  };
  try {
    form.useAgentFormState = wrappedForm;
    profiles.useAgentProfilePicker = wrappedProfiles;
  } catch (error) {
    try { restore(); }
    catch (failure) { throw new AggregateError([error, failure], "Aster: 메뉴 확장 초기화와 복원이 실패했습니다."); }
    throw error;
  }
  return restore;
}
