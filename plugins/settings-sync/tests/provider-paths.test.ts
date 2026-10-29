import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { HOME_PATH_PREFIX, PROFILE_PATH_PREFIX, MACHINE_ENV_PREFIX, portableHomePath, profilePathToken, projectProviders, providerFamily, standardVendorCommand } from "../shared/provider-paths";
import { materializeProviders, resolveInstalledExecutable } from "../server/provider-paths";

test("standard native and npm provider paths share a stable command without changing arguments", () => {
  const args = ["--verbose", "argument with spaces", "literal;$value"];
  for (const command of ["C:\\Users\\source\\.local\\bin\\claude.exe", "C:\\Users\\target\\AppData\\Roaming\\npm\\claude.cmd", "C:\\Users\\target\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe", "/home/source/.local/bin/claude", "/opt/homebrew/bin/claude", "claude", "claude.cmd"]) {
    assert.deepEqual(standardVendorCommand([command, ...args], "claude"), ["claude", ...args]);
  }
  for (const vendor of ["codex", "copilot", "opencode", "pi", "omp"]) {
    assert.deepEqual(standardVendorCommand([`C:\\Users\\source\\AppData\\Roaming\\npm\\${vendor}.cmd`, "--synthetic"], vendor), [vendor, "--synthetic"]);
  }
});

test("known npm Node launchers normalize while custom scripts and wrappers remain exact", () => {
  const codex = ["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\source\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js", "--synthetic"];
  assert.deepEqual(standardVendorCommand(codex, "codex"), ["codex", "--synthetic"]);
  assert.deepEqual(standardVendorCommand(["node", "/home/source/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js", "--verbose"], "claude"), ["claude", "--verbose"]);
  for (const command of [["node", "/custom/wrapper.js"], ["powershell.exe", "-File", "C:\\custom\\claude.ps1"], ["C:\\custom\\claude.exe"], ["./claude.cmd"]]) {
    assert.equal(standardVendorCommand(command, "claude"), null);
    assert.deepEqual(projectProviders({ claude: { command } }).claude.command, command);
  }
});

test("derived profiles normalize their vendor command and unrelated ACP commands are preserved", () => {
  const providers = { claude: {}, work: { extends: "claude", command: ["/usr/local/bin/claude", "--verbose"] }, child: { extends: "work" }, cursor: { extends: "acp", command: ["D:\\custom\\cursor-agent.cmd", "acp"] }, cycle: { extends: "cycle" } };
  assert.equal(providerFamily("child", providers), "claude");
  assert.equal(providerFamily("cycle", providers), null);
  const projected = projectProviders(providers);
  assert.deepEqual(projected.work.command, ["claude", "--verbose"]);
  assert.deepEqual(projected.cursor.command, providers.cursor.command);
  assert.equal(providers.work.command[0], "/usr/local/bin/claude");
});

test("profile paths use per-provider tokens and ordinary home paths preserve their relative suffix", () => {
  const providers = { work: { extends: "claude", env: { CLAUDE_CONFIG_DIR: "D:\\profiles\\work", CLAUDE_SECURESTORAGE_CONFIG_DIR: "D:\\profiles\\keyring", EXTRA_FILE: "C:\\Users\\source\\assets\\models.json", ENDPOINT: "https://example.invalid/api", PATH: "C:\\Users\\source\\bin;C:\\Windows" } } };
  const projected = projectProviders(providers, { home: "C:\\Users\\source" });
  assert.deepEqual(projected.work.env, { CLAUDE_CONFIG_DIR: profilePathToken("work", "CLAUDE_CONFIG_DIR"), CLAUDE_SECURESTORAGE_CONFIG_DIR: profilePathToken("work", "CLAUDE_SECURESTORAGE_CONFIG_DIR"), EXTRA_FILE: `${HOME_PATH_PREFIX}assets/models.json`, ENDPOINT: "https://example.invalid/api", PATH: `${MACHINE_ENV_PREFIX}PATH` });
  assert.equal(portableHomePath("/home/source/file.json"), `${HOME_PATH_PREFIX}file.json`);
  assert.equal(portableHomePath("C:\\Users\\source-other\\file.json", { home: "C:\\Users\\source" }), "C:\\Users\\source-other\\file.json");
  assert.equal(portableHomePath("C:\\Users\\source\\..\\elsewhere", { home: "C:\\Users\\source" }), "C:\\Users\\source\\..\\elsewhere");
});

