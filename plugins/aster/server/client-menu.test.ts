import assert from "node:assert/strict";
import test from "node:test";
import {
  installMenuPresentation,
  singleProviderRows,
  withoutAccountProfiles,
} from "../client/menu.ts";

test("공급자 선택은 Claude와 Codex만 남기고 원본 목록을 보존한다", () => {
  const rows = [
    "claude",
    "claude-second",
    "mengsk-claude",
    "codex",
    "codex-account",
    "cursor",
  ].map((id) => Object.freeze({ id, label: id }));
  Object.freeze(rows);
  assert.deepEqual(singleProviderRows(rows), [rows[0], rows[3]]);
  assert.deepEqual(
    rows.map((row) => row.id),
    [
      "claude",
      "claude-second",
      "mengsk-claude",
      "codex",
      "codex-account",
      "cursor",
    ],
  );
  const canonical = [{ id: "claude" }, { id: "codex" }];
  assert.equal(singleProviderRows(canonical), canonical);
  const empty: { id: string }[] = [];
  assert.equal(singleProviderRows(empty), empty);
});

test("기본 공급자가 없을 때 계정 별칭을 대표 공급자로 추측하지 않는다", () => {
  const aliases = [
    { id: "claude-second" },
    { id: "mengsk-claude" },
    { id: "codex-account" },
  ];
  assert.deepEqual(singleProviderRows(aliases), []);
  assert.deepEqual(
    aliases.map((row) => row.id),
    ["claude-second", "mengsk-claude", "codex-account"],
  );
});

test("Claude와 Codex의 일반 모델 프리셋은 남기고 계정별 프로필은 숨긴다", () => {
  const rows = [
    { id: "claude-fast", provider: "claude", modelId: "sonnet" },
    { id: "claude-deep", provider: "claude", modelId: "opus" },
    { id: "codex-deep", provider: "codex", modelId: "gpt" },
    { id: "account", provider: "claude-second", modelId: "opus" },
    { id: "custom", provider: "mengsk-claude", modelId: "opus" },
    { id: "codex-account", provider: "codex-second", modelId: "gpt" },
    { id: "cursor", provider: "cursor", modelId: "auto" },
  ];
  Object.freeze(rows);
  assert.deepEqual(withoutAccountProfiles(rows), rows.slice(0, 3));
  assert.equal(rows.length, 7);
});

function fixture() {
  let enabled = true;
  const result = {
    selectedProvider: "claude-second",
    modelSelectorProviders: [
      "claude",
      "claude-second",
      "mengsk-claude",
      "codex",
      "codex-second",
      "cursor",
    ].map((id) => ({ id })),
    persistFormPreferences: () => "claude-second",
    setProviderAndModelFromUser() {},
  };
  const picker = {
    rows: [
      { provider: "claude" },
      { provider: "claude-second" },
      { provider: "codex" },
      { provider: "codex-second" },
    ],
    applyProfile: () => "original profile action",
  };
  const form = { useAgentFormState: (_: any) => result };
  const profiles = { useAgentProfilePicker: (_: any) => picker };
  const catalogInputs: any[] = [];
  const catalog = {
    useAgentProfileFormCatalog(input: any) {
      catalogInputs.push(input);
    },
  };
  const profileState = {
    useAgentProfileFormState: (model: any) => model.getState(),
  };
  let settingsResult = {
    hostId: "local",
    providers: [
      { provider: "claude" },
      { provider: "claude-second" },
      { provider: "codex" },
      { provider: "codex-second" },
      { provider: "cursor" },
    ],
    entry: { provider: "claude-second" },
    state: { provider: "claude-second" },
    models: [{ id: "stored-model" }],
    apply: () => "original apply",
    save: () => "original save",
    disabled: false,
  };
  const settings = { useSessionSettings: () => settingsResult };
  const originalForm = form.useAgentFormState;
  const originalProfiles = profiles.useAgentProfilePicker;
  const originalCatalog = catalog.useAgentProfileFormCatalog;
  const originalState = profileState.useAgentProfileFormState;
  const originalSettings = settings.useSessionSettings;
  const registry = {
    pluginRegistry: {
      getSnapshot: () =>
        enabled
          ? [
              {
                id: "aster",
                serverId: "local",
                lifetime: { signal: { aborted: false } },
              },
            ]
          : [],
    },
  };
  const dispose = installMenuPresentation(
    form,
    profiles,
    registry,
    catalog,
    profileState,
    settings,
  );
  return {
    result,
    picker,
    form,
    profiles,
    catalog,
    profileState,
    settings,
    catalogInputs,
    originalForm,
    originalProfiles,
    originalCatalog,
    originalState,
    originalSettings,
    dispose,
    get settingsResult() {
      return settingsResult;
    },
    setSettingsHost(hostId: string) {
      settingsResult = { ...settingsResult, hostId };
    },
    disable() {
      enabled = false;
    },
  };
}

