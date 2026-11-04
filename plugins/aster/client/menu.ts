type Row = { id: string; label?: string };
type Profile = { provider: string };

const selectableProviders = new Set(["claude", "codex"]);

function selectableRows<T>(rows: T[], provider: (row: T) => string): T[] {
  const filtered = rows.filter((row) => selectableProviders.has(provider(row)));
  return filtered.length === rows.length ? rows : filtered;
}

export function singleProviderRows<T extends Row>(rows: T[]) {
  return selectableRows(rows, (row) => row.id);
}

export function withoutAccountProfiles<T extends Profile>(rows: T[]) {
  return selectableRows(rows, (row) => row.provider);
}

export function installMenuPresentation(
  form: any,
  profiles: any,
  registry: any,
  catalog: any,
  profileState: any,
  settings: any,
) {
  const originalForm = form.useAgentFormState;
  const originalProfiles = profiles.useAgentProfilePicker;
  const originalCatalog = catalog.useAgentProfileFormCatalog;
  const originalState = profileState.useAgentProfileFormState;
  const originalSettings = settings.useSessionSettings;
  const forms = new WeakMap<object, object>();
  const pickers = new WeakMap<object, object>();
  const models = new WeakMap<object, string>();
  const states = new WeakMap<object, object>();
  const sessionSettings = new WeakMap<object, object>();
  const active = (serverId: string) =>
    registry.pluginRegistry
      .getSnapshot()
      .some(
        (plugin: any) =>
          plugin.serverId === serverId &&
          plugin.id === "aster" &&
          !plugin.lifetime.signal.aborted,
      );
  const wrappedForm = (options: any) => {
    const result = originalForm(options);
    if (options.isCreateFlow === false || !active(options.serverId))
      return result;
    if (!forms.has(result)) {
      const rows = singleProviderRows(result.modelSelectorProviders);
      // The original callbacks close over the selected provider. Changing only
      // its displayed id would make the menu disagree with the submitted form.
      forms.set(
        result,
        rows === result.modelSelectorProviders
          ? result
          : { ...result, modelSelectorProviders: rows },
      );
    }
    return forms.get(result);
  };
  const wrappedProfiles = (options: any) => {
    const result = originalProfiles(options);
    if (!result || !active(options.serverId)) return result;
    if (!pickers.has(result)) {
      const rows = withoutAccountProfiles(result.rows);
      pickers.set(result, rows === result.rows ? result : { ...result, rows });
    }
    return pickers.get(result);
  };
  const wrappedCatalog = (options: any) => {
    models.set(options.model, options.serverId);
    return originalCatalog(options);
  };
  const wrappedState = (model: object) => {
    const result = originalState(model);
    const serverId = models.get(model);
    if (!serverId || !active(serverId)) return result;
    if (!states.has(result)) {
      const rows = singleProviderRows(result.providerOptions);
      // Keep the complete catalog for existing profiles' models and modes.
      states.set(
        result,
        rows === result.providerOptions
          ? result
          : { ...result, providerOptions: rows },
      );
    }
    return states.get(result);
  };
  const wrappedSettings = () => {
    const result = originalSettings();
    if (!active(result.hostId)) return result;
    if (!sessionSettings.has(result)) {
      const providers = withoutAccountProfiles(result.providers);
      sessionSettings.set(
        result,
        providers === result.providers ? result : { ...result, providers },
      );
    }
    return sessionSettings.get(result);
  };
  const restore = () => {
    const failures = [];
    for (const [target, name, wrapped, original] of [
      [form, "useAgentFormState", wrappedForm, originalForm],
      [profiles, "useAgentProfilePicker", wrappedProfiles, originalProfiles],
      [catalog, "useAgentProfileFormCatalog", wrappedCatalog, originalCatalog],
      [profileState, "useAgentProfileFormState", wrappedState, originalState],
      [settings, "useSessionSettings", wrappedSettings, originalSettings],
    ]) {
      try {
        if (target[name] === wrapped) target[name] = original;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Aster: 메뉴 확장을 복원하지 못했습니다.",
      );
  };
  try {
    form.useAgentFormState = wrappedForm;
    profiles.useAgentProfilePicker = wrappedProfiles;
    catalog.useAgentProfileFormCatalog = wrappedCatalog;
    profileState.useAgentProfileFormState = wrappedState;
    settings.useSessionSettings = wrappedSettings;
  } catch (error) {
    try {
      restore();
    } catch (failure) {
      throw new AggregateError(
        [error, failure],
        "Aster: 메뉴 확장 초기화와 복원이 실패했습니다.",
      );
    }
    throw error;
  }
  return restore;
}