test("materialization validates installed CLIs and recaptures the same portable commands and profiles", async () => {
  const raw = { work: { extends: "claude", command: ["C:\\Users\\source\\.local\\bin\\claude.exe", "--verbose"], env: { CLAUDE_CONFIG_DIR: "C:\\Users\\source\\profiles\\work", EXTRA_FILE: "C:\\Users\\source\\assets\\data.json" } }, codex: { command: ["/usr/local/bin/codex"] } };
  const projected = projectProviders(raw);
  const resolved: string[] = [];
  const installed = await materializeProviders(projected, {}, { home: "C:\\Users\\target", platform: "win32", profileDirectories: { work: { CLAUDE_CONFIG_DIR: "D:\\paseo-home\\settings-sync\\provider-profiles\\stable-id" } }, resolveExecutable: async (name) => { resolved.push(name); return `C:\\Users\\target\\AppData\\Roaming\\npm\\${name}.cmd`; } });
  assert.deepEqual(resolved, ["claude", "codex"]);
  assert.deepEqual(installed.work.command, ["C:\\Users\\target\\AppData\\Roaming\\npm\\claude.cmd", "--verbose"]);
  assert.deepEqual(installed.work.env, { CLAUDE_CONFIG_DIR: "D:\\paseo-home\\settings-sync\\provider-profiles\\stable-id", EXTRA_FILE: "C:\\Users\\target\\assets\\data.json" });
  assert.deepEqual(projectProviders(installed, { home: "C:\\Users\\target" }), projected);
});

test("materialization supports POSIX profile and home directories without introducing Windows paths", async () => {
  const projected = projectProviders({ codex: { env: { CODEX_HOME: "C:\\Users\\source\\.codex-work", EXTRA: "C:\\Users\\source\\assets\\file" } } });
  const installed = await materializeProviders(projected, {}, { home: "/home/target", platform: "linux", resolveExecutable: async () => "/usr/bin/codex" });
  assert.deepEqual(installed.codex.env, { CODEX_HOME: "/home/target/.paseo/settings-sync/provider-profiles/codex", EXTRA: "/home/target/assets/file" });
  assert.deepEqual(projectProviders(installed, { home: "/home/target" }), projected);
});