test("활성 호스트의 새 대화와 프로필만 통합하고 선택 값과 원래 동작은 보존한다", () => {
  const f = fixture();
  try {
    const local = f.form.useAgentFormState({ serverId: "local" });
    assert.deepEqual(
      local.modelSelectorProviders.map((row) => row.id),
      ["claude", "codex"],
    );
    assert.equal(local.selectedProvider, "claude-second");
    assert.equal(local.persistFormPreferences, f.result.persistFormPreferences);
    assert.equal(local.persistFormPreferences(), "claude-second");
    assert.equal(
      local.setProviderAndModelFromUser,
      f.result.setProviderAndModelFromUser,
    );
    assert.equal(f.form.useAgentFormState({ serverId: "local" }), local);
    assert.equal(f.form.useAgentFormState({ serverId: "remote" }), f.result);
    assert.equal(
      f.form.useAgentFormState({ serverId: "local", isCreateFlow: false }),
      f.result,
    );
    const picker = f.profiles.useAgentProfilePicker({ serverId: "local" });
    assert.deepEqual(picker.rows, [
      { provider: "claude" },
      { provider: "codex" },
    ]);
    assert.equal(picker.applyProfile, f.picker.applyProfile);
    assert.equal(picker.applyProfile(), "original profile action");
    assert.equal(
      f.profiles.useAgentProfilePicker({ serverId: "remote" }),
      f.picker,
    );
    assert.deepEqual(
      f.result.modelSelectorProviders.map((row) => row.id),
      [
        "claude",
        "claude-second",
        "mengsk-claude",
        "codex",
        "codex-second",
        "cursor",
      ],
    );
    assert.equal(f.picker.rows.length, 4);
    f.disable();
    assert.equal(f.form.useAgentFormState({ serverId: "local" }), f.result);
    assert.equal(
      f.profiles.useAgentProfilePicker({ serverId: "local" }),
      f.picker,
    );
  } finally {
    f.dispose();
  }
  assert.equal(f.form.useAgentFormState, f.originalForm);
  assert.equal(f.profiles.useAgentProfilePicker, f.originalProfiles);
  assert.equal(f.catalog.useAgentProfileFormCatalog, f.originalCatalog);
  assert.equal(f.profileState.useAgentProfileFormState, f.originalState);
  assert.equal(f.settings.useSessionSettings, f.originalSettings);
});

