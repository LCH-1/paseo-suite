import { homedir } from "node:os";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { ProviderCredentialSync } from "./provider-credentials";
import { Environment, paseoHome } from "./environment";
import { digest } from "./files";

export async function providerDiagnostics(paseo: PluginHandlerContext["paseo"]) {
  const home = paseoHome();
  const { config } = await paseo.config.get();
  const captured = await new ProviderCredentialSync({ home }).capture(config.providers);
  const snapshot = await new Environment().capture(paseo, { hosts: [], preferences: {} }, { hosts: false, preferences: false, providers: true, config: false, plugins: false });
  return {
    platform: process.platform,
    defaultHome: home === path.join(homedir(), ".paseo"),
    userHomeDigest: digest(homedir()),
    directAuthenticatedProviders: captured.credentials.records.flatMap((record) => record.providerIds).sort(),
    environmentAuthenticatedProviders: (snapshot.credentials?.records ?? []).flatMap((record) => record.providerIds).sort(),
    providers: captured.status.map(({ vendor, providerIds, status, store }) => ({ vendor, providerIds, status, store })),
  };
}
