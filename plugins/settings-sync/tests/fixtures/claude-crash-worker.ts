import { readFile } from "node:fs/promises";
import path from "node:path";
import { ProviderCredentialSync, runProviderSecret, WindowsProviderSecureStore } from "../../server/provider-credentials";
import { ClaudeSecureJournal } from "../../server/claude-secure-journal";
import { CrashStore, syntheticJournal } from "./claude-crash-store";

const [root, boundary, action] = process.argv.slice(2);
const fixture = JSON.parse(await readFile(path.join(root, "input.json"), "utf8"));
let mutations = 0;
const native = new WindowsProviderSecureStore(async (executable, args, input) => {
  const result = await runProviderSecret(executable, args, input);
  if (JSON.parse(input).operation !== "read" && ++mutations === Number(boundary)) process.exit(23);
  return result;
});
const sync = new ProviderCredentialSync({ home: fixture.home, userHome: fixture.userHome, platform: "win32", env: {}, secure: fixture.native ? native : new CrashStore(path.join(root, "secure"), Number(boundary)), journal: fixture.native ? new ClaudeSecureJournal(path.join(root, "journal")) : syntheticJournal(root) });
if (action === "capture") await sync.capture(fixture.providers);
else await (await sync.restore(fixture.providers, fixture.incoming, fixture.providers)).commit();
throw Error("Abrupt exit boundary was not reached");