test("프로필 편집은 선택지만 정리하고 원본 카탈로그와 별칭 모델·제출 값은 유지한다", () => {
  const f = fixture();
  const entries = [
    Object.freeze({ provider: "claude", enabled: true }),
    Object.freeze({ provider: "codex", enabled: false }),
    Object.freeze({ provider: "claude-second", enabled: true }),
    Object.freeze({ provider: "mengsk-claude", enabled: true }),
    Object.freeze({ provider: "cursor", enabled: true }),
  ];
  Object.freeze(entries);
  const received: any[][] = [];
  const storedState = {
    provider: "claude-second",
    providerOptions: [
      { id: "claude" },
      { id: "claude-second" },
      { id: "mengsk-claude" },
      { id: "cursor" },
    ],
    modelOptions: [{ id: "stored-model", label: "Stored model" }],
    submitValue: {
      provider: "claude-second",
      model: "stored-model",
      name: "Legacy profile",
    },
  };
  const applyProviderCatalog = (next: any[]) => {
    received.push(next);
  };
  const model = { applyProviderCatalog, getState: () => storedState };
  const input = { serverId: "local", model };
  try {
    assert.equal(f.profileState.useAgentProfileFormState(model), storedState);
    f.catalog.useAgentProfileFormCatalog(input);
    assert.equal(f.catalogInputs[0], input);
    assert.equal(f.catalogInputs[0].model, model);
    f.catalogInputs[0].model.applyProviderCatalog(entries);
    assert.equal(received[0], entries);
    assert.equal(model.applyProviderCatalog, applyProviderCatalog);
    const visible = f.profileState.useAgentProfileFormState(model);
    assert.deepEqual(visible.providerOptions, [{ id: "claude" }]);
    assert.equal(visible.provider, "claude-second");
    assert.equal(visible.modelOptions, storedState.modelOptions);
    assert.equal(visible.submitValue, storedState.submitValue);
    assert.equal(f.profileState.useAgentProfileFormState(model), visible);
    assert.equal(model.getState(), storedState);
    assert.equal(storedState.providerOptions.length, 4);
  } finally {
    f.dispose();
  }
});

test("프로필 모델의 호스트 등록은 다른 모델과 비활성 호스트에 영향을 주지 않는다", () => {
  const f = fixture();
  const state = {
    providerOptions: [
      { id: "claude" },
      { id: "codex" },
      { id: "claude-second" },
    ],
  };
  const otherState = {
    providerOptions: [{ id: "claude" }, { id: "codex-second" }],
  };
  const model = { getState: () => state };
  const otherModel = { getState: () => otherState };
  try {
    f.catalog.useAgentProfileFormCatalog({ serverId: "local", model });
    f.catalog.useAgentProfileFormCatalog({
      serverId: "remote",
      model: otherModel,
    });
    assert.deepEqual(
      f.profileState.useAgentProfileFormState(model).providerOptions,
      state.providerOptions.slice(0, 2),
    );
    assert.equal(
      f.profileState.useAgentProfileFormState(otherModel),
      otherState,
    );
    f.catalog.useAgentProfileFormCatalog({ serverId: "remote", model });
    assert.equal(f.profileState.useAgentProfileFormState(model), state);
    f.catalog.useAgentProfileFormCatalog({ serverId: "local", model });
    f.disable();
    assert.equal(f.profileState.useAgentProfileFormState(model), state);
  } finally {
    f.dispose();
  }
});

test("세션 기본 설정은 공급자 선택지만 정리하고 현재 별칭과 저장·적용 동작은 보존한다", () => {
  const f = fixture();
  const original = f.settingsResult;
  try {
    const visible = f.settings.useSessionSettings();
    assert.deepEqual(visible.providers, [
      original.providers[0],
      original.providers[2],
    ]);
    assert.equal(visible.entry, original.entry);
    assert.equal(visible.state, original.state);
    assert.equal(visible.models, original.models);
    assert.equal(visible.apply, original.apply);
    assert.equal(visible.save, original.save);
    assert.equal(visible.disabled, original.disabled);
    assert.equal(visible.apply(), "original apply");
    assert.equal(visible.save(), "original save");
    assert.equal(f.settings.useSessionSettings(), visible);
    assert.deepEqual(
      original.providers.map((row) => row.provider),
      ["claude", "claude-second", "codex", "codex-second", "cursor"],
    );
    f.setSettingsHost("remote");
    assert.equal(f.settings.useSessionSettings(), f.settingsResult);
    f.setSettingsHost("local");
    f.disable();
    assert.equal(f.settings.useSessionSettings(), f.settingsResult);
  } finally {
    f.dispose();
  }
  assert.equal(f.settings.useSessionSettings, f.originalSettings);
});
