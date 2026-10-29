import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { CredentialStore } from "../../server/credential-store";
import { ClaudeSecureJournal } from "../../server/claude-secure-journal";
import type { ProviderSecureStore } from "../../server/provider-credentials";

/** Only synthetic credentials; this fixture never calls Credential Manager or OAuth. */
export class CrashStore implements ProviderSecureStore {
  mutations = 0;
  constructor(private root: string, private crashAt = Infinity) {}
  private file(service: string, name: string) { return path.join(this.root, createHash("sha256").update(service + "/" + name).digest("hex")); }
  async read(service: string, name: string) {
    try { const file = this.file(service, name); return { value: await readFile(file, "utf8"), updatedAt: (await stat(file)).mtimeMs }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private checkpoint() { if (++this.mutations === this.crashAt) process.exit(23); }
  async write(service: string, name: string, value: string) {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.file(service, name), value, { mode: 0o600 }); this.checkpoint();
  }
  async remove(service: string, name: string) { await rm(this.file(service, name), { force: true }); this.checkpoint(); }
}

export function syntheticJournal(root: string) {
  // Identity DPAPI runner only for synthetic data; AES encryption remains real.
  return new ClaudeSecureJournal(path.join(root, "journal"), new CredentialStore("win32", async (_exe, _args, input = "") => input), async pid => {
    try { process.kill(pid, 0); return String(pid); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return null; throw error; }
  }, async (_key, action) => action(() => {}));
}
