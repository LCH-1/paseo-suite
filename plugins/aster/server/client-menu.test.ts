import assert from "node:assert/strict";
import test from "node:test";
import { installMenuPresentation, singleClaudeRows } from "../client/menu.ts";

test("기본 Claude가 있으면 관리 계정만 접고 커스텀 연결은 보존한다", () => {
  const rows = ["claude", "claude-second", "mengsk-claude", "codex"].map((id) => ({ id }));
  assert.deepEqual(singleClaudeRows(rows).map((row) => row.id), ["claude", "mengsk-claude", "codex"]);
  const existing = [{ id: "claude-second" }];
  assert.equal(singleClaudeRows(existing), existing);
});

test("Aster 호스트만 통합하고 기존 대화와 해제 시 원래 동작을 보존한다", () => {
  let enabled = true;
  const result = { selectedProvider: "claude-second", modelSelectorProviders: [{ id: "claude" }, { id: "claude-second" }, { id: "codex" }] };
  const picker = { rows: [{ provider: "claude" }, { provider: "claude-second" }, { provider: "codex" }], applyProfile: () => {} };
  const form = { useAgentFormState: (_: any) => result };
  const profiles = { useAgentProfilePicker: (_: any) => picker };
  const originalForm = form.useAgentFormState;
  const originalProfiles = profiles.useAgentProfilePicker;
  const registry = { pluginRegistry: { getSnapshot: () => enabled ? [{ id: "aster", serverId: "local", lifetime: { signal: { aborted: false } } }] : [] } };
  const dispose = installMenuPresentation(form, profiles, registry);
  const local = form.useAgentFormState({ serverId: "local" });
  assert.deepEqual(local.modelSelectorProviders.map((row) => row.id), ["claude", "codex"]);
  assert.equal(local.selectedProvider, "claude");
  assert.equal(form.useAgentFormState({ serverId: "local" }), local);
  assert.equal(form.useAgentFormState({ serverId: "remote" }), result);
  assert.equal(form.useAgentFormState({ serverId: "local", isCreateFlow: false }), result);
  assert.deepEqual(profiles.useAgentProfilePicker({ serverId: "local" }).rows, [{ provider: "codex" }]);
  assert.equal(profiles.useAgentProfilePicker({ serverId: "remote" }), picker);
  enabled = false;
  assert.equal(form.useAgentFormState({ serverId: "local" }), result);
  dispose();
  assert.equal(form.useAgentFormState, originalForm);
  assert.equal(profiles.useAgentProfilePicker, originalProfiles);
});
