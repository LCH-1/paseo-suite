import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";

async function pluginCommand(home: string, command: string[]) {
  const cli = process.env.PASEO_CLI ?? "paseo";
  const windows = process.platform === "win32";
  const script = "$ErrorActionPreference='Stop'; $p=ConvertFrom-Json ([Console]::In.ReadToEnd()); $arguments=@($p.arguments); & $p.cli @arguments --json --home $p.home; exit $LASTEXITCODE;";
  const executable = windows ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : cli;
  const args = windows ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] : [...command, "--json", "--home", home];
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: "pipe" });
    let output = "", done = false;
    const timer = setTimeout(() => finish(false), 20_000);
    function finish(ok: boolean) { if (done) return; done = true; clearTimeout(timer); if (ok) resolve(output); else { child.kill(); reject(new Error("복원 플러그인의 실행 상태를 확인하지 못했습니다.")); } }
    child.stdout.on("data", (chunk) => { output += chunk.toString(); if (output.length > 4 * 1024 * 1024) finish(false); });
    child.stderr.resume(); child.on("error", () => finish(false)); child.stdin.on("error", () => finish(false)); child.on("close", (code) => finish(code === 0));
    child.stdin.end(windows ? JSON.stringify({ cli, home, arguments: command }) : "");
  });
  return raw;
}

async function installedPlugins(home: string): Promise<{ id: string; status: string; path: string; error?: string }[]> {
  const raw = await pluginCommand(home, ["plugin", "ls"]);
  return z.array(z.object({ id: z.string(), status: z.string(), path: z.string(), error: z.string().optional() })).parse(JSON.parse(raw));
}

async function reloadPlugin(home: string, id: string) {
  await pluginCommand(home, ["plugin", "reload", id]);
}

export async function verifyPlugins(home: string, plugins: { id: string; path: string }[], read = installedPlugins, reload = read === installedPlugins ? reloadPlugin : undefined) {
  if (!plugins.length) return;
  if (reload) {
    for (const plugin of plugins) await reload(home, plugin.id);
  }
  const normalized = (file: string) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
  for (let attempt = 0; attempt < 10; attempt++) {
    const entries = await read(home);
    const matching = (plugin: typeof plugins[number]) => entries.find((entry) => entry.id === plugin.id && normalized(entry.path) === normalized(plugin.path));
    const failed = plugins.filter((plugin) => {
      const entry = matching(plugin);
      return entry?.status === "failed" && Boolean(entry.error);
    });
    if (failed.length) throw new Error(`복원한 플러그인 실행에 실패했습니다: ${failed.map((plugin) => plugin.id).join(", ")}. 원래 서버 설정으로 복구합니다. paseo plugin logs <플러그인 ID>로 원인을 확인하세요.`);
    if (plugins.every((plugin) => matching(plugin)?.status === "running")) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`복원한 플러그인이 실행 상태가 되지 않았습니다: ${plugins.map((plugin) => plugin.id).join(", ")}. 원래 서버 설정으로 복구합니다.`);
}
