import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";

export const secretReferenceSchema = z.object({ kind: z.enum(["dpapi", "secret-service", "keychain"]), value: z.string() });
export type SecretReference = z.infer<typeof secretReferenceSchema>;

export function secretCommand(executable: string, args: string[], input = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: "pipe" });
    let output = "";
    let done = false;
    const finish = (error?: string) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) { child.kill(); reject(new Error(error)); } else resolve(output.trim());
    };
    const timer = setTimeout(() => finish("OS 보안 저장소 응답 시간이 초과되었습니다. 키링 잠금을 확인하세요."), 20_000);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); if (output.length > 65_536) finish("OS 보안 저장소 응답이 너무 큽니다."); });
    child.stderr.resume();
    child.on("error", () => finish("OS 보안 저장소를 실행할 수 없습니다. Linux에서는 libsecret-tools와 로그인 키링이 필요합니다."));
    child.on("close", (code) => finish(code === 0 ? undefined : "OS 보안 저장소를 사용할 수 없습니다. 현재 사용자와 키링 잠금을 확인하세요."));
    child.stdin.on("error", () => finish("OS 보안 저장소에 키를 전달하지 못했습니다."));
    child.stdin.end(input);
  });
}

export class CredentialStore {
  constructor(private platform = process.platform, private run = secretCommand) {}
  private dpapi(mode: "Protect" | "Unprotect", input: string) {
    const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
      "$data=[Convert]::FromBase64String([Console]::In.ReadToEnd()); " +
      `$result=[Security.Cryptography.ProtectedData]::${mode}($data,[Text.Encoding]::UTF8.GetBytes('paseo-nest:settings-sync:v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
      "[Console]::Out.Write([Convert]::ToBase64String($result));";
    const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return this.run(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], input);
  }
  async protect(password: string): Promise<SecretReference> {
    const encoded = Buffer.from(password, "utf8").toString("base64");
    if (this.platform === "win32") return { kind: "dpapi", value: await this.dpapi("Protect", encoded) };
    const id = randomUUID();
    if (this.platform === "linux") { await this.run("secret-tool", ["store", "--label=Paseo Settings Sync", "application", "paseo-nest", "instance", id], encoded); return { kind: "secret-service", value: id }; }
    if (this.platform === "darwin") {
      const command = `add-generic-password -a paseo-nest -s ${id} -w ${encoded}\n`;
      if (Buffer.byteLength(command) >= 4096) throw new Error("macOS 키체인에 저장할 백업 암호의 UTF-8 길이가 너무 큽니다. 더 짧은 암호를 사용하세요.");
      await this.run("security", ["-i"], command);
      return { kind: "keychain", value: id };
    }
    throw new Error("이 OS에서는 백업 키의 보안 저장을 지원하지 않습니다.");
  }
  async reveal(reference: SecretReference) {
    if (reference.kind === "dpapi" && this.platform === "win32") return Buffer.from(await this.dpapi("Unprotect", reference.value), "base64").toString("utf8");
    const id = z.string().uuid().parse(reference.value);
    if (reference.kind === "secret-service" && this.platform === "linux") return Buffer.from(await this.run("secret-tool", ["lookup", "application", "paseo-nest", "instance", id]), "base64").toString("utf8");
    if (reference.kind === "keychain" && this.platform === "darwin") return Buffer.from(await this.run("security", ["find-generic-password", "-a", "paseo-nest", "-s", id, "-w"]), "base64").toString("utf8");
    throw new Error("다른 OS나 사용자에서 저장한 키입니다. 백업 암호로 다시 연결하세요.");
  }
  async remove(reference: SecretReference) {
    if (reference.kind === "dpapi") return;
    const id = z.string().uuid().parse(reference.value);
    if (reference.kind === "secret-service" && this.platform === "linux") await this.run("secret-tool", ["clear", "application", "paseo-nest", "instance", id]);
    if (reference.kind === "keychain" && this.platform === "darwin") await this.run("security", ["delete-generic-password", "-a", "paseo-nest", "-s", id]);
  }
}
