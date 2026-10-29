import assert from "node:assert/strict";
import { test } from "node:test";
import { providerDiagnostics } from "../server/diagnostics";
import { ProviderCredentialSync } from "../server/provider-credentials";
import { Environment } from "../server/environment";

test("provider diagnostics distinguish runtime capture without exposing credential or config values", async (context) => {
  context.mock.method(ProviderCredentialSync.prototype, "capture", async () => ({ credentials: { records: [{ providerIds: ["claude"], credential: { accessToken: "synthetic-private-value" } }] }, status: [{ vendor: "claude", providerIds: ["claude"], status: "available", store: "windows-credman" }] }));
  context.mock.method(Environment.prototype, "capture", async () => ({ credentials: { records: [] } }));
  const result = await providerDiagnostics({ config: { get: async () => ({ config: { providers: { claude: { env: { PRIVATE: "synthetic-private-value" } } } } }) } } as never);
  assert.deepEqual(result.directAuthenticatedProviders, ["claude"]);
  assert.deepEqual(result.environmentAuthenticatedProviders, []);
  assert.equal(result.providers[0].store, "windows-credman");
  assert.equal(JSON.stringify(result).includes("synthetic-private-value"), false);
  assert.equal(JSON.stringify(result).includes("accessToken"), false);
});
