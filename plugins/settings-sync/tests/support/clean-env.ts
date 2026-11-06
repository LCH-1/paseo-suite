// Tests must never reach the real login of the session that happens to run them.
for (const name of Object.keys(process.env)) {
  if (/^(CLAUDE|ANTHROPIC|PASEO|ASTER|CODEX|OPENAI)_/.test(name) || name === "CLAUDECODE") delete process.env[name];
}
