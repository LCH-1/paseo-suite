import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

export const commandSchema = z.object({ file: z.string(), args: z.array(z.string()) });
export type Command = z.infer<typeof commandSchema>;

export function defaultCommand(): Command {
  if (process.env.PASEO_CLI) return { file: process.env.PASEO_CLI, args: [] };
  if (process.platform === "win32") {
    const directory = basename(process.execPath).toLowerCase() === "paseo.exe" ? dirname(process.execPath) : join(process.env.ProgramFiles ?? "C:/Program Files", "Paseo");
    const file = join(directory, "resources", "bin", "paseo.cmd");
    if (existsSync(file)) return { file, args: [] };
  }
  return { file: "paseo", args: [] };
}

export function portableCommand(command: Command) {
  return command.args.length === 1 && /(?:^|\/)node_modules\/@getpaseo\/cli\/dist\/index\.js$/.test(command.args[0].replaceAll("\\", "/")) ? defaultCommand() : command;
}

export function runPaseo(command: Command, args: string[], signal: AbortSignal, timeout = 18_000) {
  return new Promise<string>((resolve, reject) => {
    const indirect = process.platform === "win32" && !/\.exe$/i.test(command.file);
    const script = "$ErrorActionPreference='Stop'; $p=ConvertFrom-Json ([Console]::In.ReadToEnd()); $arguments=@($p.args); & $p.file @arguments; exit $LASTEXITCODE;";
    const file = indirect ? join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : command.file;
    const parameters = indirect ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] : [...command.args, ...args];
    const child = execFile(file, parameters, {
      windowsHide: true, timeout, signal,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    }, (error, stdout) => {
      if (error) reject(new Error(`Paseo ${args[0]} 실행 실패 (${error.code})`));
      else resolve(stdout);
    });
    if (indirect) {
      child.stdin!.on("error", () => reject(new Error("Paseo 명령 입력에 실패했습니다.")));
      child.stdin!.end(JSON.stringify({ file: command.file, args: [...command.args, ...args] }));
    }
  });
}