test("existing account directories remain local even when the incoming backup has no credential records", async () => {
  const current = { claude: { env: { CLAUDE_CONFIG_DIR: "C:\\Users\\target\\.claude", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" } }, work: { extends: "claude", env: { CLAUDE_CONFIG_DIR: "D:\\accounts\\work", CLAUDE_SECURESTORAGE_CONFIG_DIR: "D:\\accounts\\work-keyring" } } };
  const cloud = projectProviders({ claude: { env: { CLAUDE_CONFIG_DIR: "/home/source/.claude", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/home/source/.claude" } }, work: { extends: "claude", env: { CLAUDE_CONFIG_DIR: "/home/source/work", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/home/source/work" } } });
  const restored = await materializeProviders(cloud, current, { home: "C:\\Users\\target", platform: "win32" });
  assert.deepEqual(restored, current);
  assert.deepEqual(projectProviders(restored), cloud);
  const override = await materializeProviders(cloud, current, { profileDirectories: { work: { CLAUDE_CONFIG_DIR: "/explicit/profile" } } });
  assert.equal((override.work.env as Record<string, string>).CLAUDE_CONFIG_DIR, "/explicit/profile");
});

test("existing custom wrappers cannot be silently overwritten by a standard vendor command", async () => {
  const current = { claude: { command: ["D:\\custom\\claude-wrapper.cmd", "--custom"] } };
  await assert.rejects(materializeProviders({ claude: { command: ["claude"] } }, current, { resolveExecutable: async () => "C:\\bin\\claude.cmd" }), /기기 전용 실행 명령/);
  assert.deepEqual(current.claude.command, ["D:\\custom\\claude-wrapper.cmd", "--custom"]);
  const installed = await materializeProviders(current, current, { exists: async (file) => file === current.claude.command[0] });
  assert.deepEqual(installed, current);
});

test("missing active commands fail clearly while disabled providers need no installed CLI", async () => {
  await assert.rejects(materializeProviders({ claude: { enabled: true, command: ["claude"] } }, {}, { resolveExecutable: async () => null }), /claude CLI/);
  assert.deepEqual(await materializeProviders({ claude: { enabled: true } }, {}, { resolveExecutable: async () => { throw Error("default SDK command is resolved by Paseo"); } }), { claude: { enabled: true } });
  const disabled = { claude: { enabled: false, command: ["C:\\Users\\source\\.local\\bin\\claude.exe"] }, unknown: { enabled: false, command: ["D:\\custom\\missing.cmd"] } };
  const installed = await materializeProviders(disabled, {}, { resolveExecutable: async () => { throw Error("must not resolve disabled provider"); }, exists: async () => { throw Error("must not inspect disabled provider"); } });
  assert.deepEqual(installed.claude.command, ["claude"]);
  assert.deepEqual(installed.unknown.command, disabled.unknown.command);
});

test("Cursor ACP standard launchers move with their profile directories while custom launchers stay exact", async () => {
  assert.deepEqual(standardVendorCommand(["C:\\Users\\source\\AppData\\Local\\cursor-agent\\cursor-agent.cmd", "acp"], "cursor"), ["cursor-agent", "acp"]);
  const raw = { cursor: { extends: "acp", command: ["C:\\Users\\source\\.local\\bin\\cursor-agent.cmd", "acp"], env: { APPDATA: "C:\\Users\\source\\AppData\\Roaming", XDG_CONFIG_HOME: "/home/source/.config" } } };
  const projected = projectProviders(raw);
  assert.deepEqual(projected.cursor.command, ["cursor-agent", "acp"]);
  const installed = await materializeProviders(projected, {}, { home: "/home/target", platform: "linux", resolveExecutable: async (name) => name === "cursor-agent" ? "/home/target/.local/bin/cursor-agent" : null });
  assert.deepEqual(installed.cursor.env, { APPDATA: "/home/target/.paseo/settings-sync/provider-profiles/cursor/roaming", XDG_CONFIG_HOME: "/home/target/.paseo/settings-sync/provider-profiles/cursor/config" });
  assert.deepEqual(projectProviders(installed), projected);
  const custom = { cursor: { extends: "acp", command: ["D:\\custom\\cursor-agent.cmd", "acp"] } };
  assert.deepEqual(projectProviders(custom).cursor.command, custom.cursor.command);
});

test("custom absolute commands are checked literally and never replaced with their basename", async () => {
  const resolved: string[] = [];
  await assert.rejects(materializeProviders({ custom: { extends: "acp", command: ["D:\\custom\\cursor-agent.cmd", "acp"] } }, {}, { exists: async () => false, resolveExecutable: async (name) => { resolved.push(name); return "C:\\wrong\\cursor-agent.cmd"; } }), /사용자 지정 실행 명령/);
  assert.deepEqual(resolved, []);
});

test("installed executable discovery uses synthetic PATH and PATHEXT without running a process", async () => {
  const checked: string[] = [];
  const resolved = await resolveInstalledExecutable("claude", { home: "C:\\Users\\target", platform: "win32", env: { Path: '"C:\\Tools";C:\\Users\\target\\AppData\\Roaming\\npm', PATHEXT: ".EXE;.CMD" }, exists: async (candidate) => { checked.push(candidate); return candidate === "C:\\Users\\target\\AppData\\Roaming\\npm\\claude.cmd"; } });
  assert.equal(resolved, "C:\\Users\\target\\AppData\\Roaming\\npm\\claude.cmd");
  assert.ok(checked.includes("C:\\Tools\\claude.exe"));
  assert.equal(await resolveInstalledExecutable("codex", { home: "/home/target", platform: "linux", env: { PATH: "/missing:/bin" }, exists: async (candidate) => candidate === "/home/target/.local/bin/codex" }), "/home/target/.local/bin/codex");
  assert.equal(await resolveInstalledExecutable("cursor-agent", { home: "C:\\Users\\target", platform: "win32", env: {}, exists: async (candidate) => candidate === "C:\\Users\\target\\AppData\\Local\\cursor-agent\\cursor-agent.cmd" }), "C:\\Users\\target\\AppData\\Local\\cursor-agent\\cursor-agent.cmd");
});

test("Windows executable discovery skips POSIX and PowerShell shims and prefers native launchers", async () => {
  const directory = "C:\\Users\\target\\AppData\\Roaming\\npm";
  const options = { home: "C:\\Users\\target", platform: "win32" as const, env: { PATH: directory, PATHEXT: ".PS1;;.BAT;.CMD;.EXE;.COM" } };
  const checked: string[] = [];
  const files = new Set(["codex", "codex.ps1", "codex.cmd", "codex.bat", "codex.com", "codex.exe"].map((name) => path.win32.join(directory, name)));
  const exists = async (candidate: string) => { checked.push(candidate); return files.has(candidate); };
  for (const suffix of [".exe", ".com", ".cmd", ".bat"]) {
    assert.equal(await resolveInstalledExecutable("codex", { ...options, exists }), path.win32.join(directory, `codex${suffix}`));
    files.delete(path.win32.join(directory, `codex${suffix}`));
  }
  assert.equal(await resolveInstalledExecutable("codex", { ...options, exists }), null);
  assert.equal(checked.includes(path.win32.join(directory, "codex")), false);
  assert.equal(checked.includes(path.win32.join(directory, "codex.ps1")), false);
  assert.equal(await resolveInstalledExecutable("codex.ps1", { ...options, exists }), null);
  files.add(path.win32.join(directory, "codex.cmd"));
  assert.equal(await resolveInstalledExecutable("codex.cmd", { ...options, exists }), path.win32.join(directory, "codex.cmd"));
  const restored = await materializeProviders({ codex: { command: ["codex"] } }, {}, { ...options, exists });
  assert.deepEqual(restored.codex.command, [path.win32.join(directory, "codex.cmd")]);
});

test("materialization rejects traversal and mismatched profile tokens", async () => {
  for (const invalid of [`${HOME_PATH_PREFIX}../escape`, `${HOME_PATH_PREFIX}C:/escape`, `${HOME_PATH_PREFIX}folder\\escape`]) {
    await assert.rejects(materializeProviders({ custom: { env: { FILE: invalid } } }, {}), /ホーム|홈 경로/);
  }
  await assert.rejects(materializeProviders({ claude: { enabled: false, env: { CLAUDE_CONFIG_DIR: `${PROFILE_PATH_PREFIX}other:CLAUDE_CONFIG_DIR` } } }, {}), /프로필 경로/);
});

test("machine environment variables bind to the target while preserving existing target overrides", async () => {
  const incoming = projectProviders({ claude: { enabled: false, env: { PATH: "C:\\source\\bin;C:\\Windows", PATHEXT: ".EXE;.CMD", HOME: "C:\\Users\\source", APPDATA: "C:\\Users\\source\\AppData\\Roaming", TEMP: "C:\\source\\temp" } } });
  const current = { claude: { env: { PATH: "/target/custom/bin:/usr/bin" } } };
  const installed = await materializeProviders(incoming, current, { home: "/home/target", platform: "linux", env: { HOME: "/home/target", PATH: "/system/bin", TEMP: "/target/temp" } });
  assert.deepEqual(installed.claude.env, { PATH: "/target/custom/bin:/usr/bin", PATHEXT: "", HOME: "/home/target", APPDATA: "/home/target/.config", TEMP: "/target/temp" });
  assert.deepEqual(projectProviders(installed), incoming);
});

test("separate home path arguments of standard CLIs rebase without changing flags or custom argv", async () => {
  const raw = { claude: { command: ["C:\\Users\\source\\.local\\bin\\claude.exe", "--settings", "C:\\Users\\source\\settings\\claude.json", "--name=value"] } };
  const projected = projectProviders(raw);
  assert.deepEqual(projected.claude.command, ["claude", "--settings", `${HOME_PATH_PREFIX}settings/claude.json`, "--name=value"]);
  const installed = await materializeProviders(projected, {}, { home: "/home/target", platform: "linux", resolveExecutable: async () => "/usr/local/bin/claude" });
  assert.deepEqual(installed.claude.command, ["/usr/local/bin/claude", "--settings", "/home/target/settings/claude.json", "--name=value"]);
  assert.deepEqual(projectProviders(installed), projected);
  const wrapper = { claude: { command: ["D:\\custom\\wrapper.exe", "C:\\Users\\source\\custom-settings.json"] } };
  assert.deepEqual(projectProviders(wrapper), wrapper);
});

test("repeated cross-device materialization converges to one canonical provider configuration", async () => {
  const original = { claude: { command: ["C:\\Users\\source\\.local\\bin\\claude.exe", "--verbose"], env: { CLAUDE_CONFIG_DIR: "C:\\Users\\source\\claude-profiles\\work", HOME: "C:\\Users\\source" } }, codex: { command: ["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\source\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"] } };
  const expected = projectProviders(original);
  let portable = expected;
  for (let iteration = 0; iteration < 4; iteration++) {
    const native = await materializeProviders(portable, {}, { home: "C:\\Users\\source", platform: "win32", env: { HOME: "C:\\Users\\source" }, resolveExecutable: async (name) => `C:\\Users\\source\\.local\\bin\\${name}.exe` });
    portable = projectProviders(native);
    assert.deepEqual(portable, expected);
    const npm = await materializeProviders(portable, {}, { home: "C:\\Users\\target", platform: "win32", env: { HOME: "C:\\Users\\target" }, resolveExecutable: async (name) => `C:\\Users\\target\\AppData\\Roaming\\npm\\${name}.cmd` });
    portable = projectProviders(npm);
    assert.deepEqual(portable, expected);
  }
});
